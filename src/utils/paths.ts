import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

export interface PathContext {
  /** First workspace folder, if any. */
  workspaceFolder?: string;
  home: string;
  /** Overridable for tests. */
  platform?: NodeJS.Platform;
}

export function defaultPathContext(workspaceFolder: string | undefined): PathContext {
  return { workspaceFolder, home: os.homedir() };
}

function pathApi(ctx: PathContext): typeof nodePath.posix {
  return (ctx.platform ?? process.platform) === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** True when the meaning of the path depends on which workspace is open (relative, empty or `${workspaceFolder}`). */
export function isWorkspaceDependent(input: string, ctx: PathContext = { home: '' }): boolean {
  const trimmed = input.trim();
  if (trimmed === '') {
    return true;
  }
  if (trimmed.includes('${workspaceFolder}')) {
    return true;
  }
  if (isHomeRelative(trimmed)) {
    return false;
  }
  return !pathApi(ctx).isAbsolute(trimmed);
}

function isHomeRelative(input: string): boolean {
  return input === '~' || input.startsWith('~/') || input.startsWith('~\\');
}

export type ResolveResult = { ok: true; path: string | undefined } | { ok: false; error: string };

/**
 * Turns the user-entered working directory into an absolute path.
 * - empty            -> the workspace folder (or `undefined`: let VS Code pick its default)
 * - `${workspaceFolder}` and `~` are expanded
 * - relative paths   -> resolved against the workspace folder
 */
export function resolveWorkingDirectory(input: string, ctx: PathContext): ResolveResult {
  const api = pathApi(ctx);
  let value = input.trim();

  if (value === '') {
    return { ok: true, path: ctx.workspaceFolder };
  }

  if (value.includes('${workspaceFolder}')) {
    if (!ctx.workspaceFolder) {
      return { ok: false, error: '"${workspaceFolder}" can only be used when a folder is open.' };
    }
    value = value.split('${workspaceFolder}').join(ctx.workspaceFolder);
  }

  if (isHomeRelative(value)) {
    value = api.join(ctx.home, value.slice(1));
  }

  if (api.isAbsolute(value)) {
    return { ok: true, path: api.normalize(value) };
  }

  if (!ctx.workspaceFolder) {
    return {
      ok: false,
      error: 'This is a relative path, but no folder is open. Enter an absolute path or open a folder.',
    };
  }
  return { ok: true, path: api.resolve(ctx.workspaceFolder, value) };
}

/** Returns an error message when `absolutePath` is not an existing directory. */
export async function checkDirectoryExists(absolutePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(absolutePath);
    return stat.isDirectory() ? undefined : `"${absolutePath}" is not a directory.`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return `The directory "${absolutePath}" does not exist.`;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return `No permission to access "${absolutePath}".`;
    }
    return `Cannot access "${absolutePath}".`;
  }
}

/** Resolves and checks a user-entered working directory. Resolves to an error message, or `undefined` if valid. */
export async function validateWorkingDirectory(input: string, ctx: PathContext): Promise<string | undefined> {
  const resolved = resolveWorkingDirectory(input, ctx);
  if (!resolved.ok) {
    return resolved.error;
  }
  if (resolved.path === undefined) {
    return undefined; // nothing to check: VS Code's default directory is used
  }
  return checkDirectoryExists(resolved.path);
}

/**
 * Converts an absolute path picked in the folder dialog into the most portable form:
 * workspace-relative with forward slashes when it lies inside the workspace folder.
 */
export function toPortablePath(absolutePath: string, ctx: PathContext): string {
  const api = pathApi(ctx);
  if (ctx.workspaceFolder) {
    const relative = api.relative(ctx.workspaceFolder, absolutePath);
    if (!relative.startsWith('..') && !api.isAbsolute(relative)) {
      return relative === '' ? '.' : relative.split(api.sep).join('/');
    }
  }
  return absolutePath;
}
