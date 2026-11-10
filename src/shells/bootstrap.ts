import { ShellKind, ShellSpec } from './types';
import { executableName } from './pathLookup';

/** PowerShell treats typographic quotes like ASCII quotes, so double all of them. */
export function powershellQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function classifyShell(shellPath: string): { kind: ShellKind; name: string } {
  const name = executableName(shellPath);
  if (name === 'pwsh' || name === 'powershell' || name === 'pwsh-preview') {
    return { kind: 'powershell', name };
  }
  if (name === 'cmd') {
    return { kind: 'cmd', name };
  }
  if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'ash'].includes(name)) {
    return { kind: 'posix', name };
  }
  return { kind: 'unknown', name };
}

/**
 * Builds the argument list for a *terminal profile* (which, unlike `createTerminal`, cannot
 * specify a working directory or startup commands): the shell starts, changes directory,
 * runs the commands and then stays interactive.
 *
 * Returns `undefined` when the shell is not understood well enough to do that safely.
 */
export function buildProfileArgs(
  shell: ShellSpec,
  cwd: string | undefined,
  commands: readonly string[],
  platform: NodeJS.Platform
): string[] | undefined {
  if (!cwd && commands.length === 0) {
    return [...shell.args];
  }

  switch (shell.kind) {
    case 'powershell': {
      const steps: string[] = [];
      if (cwd) {
        steps.push(`Set-Location -LiteralPath ${powershellQuote(cwd)}`);
      }
      steps.push(...commands);
      return [...shell.args, '-NoExit', '-Command', steps.join('; ')];
    }

    case 'cmd': {
      const steps: string[] = [];
      if (cwd) {
        steps.push(`cd /d ${cmdQuote(cwd)}`);
      }
      steps.push(...commands);
      return [...shell.args, '/K', steps.join(' & ')];
    }

    case 'posix': {
      // Git Bash on Windows understands "D:/dir" but not "D:\dir" inside quotes.
      const dir = cwd && platform === 'win32' ? cwd.replace(/\\/g, '/') : cwd;
      const steps: string[] = [];
      if (dir) {
        steps.push(`cd ${posixQuote(dir)} || exit 1`);
      }
      steps.push(...commands);
      // Replace the -c shell with an interactive one so the terminal stays open.
      const interactiveFlags = shell.args.includes('-i') ? shell.args : [...shell.args, '-i'];
      steps.push(`exec ${posixQuote(shell.path)} ${interactiveFlags.join(' ')}`);
      return [...shell.args, '-c', steps.join('; ')];
    }

    default:
      return undefined;
  }
}
