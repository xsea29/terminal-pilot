import { ConfigScope, ShellId, TerminalDraft } from './TerminalConfig';

/** Field-level validation errors, keyed by form field. */
export type FieldErrors = Partial<Record<'name' | 'cwd' | 'commands' | 'shell' | 'scope', string>>;

/** A terminal as rendered by the webview. */
export interface TerminalView {
  id: string;
  name: string;
  cwd: string;
  commands: string[];
  shell: ShellId;
  scope: ConfigScope;
  running: boolean;
}

export interface ViewState {
  terminals: TerminalView[];
  shells: Array<{ id: ShellId; label: string }>;
  workspace: {
    /** A folder/workspace is open and trusted, so workspace scope can be used. */
    available: boolean;
    trusted: boolean;
    hasFolder: boolean;
  };
}

export type ToastKind = 'success' | 'info' | 'error';

/** Messages sent from the webview to the extension host. Everything is validated before use. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'save'; requestId: number; draft: TerminalDraft; editingId?: string }
  | { type: 'validate'; requestId: number; draft: TerminalDraft; editingId?: string }
  | { type: 'browse'; current: string; scope: ConfigScope }
  | { type: 'run'; id: string }
  | { type: 'stop'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'runMany'; ids: string[] }
  | { type: 'stopMany'; ids: string[] }
  | { type: 'undoDelete' };

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | { type: 'state'; state: ViewState }
  | { type: 'toast'; kind: ToastKind; text: string; undo?: boolean }
  | { type: 'folderSelected'; path: string }
  | { type: 'validation'; requestId: number; errors: FieldErrors }
  | { type: 'saveResult'; requestId: number; ok: boolean; errors?: FieldErrors; message?: string }
  | { type: 'showForm' };
