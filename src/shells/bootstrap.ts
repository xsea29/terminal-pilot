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
 * A terminal profile cannot set a working directory, so VS Code starts the shell in the workspace root and
 * the profile then changes directory inside the shell. VS Code labels the tab with the folder of the
 * directory it believes the terminal is in, so without help every tab would show the workspace folder next
 * to its own name. These snippets print the "current directory" escape sequence that VS Code understands
 * (OSC 633;P;Cwd=<path>, with `\` and `;` escaped) right after the directory change, so the tab shows the
 * folder the terminal is really in.
 */
const REPORT_CWD_POWERSHELL = String.raw`[Console]::Write([string][char]27 + ']633;P;Cwd=' + (Get-Location).Path.Replace('\','\\').Replace(';','\x3b') + [string][char]7)`;

/** Git Bash: converts the POSIX-style $PWD back to a Windows path, which is what VS Code expects. */
const REPORT_CWD_GIT_BASH = String.raw`command -v cygpath >/dev/null 2>&1 && printf '\033]633;P;Cwd=%s\007' "$(cygpath -w "$PWD" | sed 's/\\/\\\\/g')"`;

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
        steps.push(`Set-Location -LiteralPath ${powershellQuote(cwd)}`, REPORT_CWD_POWERSHELL);
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
        // On Linux/macOS VS Code reads the shell's directory from the OS, so only Windows needs the report.
        if (platform === 'win32') {
          steps.push(REPORT_CWD_GIT_BASH);
        }
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
