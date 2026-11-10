/**
 * Domain model shared by the extension host and the webview protocol.
 * This file must stay free of `vscode` imports so it can be used from pure unit tests.
 */

/** Shells the user can pick. To support a new shell, add its id here and register an adapter in `shells/registry.ts`. */
export const SHELL_IDS = ['default', 'powershell', 'bash', 'zsh'] as const;
export type ShellId = (typeof SHELL_IDS)[number];

export const SCOPES = ['global', 'workspace'] as const;
export type ConfigScope = (typeof SCOPES)[number];

/** Shape persisted in `terminalPilot.terminals`. */
export interface TerminalConfig {
  /** Stable identifier; survives renames and is used to track running terminals. */
  id: string;
  name: string;
  /** Absolute, relative to the workspace folder, or empty (= workspace root). */
  cwd: string;
  /** Executed in order after the terminal has been created. */
  commands: string[];
  shell: ShellId;
}

/** A configuration together with the scope it is stored in. */
export interface ManagedTerminal extends TerminalConfig {
  scope: ConfigScope;
}

/** What the form submits; the id is assigned by the extension. */
export interface TerminalDraft {
  name: string;
  cwd: string;
  commands: string[];
  shell: ShellId;
  scope: ConfigScope;
}

export const LIMITS = {
  nameMax: 64,
  cwdMax: 1024,
  commandMax: 2000,
  commandsMax: 50,
  idMax: 128,
} as const;

/** Prefix of every entry this extension writes into `terminal.integrated.profiles.*`. */
export const PROFILE_PREFIX = 'TP: ';

/** Environment variable used to recognise terminals created by this extension (also after a window reload). */
export const TERMINAL_ID_ENV = 'TERMINAL_PILOT_ID';

/**
 * Identifiers from before the extension was renamed (it was called "Terminal Manager").
 * They are only read, never written, so people who used the old version keep their data.
 */
export const LEGACY = {
  settingsSection: 'terminalManager',
  profilePrefix: 'TM: ',
  terminalIdEnv: 'TERMINAL_MANAGER_ID',
} as const;
