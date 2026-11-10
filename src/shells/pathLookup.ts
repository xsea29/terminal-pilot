import * as fs from 'fs';
import * as nodePath from 'path';

function getEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) {
    return env[key];
  }
  const match = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase());
  return match === undefined ? undefined : env[match];
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Locates an executable on PATH without spawning anything.
 * Tries the names in order; on Windows every PATHEXT extension is tried as well.
 */
export async function findOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const win = platform === 'win32';
  const api = win ? nodePath.win32 : nodePath.posix;
  const dirs = (getEnv(env, 'PATH') ?? '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0);
  const extensions = win
    ? (getEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
    : [''];

  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = api.join(dir, name + ext);
        if (await isFile(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/** Returns the first existing file among the candidates. */
export async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Expands `${env:NAME}` placeholders as used in VS Code terminal profile paths. */
export function expandEnvPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => getEnv(env, name) ?? '');
}

export function executableName(shellPath: string): string {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}
