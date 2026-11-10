import * as vscode from 'vscode';
import { LEGACY, ManagedTerminal, TERMINAL_ID_ENV } from '../models/TerminalConfig';
import { ShellNotFoundError } from '../shells/types';
import { resolveLaunchShell } from '../shells/registry';
import { createShellContext } from '../shells/vscodeContext';
import { UserError } from '../utils/errors';
import { Logger } from '../utils/logger';
import { PathContext, checkDirectoryExists, resolveWorkingDirectory } from '../utils/paths';

export type LaunchStatus = 'created' | 'focused';

export interface LaunchOptions {
  /** Bring the terminal (and the terminal panel) to the front. Disable when launching many at once. */
  reveal: boolean;
  pathContext: PathContext;
}

/**
 * Runtime side of the extension: creates, tracks, focuses and stops terminals.
 * It knows nothing about configuration storage or the UI.
 */
export class TerminalService implements vscode.Disposable {
  /** configuration id -> live terminal */
  private readonly live = new Map<string, vscode.Terminal>();
  /** ids currently being launched (guards against double clicks while we await the file system) */
  private readonly launching = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeRunning = new vscode.EventEmitter<void>();
  readonly onDidChangeRunning = this._onDidChangeRunning.event;

  constructor(private readonly logger: Logger) {
    this.disposables.push(
      this._onDidChangeRunning,
      vscode.window.onDidOpenTerminal((t) => this.adopt(t)),
      vscode.window.onDidCloseTerminal((t) => this.forget(t))
    );
    // Terminals that survived a window reload (VS Code revives them) are re-attached by their marker.
    vscode.window.terminals.forEach((t) => this.adopt(t));
  }

  // ----- tracking ------------------------------------------------------------------------------

  private static markerOf(terminal: vscode.Terminal): string | undefined {
    const options = terminal.creationOptions as { env?: Record<string, string | null | undefined> };
    // Also accept the marker set by the pre-rename version, so its still-open terminals are recognised.
    const value = options.env?.[TERMINAL_ID_ENV] ?? options.env?.[LEGACY.terminalIdEnv];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private adopt(terminal: vscode.Terminal): void {
    const id = TerminalService.markerOf(terminal);
    if (id && terminal.exitStatus === undefined && this.live.get(id) !== terminal) {
      this.live.set(id, terminal);
      this.logger.info(`Attached to existing terminal "${terminal.name}" (${id}).`);
      this._onDidChangeRunning.fire();
    }
  }

  private forget(terminal: vscode.Terminal): void {
    for (const [id, tracked] of this.live) {
      if (tracked === terminal) {
        this.live.delete(id);
        this._onDidChangeRunning.fire();
      }
    }
  }

  isRunning(id: string): boolean {
    const terminal = this.live.get(id);
    return terminal !== undefined && terminal.exitStatus === undefined;
  }

  runningIds(): Set<string> {
    return new Set([...this.live.keys()].filter((id) => this.isRunning(id)));
  }

  // ----- actions -------------------------------------------------------------------------------

  /**
   * Starts the terminal, or focuses the existing instance if it is already running.
   * Throws `UserError` for problems the user can fix (missing directory, shell not installed).
   */
  async launch(config: ManagedTerminal, options: LaunchOptions): Promise<LaunchStatus> {
    const existing = this.live.get(config.id);
    if (existing && existing.exitStatus === undefined) {
      if (options.reveal) {
        existing.show(false);
      }
      return 'focused';
    }
    if (this.launching.has(config.id)) {
      return 'focused';
    }

    this.launching.add(config.id);
    try {
      const cwd = await this.resolveCwd(config, options.pathContext);
      const shell = await this.resolveShell(config);

      const terminal = vscode.window.createTerminal({
        name: config.name,
        cwd,
        shellPath: shell.shellPath,
        shellArgs: shell.shellArgs,
        env: { [TERMINAL_ID_ENV]: config.id },
        iconPath: new vscode.ThemeIcon('terminal'),
      });
      this.live.set(config.id, terminal);
      this._onDidChangeRunning.fire();

      if (options.reveal) {
        terminal.show(false);
      }
      // VS Code buffers input until the shell is ready, so commands can be sent immediately.
      for (const command of config.commands) {
        terminal.sendText(command, true);
      }
      this.logger.info(`Launched "${config.name}" in ${cwd ?? '(default directory)'}.`);
      return 'created';
    } finally {
      this.launching.delete(config.id);
    }
  }

  private async resolveCwd(config: ManagedTerminal, ctx: PathContext): Promise<string | undefined> {
    const resolved = resolveWorkingDirectory(config.cwd, ctx);
    if (!resolved.ok) {
      throw new UserError(`${config.name}: ${resolved.error}`);
    }
    if (resolved.path !== undefined) {
      const problem = await checkDirectoryExists(resolved.path);
      if (problem) {
        throw new UserError(`${config.name}: ${problem}`);
      }
    }
    return resolved.path;
  }

  private async resolveShell(config: ManagedTerminal) {
    try {
      return await resolveLaunchShell(config.shell, createShellContext());
    } catch (error) {
      if (error instanceof ShellNotFoundError) {
        throw new UserError(`${config.name}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Terminates the terminal's process and closes it. Returns false if it was not running. */
  stop(id: string): boolean {
    const terminal = this.live.get(id);
    if (!terminal) {
      return false;
    }
    this.live.delete(id);
    terminal.dispose();
    this._onDidChangeRunning.fire();
    return true;
  }

  dispose(): void {
    // Terminals intentionally stay open when the extension deactivates.
    this.disposables.forEach((d) => d.dispose());
  }
}
