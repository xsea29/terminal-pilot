import * as vscode from 'vscode';
import { FieldErrors, ViewState } from '../models/messages';
import { ManagedTerminal, TerminalDraft } from '../models/TerminalConfig';
import { ConfigurationService } from '../services/ConfigurationService';
import { TerminalService } from '../services/TerminalService';
import { listShells } from '../shells/registry';
import { UserError, errorMessage } from '../utils/errors';
import { Logger } from '../utils/logger';
import { PathContext, defaultPathContext, validateWorkingDirectory } from '../utils/paths';
import { hasErrors, validateDraft } from '../utils/validation';

/** Result of a user-level operation; the UI layer decides how to present `message`. */
export type Outcome =
  | { ok: true; message: string; undoable?: boolean }
  | { ok: false; message: string; errors?: FieldErrors };

const ok = (message: string, undoable = false): Outcome => ({ ok: true, message, undoable });
const fail = (message: string, errors?: FieldErrors): Outcome => ({ ok: false, message, errors });

/**
 * Application layer: orchestrates configuration + terminal services into the use-cases the user
 * can trigger. It is UI-agnostic, so the webview and the command palette share exactly the same logic.
 */
export class TerminalPilotController implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when anything that affects the rendered state changes. */
  readonly onDidChange = this._onDidChange.event;

  private lastDeleted: ManagedTerminal | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly config: ConfigurationService,
    private readonly terminals: TerminalService,
    private readonly logger: Logger
  ) {
    this.disposables.push(
      this._onDidChange,
      config.onDidChange(() => this._onDidChange.fire()),
      terminals.onDidChangeRunning(() => this._onDidChange.fire())
    );
  }

  // ----- state ---------------------------------------------------------------------------------

  pathContext(): PathContext {
    return defaultPathContext(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  }

  snapshot(): ViewState {
    const running = this.terminals.runningIds();
    return {
      terminals: this.config.list().map((t) => ({
        id: t.id,
        name: t.name,
        cwd: t.cwd,
        commands: t.commands,
        shell: t.shell,
        scope: t.scope,
        running: running.has(t.id),
      })),
      shells: listShells(),
      workspace: {
        available: this.config.canUseWorkspaceScope,
        trusted: this.config.isTrusted,
        hasFolder: this.config.hasWorkspace,
      },
    };
  }

  list(): ManagedTerminal[] {
    return this.config.list();
  }

  isRunning(id: string): boolean {
    return this.terminals.isRunning(id);
  }

  // ----- create / edit -------------------------------------------------------------------------

  /** Full validation including the file-system check of the working directory. */
  async validate(draft: TerminalDraft, editingId?: string): Promise<FieldErrors> {
    const errors = validateDraft(draft, this.config.list(), editingId);
    if (draft.scope === 'workspace' && !this.config.canUseWorkspaceScope) {
      errors.scope = this.config.hasWorkspace
        ? 'Trust this workspace to store terminals in it.'
        : 'Open a folder or workspace to use the workspace scope.';
    }
    if (!errors.cwd) {
      const problem = await validateWorkingDirectory(draft.cwd, this.pathContext());
      if (problem) {
        errors.cwd = problem;
      }
    }
    return errors;
  }

  async save(draft: TerminalDraft, editingId?: string): Promise<Outcome> {
    const errors = await this.validate(draft, editingId);
    if (hasErrors(errors)) {
      return fail('Please fix the highlighted fields.', errors);
    }
    try {
      if (editingId) {
        const saved = await this.config.update(editingId, draft);
        const note = this.terminals.isRunning(editingId) ? ' Changes apply the next time it is launched.' : '';
        return ok(`Saved "${saved.name}".${note}`);
      }
      const created = await this.config.add(draft);
      return ok(`Added "${created.name}".`);
    } catch (error) {
      return this.failure(error, 'save');
    }
  }

  // ----- delete / undo / duplicate -------------------------------------------------------------

  async remove(id: string): Promise<Outcome> {
    try {
      const removed = await this.config.remove(id);
      this.lastDeleted = removed;
      const note = this.terminals.isRunning(id) ? ' Its running terminal was left open.' : '';
      return ok(`Deleted "${removed.name}".${note}`, true);
    } catch (error) {
      return this.failure(error, 'delete');
    }
  }

  async undoDelete(): Promise<Outcome> {
    const terminal = this.lastDeleted;
    if (!terminal) {
      return fail('Nothing to undo.');
    }
    try {
      await this.config.restore(terminal);
      this.lastDeleted = undefined;
      return ok(`Restored "${terminal.name}".`);
    } catch (error) {
      return this.failure(error, 'restore');
    }
  }

  async duplicate(id: string): Promise<Outcome> {
    try {
      const copy = await this.config.duplicate(id);
      return ok(`Created "${copy.name}".`);
    } catch (error) {
      return this.failure(error, 'duplicate');
    }
  }

  // ----- run / stop ----------------------------------------------------------------------------

  /** Launches the terminal, or focuses it when it is already running. */
  async run(id: string, reveal = true): Promise<Outcome> {
    const terminal = this.config.get(id);
    if (!terminal) {
      return fail('This terminal no longer exists.');
    }
    try {
      const status = await this.terminals.launch(terminal, { reveal, pathContext: this.pathContext() });
      return ok(status === 'created' ? `Started "${terminal.name}".` : `"${terminal.name}" is already running.`);
    } catch (error) {
      return this.failure(error, 'launch');
    }
  }

  /** Launches several terminals; an empty `ids` list means "all". */
  async runMany(ids: readonly string[]): Promise<Outcome> {
    const targets = (ids.length > 0 ? ids.map((id) => this.config.get(id)) : this.config.list()).filter(
      (t): t is ManagedTerminal => t !== undefined
    );
    if (targets.length === 0) {
      return fail('There are no terminals to run. Add one first.');
    }
    if (targets.length === 1) {
      return this.run(targets[0].id);
    }

    let started = 0;
    let alreadyRunning = 0;
    const failures: string[] = [];
    for (const terminal of targets) {
      try {
        const status = await this.terminals.launch(terminal, { reveal: false, pathContext: this.pathContext() });
        status === 'created' ? started++ : alreadyRunning++;
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }

    const parts: string[] = [];
    if (started > 0) {
      parts.push(`started ${started}`);
    }
    if (alreadyRunning > 0) {
      parts.push(`${alreadyRunning} already running`);
    }
    if (failures.length > 0) {
      parts.push(`${failures.length} failed`);
    }
    const summary = capitalize(parts.join(', ')) + '.';
    return failures.length > 0 ? fail(`${summary} ${failures.join(' ')}`) : ok(summary);
  }

  stop(id: string): Outcome {
    const terminal = this.config.get(id);
    const stopped = this.terminals.stop(id);
    const name = terminal ? `"${terminal.name}"` : 'The terminal';
    return stopped ? ok(`Stopped ${name}.`) : ok(`${name} is not running.`);
  }

  /** Stops several managed terminals; an empty `ids` list means "all running". */
  stopMany(ids: readonly string[]): Outcome {
    const targets = ids.length > 0 ? [...ids] : [...this.terminals.runningIds()];
    const stopped = targets.filter((id) => this.terminals.stop(id)).length;
    return stopped > 0 ? ok(`Stopped ${stopped} terminal${stopped === 1 ? '' : 's'}.`) : ok('No terminals are running.');
  }

  // ----- helpers -------------------------------------------------------------------------------

  private failure(error: unknown, action: string): Outcome {
    if (error instanceof UserError) {
      return fail(error.message);
    }
    this.logger.error(`Unexpected error while trying to ${action}`, error);
    return fail(`Could not ${action}: ${errorMessage(error)}`);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
