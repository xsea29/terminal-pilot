import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConfigScope, LEGACY, ManagedTerminal, TerminalConfig, TerminalDraft } from '../models/TerminalConfig';
import { AsyncQueue } from '../utils/asyncQueue';
import { UserError, errorMessage } from '../utils/errors';
import { Logger } from '../utils/logger';
import { findDuplicateName, normalizeCommands, normalizeName, sanitizeStoredConfigs } from '../utils/validation';

const SECTION = 'terminalPilot';
const KEY = 'terminals';

const TARGETS: Record<ConfigScope, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
};

/**
 * Persists terminal definitions through the VS Code Configuration API.
 *
 * - Only the `terminalPilot.terminals` key is ever written; every other setting is left alone.
 * - Global and workspace lists are stored separately and merged for display.
 * - Writes are serialised so concurrent UI actions cannot overwrite each other.
 */
export class ConfigurationService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the set of configured terminals (or the ability to use workspace scope) may have changed. */
  readonly onDidChange = this._onDidChange.event;

  private readonly queue = new AsyncQueue();
  private readonly disposables: vscode.Disposable[] = [];
  private warnedAboutDropped = false;

  constructor(private readonly logger: Logger) {
    this.disposables.push(
      this._onDidChange,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.${KEY}`)) {
          this._onDidChange.fire();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._onDidChange.fire()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this._onDidChange.fire())
    );
  }

  // ----- environment ---------------------------------------------------------------------------

  get hasWorkspace(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 0 || vscode.workspace.workspaceFile !== undefined;
  }

  get isTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  /** Workspace scope needs an open workspace, and trust (it can contain commands from the repository). */
  get canUseWorkspaceScope(): boolean {
    return this.hasWorkspace && this.isTrusted;
  }

  // ----- migration -----------------------------------------------------------------------------

  /**
   * One-time carry-over of terminals saved by the pre-rename version ("Terminal Manager") under
   * `terminalManager.terminals`. Each scope is copied only if the new setting is still empty there,
   * so this never overwrites anything and is a no-op on every later start. The old setting is left
   * untouched (it is no longer a registered setting, so it can only be removed by hand).
   */
  migrateLegacySettings(): Promise<void> {
    return this.queue.run(async () => {
      try {
        const legacy = vscode.workspace.getConfiguration(LEGACY.settingsSection).inspect<unknown>(KEY);
        for (const scope of ['global', 'workspace'] as const) {
          if (scope === 'workspace' && !this.canUseWorkspaceScope) {
            continue;
          }
          const raw = scope === 'global' ? legacy?.globalValue : legacy?.workspaceValue;
          const { items } = sanitizeStoredConfigs(raw);
          if (items.length === 0 || this.read(scope).length > 0) {
            continue;
          }
          await this.write(scope, items);
          this.logger.info(`Migrated ${items.length} terminal(s) from the old "${LEGACY.settingsSection}" ${scope} settings.`);
        }
      } catch (error) {
        this.logger.error('Could not migrate settings from the previous version', error);
      }
    });
  }

  // ----- reading -------------------------------------------------------------------------------

  /** All terminals: global first, then workspace (when usable), each in stored order. */
  list(): ManagedTerminal[] {
    const result = [...this.read('global')];
    if (this.canUseWorkspaceScope) {
      result.push(...this.read('workspace'));
    }
    return result;
  }

  get(id: string): ManagedTerminal | undefined {
    return this.list().find((t) => t.id === id);
  }

  private read(scope: ConfigScope): ManagedTerminal[] {
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>(KEY);
    const raw = scope === 'global' ? inspected?.globalValue : inspected?.workspaceValue;
    const { items, dropped } = sanitizeStoredConfigs(raw);
    if (dropped > 0 && !this.warnedAboutDropped) {
      this.warnedAboutDropped = true;
      this.logger.warn(`Ignored ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} in ${scope} "${SECTION}.${KEY}".`);
    }
    return items.map((item) => ({ ...item, scope }));
  }

  // ----- writing -------------------------------------------------------------------------------

  private async write(scope: ConfigScope, items: TerminalConfig[]): Promise<void> {
    if (scope === 'workspace' && !this.canUseWorkspaceScope) {
      throw new UserError(
        this.hasWorkspace
          ? 'Workspace configuration is disabled until you trust this workspace.'
          : 'Open a folder or workspace to use the workspace scope.'
      );
    }
    try {
      await vscode.workspace
        .getConfiguration(SECTION)
        .update(KEY, items.length > 0 ? items : undefined, TARGETS[scope]);
    } catch (error) {
      this.logger.error(`Failed to write ${scope} settings`, error);
      throw new UserError(`Could not save to ${scope} settings: ${errorMessage(error)}`);
    }
  }

  private assertUniqueName(name: string, editingId?: string): void {
    const duplicate = findDuplicateName(name, this.list(), editingId);
    if (duplicate) {
      throw new UserError(duplicate);
    }
  }

  private static toConfig(id: string, draft: TerminalDraft): TerminalConfig {
    return {
      id,
      name: normalizeName(draft.name),
      cwd: draft.cwd.trim(),
      commands: normalizeCommands(draft.commands),
      shell: draft.shell,
    };
  }

  private static strip(items: ManagedTerminal[]): TerminalConfig[] {
    return items.map(({ id, name, cwd, commands, shell }) => ({ id, name, cwd, commands, shell }));
  }

  add(draft: TerminalDraft, id: string = randomUUID()): Promise<ManagedTerminal> {
    return this.queue.run(async () => {
      this.assertUniqueName(draft.name);
      const config = ConfigurationService.toConfig(id, draft);
      const current = ConfigurationService.strip(this.read(draft.scope));
      await this.write(draft.scope, [...current, config]);
      return { ...config, scope: draft.scope };
    });
  }

  update(id: string, draft: TerminalDraft): Promise<ManagedTerminal> {
    return this.queue.run(async () => {
      const existing = this.get(id);
      if (!existing) {
        throw new UserError('This terminal no longer exists.');
      }
      this.assertUniqueName(draft.name, id);
      const config = ConfigurationService.toConfig(id, draft);

      if (existing.scope === draft.scope) {
        const items = ConfigurationService.strip(this.read(existing.scope)).map((t) => (t.id === id ? config : t));
        await this.write(existing.scope, items);
      } else {
        // Moving between scopes: write the destination first so a failure cannot lose the terminal.
        await this.write(draft.scope, [...ConfigurationService.strip(this.read(draft.scope)), config]);
        const remaining = ConfigurationService.strip(this.read(existing.scope)).filter((t) => t.id !== id);
        await this.write(existing.scope, remaining);
      }
      return { ...config, scope: draft.scope };
    });
  }

  remove(id: string): Promise<ManagedTerminal> {
    return this.queue.run(async () => {
      const existing = this.get(id);
      if (!existing) {
        throw new UserError('This terminal no longer exists.');
      }
      const remaining = ConfigurationService.strip(this.read(existing.scope)).filter((t) => t.id !== id);
      await this.write(existing.scope, remaining);
      return existing;
    });
  }

  /** Re-adds a previously removed terminal under its original id and scope (used by Undo). */
  restore(terminal: ManagedTerminal): Promise<ManagedTerminal> {
    return this.add(
      {
        name: terminal.name,
        cwd: terminal.cwd,
        commands: terminal.commands,
        shell: terminal.shell,
        scope: terminal.scope,
      },
      terminal.id
    );
  }

  /** Creates a copy of `id` with a unique name ("Name (copy)", "Name (copy 2)", ...). */
  duplicate(id: string): Promise<ManagedTerminal> {
    return this.queue.run(async () => {
      const source = this.get(id);
      if (!source) {
        throw new UserError('This terminal no longer exists.');
      }
      const taken = this.list();
      let name = `${source.name} (copy)`;
      for (let n = 2; findDuplicateName(name, taken) !== undefined; n++) {
        name = `${source.name} (copy ${n})`;
      }
      const config = ConfigurationService.toConfig(randomUUID(), {
        name,
        cwd: source.cwd,
        commands: source.commands,
        shell: source.shell,
        scope: source.scope,
      });
      await this.write(source.scope, [...ConfigurationService.strip(this.read(source.scope)), config]);
      return { ...config, scope: source.scope };
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
