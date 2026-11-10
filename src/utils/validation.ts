import {
  ConfigScope,
  LIMITS,
  SCOPES,
  SHELL_IDS,
  ShellId,
  TerminalConfig,
  TerminalDraft,
} from '../models/TerminalConfig';
import { FieldErrors, WebviewMessage } from '../models/messages';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LINE_BREAKS = /[\r\n]/;

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function normalizeCommands(commands: readonly string[]): string[] {
  return commands.map((c) => c.trim()).filter((c) => c.length > 0);
}

export function isShellId(value: unknown): value is ShellId {
  return typeof value === 'string' && (SHELL_IDS as readonly string[]).includes(value);
}

export function isScope(value: unknown): value is ConfigScope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

export function sameName(a: string, b: string): boolean {
  return normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();
}

/** Returns a message if `name` is already used by another terminal (case-insensitive). */
export function findDuplicateName(
  name: string,
  existing: ReadonlyArray<{ id: string; name: string }>,
  editingId?: string
): string | undefined {
  const clash = existing.find((t) => t.id !== editingId && sameName(t.name, name));
  return clash ? `A terminal named "${clash.name}" already exists. Choose a different name.` : undefined;
}

/**
 * Pure (synchronous) validation of a draft. File-system checks (does the directory exist?)
 * are done separately because they need I/O.
 */
export function validateDraft(
  draft: TerminalDraft,
  existing: ReadonlyArray<{ id: string; name: string }>,
  editingId?: string
): FieldErrors {
  const errors: FieldErrors = {};
  const name = normalizeName(draft.name);

  if (name.length === 0) {
    errors.name = 'Enter a terminal name.';
  } else if (name.length > LIMITS.nameMax) {
    errors.name = `The name must be at most ${LIMITS.nameMax} characters long.`;
  } else if (CONTROL_CHARS.test(name)) {
    errors.name = 'The name contains invalid characters.';
  } else {
    const duplicate = findDuplicateName(name, existing, editingId);
    if (duplicate) {
      errors.name = duplicate;
    }
  }

  const cwd = draft.cwd.trim();
  if (cwd.length > LIMITS.cwdMax) {
    errors.cwd = `The path must be at most ${LIMITS.cwdMax} characters long.`;
  } else if (CONTROL_CHARS.test(cwd)) {
    errors.cwd = 'The path contains invalid characters.';
  }

  if (draft.commands.length > LIMITS.commandsMax) {
    errors.commands = `At most ${LIMITS.commandsMax} startup commands are allowed.`;
  } else if (draft.commands.some((c) => c.length > LIMITS.commandMax)) {
    errors.commands = `A startup command must be at most ${LIMITS.commandMax} characters long.`;
  } else if (draft.commands.some((c) => LINE_BREAKS.test(c))) {
    errors.commands = 'Use one row per command (a command cannot contain line breaks).';
  }

  if (!isShellId(draft.shell)) {
    errors.shell = 'Choose a supported shell.';
  }
  if (!isScope(draft.scope)) {
    errors.scope = 'Choose where to store the configuration.';
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

// ---------------------------------------------------------------------------
// Untrusted input: webview messages
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.idMax;
}

function parseDraft(raw: unknown): TerminalDraft | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { name, cwd, commands, shell, scope } = raw;
  if (
    typeof name !== 'string' ||
    typeof cwd !== 'string' ||
    !Array.isArray(commands) ||
    !commands.every((c) => typeof c === 'string') ||
    !isShellId(shell) ||
    !isScope(scope)
  ) {
    return undefined;
  }
  // Hard caps so a compromised webview cannot make us process huge payloads.
  if (name.length > 1000 || cwd.length > 10000 || commands.length > 1000) {
    return undefined;
  }
  return {
    name: normalizeName(name),
    cwd: cwd.trim(),
    commands: normalizeCommands(commands as string[]),
    shell,
    scope,
  };
}

function parseIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > 1000 || !raw.every(isId)) {
    return undefined;
  }
  return raw as string[];
}

/**
 * Validates an arbitrary value received through `postMessage`.
 * Returns `undefined` for anything that is not a well-formed message.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return undefined;
  }
  switch (raw.type) {
    case 'ready':
    case 'undoDelete':
      return { type: raw.type };

    case 'save':
    case 'validate': {
      const draft = parseDraft(raw.draft);
      const editingId = raw.editingId;
      if (
        !draft ||
        typeof raw.requestId !== 'number' ||
        !Number.isSafeInteger(raw.requestId) ||
        (editingId !== undefined && !isId(editingId))
      ) {
        return undefined;
      }
      return { type: raw.type, requestId: raw.requestId, draft, editingId };
    }

    case 'browse':
      if (typeof raw.current !== 'string' || raw.current.length > 10000 || !isScope(raw.scope)) {
        return undefined;
      }
      return { type: 'browse', current: raw.current.trim(), scope: raw.scope };

    case 'run':
    case 'stop':
    case 'delete':
    case 'duplicate':
      return isId(raw.id) ? { type: raw.type, id: raw.id } : undefined;

    case 'runMany':
    case 'stopMany': {
      const ids = parseIds(raw.ids);
      return ids ? { type: raw.type, ids } : undefined;
    }

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Untrusted input: values read back from settings.json (users may hand-edit it)
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  items: TerminalConfig[];
  /** Number of entries that were skipped because they were malformed. */
  dropped: number;
}

export function sanitizeStoredConfigs(raw: unknown): SanitizeResult {
  if (!Array.isArray(raw)) {
    return { items: [], dropped: raw === undefined || raw === null ? 0 : 1 };
  }
  const items: TerminalConfig[] = [];
  const seenIds = new Set<string>();
  let dropped = 0;

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || normalizeName(entry.name) === '') {
      dropped++;
      continue;
    }
    const name = normalizeName(entry.name);
    const id = isId(entry.id) ? entry.id : `legacy:${name.toLowerCase()}`;
    if (seenIds.has(id)) {
      dropped++;
      continue;
    }
    seenIds.add(id);

    let commands: string[] = [];
    if (Array.isArray(entry.commands)) {
      commands = normalizeCommands(entry.commands.filter((c): c is string => typeof c === 'string'));
    } else if (typeof entry.command === 'string') {
      commands = normalizeCommands([entry.command]);
    }

    items.push({
      id,
      name,
      cwd: typeof entry.cwd === 'string' ? entry.cwd.trim() : '',
      commands,
      shell: isShellId(entry.shell) ? entry.shell : 'default',
    });
  }
  return { items, dropped };
}
