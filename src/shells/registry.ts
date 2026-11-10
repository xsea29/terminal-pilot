import * as nodePath from 'path';
import { ShellId } from '../models/TerminalConfig';
import { classifyShell } from './bootstrap';
import { expandEnvPlaceholders, findOnPath, firstExisting } from './pathLookup';
import { ShellAdapter, ShellContext, ShellNotFoundError, ShellSpec } from './types';

function specFor(shellPath: string, args: string[]): ShellSpec {
  const { kind, name } = classifyShell(shellPath);
  return { path: shellPath, args, kind, name };
}

/** VS Code starts bash/zsh as login shells on macOS only. */
function loginArgs(ctx: ShellContext): string[] {
  return ctx.platform === 'darwin' ? ['-l'] : [];
}

const defaultAdapter: ShellAdapter = {
  id: 'default',
  label: 'Default',
  notFoundMessage: 'Could not determine the default shell.',
  async locate(ctx) {
    // Only used for terminal-profile generation. Launching passes no shellPath at all, so VS Code
    // applies the user's own default profile (and its arguments).
    return ctx.defaultShellPath ? specFor(ctx.defaultShellPath, []) : undefined;
  },
};

const powershellAdapter: ShellAdapter = {
  id: 'powershell',
  label: 'PowerShell',
  notFoundMessage: 'PowerShell was not found on PATH. Install PowerShell (pwsh) or choose another shell.',
  async locate(ctx) {
    // Prefer modern PowerShell; Windows PowerShell is only available on Windows.
    const names = ctx.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
    const found = await findOnPath(names, ctx.env, ctx.platform);
    return found ? specFor(found, ['-NoLogo']) : undefined;
  },
};

/** Git Bash on Windows: from the user's profile settings, then relative to git.exe, then the standard install dirs. */
async function locateGitBash(ctx: ShellContext): Promise<string | undefined> {
  const win = nodePath.win32;
  const candidates: string[] = [];

  for (const configured of ctx.configuredProfilePaths?.('Git Bash') ?? []) {
    candidates.push(expandEnvPlaceholders(configured, ctx.env));
  }

  const git = await findOnPath(['git'], ctx.env, 'win32');
  if (git) {
    const gitDir = win.dirname(git); // ...\Git\cmd  or  ...\Git\bin
    candidates.push(
      win.join(gitDir, '..', 'bin', 'bash.exe'),
      win.join(gitDir, 'bash.exe'),
      win.join(gitDir, '..', '..', 'bin', 'bash.exe')
    );
  }

  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const base = ctx.env[key];
    if (base) {
      candidates.push(win.join(base, 'Git', 'bin', 'bash.exe'));
    }
  }
  if (ctx.env.LOCALAPPDATA) {
    candidates.push(win.join(ctx.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  }

  const found = await firstExisting(candidates.filter((c) => c.length > 0));
  return found ? win.normalize(found) : undefined;
}

const bashAdapter: ShellAdapter = {
  id: 'bash',
  label: 'Bash',
  notFoundMessage:
    'Bash was not found. On Windows, install Git for Windows (Git Bash); otherwise make sure bash is on PATH.',
  async locate(ctx) {
    if (ctx.platform === 'win32') {
      const gitBash = await locateGitBash(ctx);
      return gitBash ? specFor(gitBash, ['--login', '-i']) : undefined;
    }
    const found = await findOnPath(['bash'], ctx.env, ctx.platform);
    return found ? specFor(found, loginArgs(ctx)) : undefined;
  },
};

const zshAdapter: ShellAdapter = {
  id: 'zsh',
  label: 'Zsh',
  notFoundMessage: 'Zsh was not found on PATH. Install zsh or choose another shell.',
  async locate(ctx) {
    const found = await findOnPath(['zsh'], ctx.env, ctx.platform);
    return found ? specFor(found, loginArgs(ctx)) : undefined;
  },
};

/** Single place that lists the supported shells. Order = order in the form's drop-down. */
const ADAPTERS: ReadonlyArray<ShellAdapter> = [defaultAdapter, powershellAdapter, bashAdapter, zshAdapter];

export function listShells(): Array<{ id: ShellId; label: string }> {
  return ADAPTERS.map(({ id, label }) => ({ id, label }));
}

export function getShellAdapter(id: ShellId): ShellAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) {
    throw new Error(`Unsupported shell: ${id}`);
  }
  return adapter;
}

export interface LaunchShell {
  shellPath?: string;
  shellArgs?: string[];
}

/** Shell options for `vscode.window.createTerminal`. "Default" yields no overrides. */
export async function resolveLaunchShell(id: ShellId, ctx: ShellContext): Promise<LaunchShell> {
  if (id === 'default') {
    return {};
  }
  const adapter = getShellAdapter(id);
  const spec = await adapter.locate(ctx);
  if (!spec) {
    throw new ShellNotFoundError(adapter.notFoundMessage);
  }
  return { shellPath: spec.path, shellArgs: spec.args };
}

/** Shell used to build a terminal profile; `undefined` when unavailable on this machine. */
export async function resolveProfileShell(id: ShellId, ctx: ShellContext): Promise<ShellSpec | undefined> {
  return getShellAdapter(id).locate(ctx);
}
