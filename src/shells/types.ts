import { ShellId } from '../models/TerminalConfig';

/** How a shell is invoked with a startup script; decides quoting rules. */
export type ShellKind = 'powershell' | 'cmd' | 'posix' | 'unknown';

/** Everything adapters need from the environment (injected so adapters stay testable). */
export interface ShellContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** `vscode.env.shell`: the user's default shell. */
  defaultShellPath?: string;
  /** Paths the user configured for a `terminal.integrated.profiles.<platform>` entry, e.g. "Git Bash". */
  configuredProfilePaths?: (profileName: string) => string[];
}

/** A concrete, resolved shell executable. */
export interface ShellSpec {
  path: string;
  /** Arguments that make the shell interactive/login the way VS Code would. */
  args: string[];
  kind: ShellKind;
  /** Lower-case executable name without extension (bash, pwsh, ...). */
  name: string;
}

export interface ShellAdapter {
  readonly id: ShellId;
  readonly label: string;
  /** Finds the shell on this machine; `undefined` when not installed. */
  locate(ctx: ShellContext): Promise<ShellSpec | undefined>;
  /** Shown when `locate` fails. */
  readonly notFoundMessage: string;
}

export class ShellNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellNotFoundError';
  }
}
