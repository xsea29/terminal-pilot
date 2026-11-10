import * as vscode from 'vscode';
import { ShellContext } from './types';

const PLATFORM_KEYS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'windows',
  darwin: 'osx',
  linux: 'linux',
};

/** The `terminal.integrated.profiles.<key>` suffix for the current OS, or `undefined` if unsupported. */
export function profilePlatformKey(platform: NodeJS.Platform = process.platform): string | undefined {
  return PLATFORM_KEYS[platform];
}

/** Builds the environment description adapters need from the live VS Code instance. */
export function createShellContext(): ShellContext {
  const platform = process.platform;
  return {
    platform,
    env: process.env,
    defaultShellPath: vscode.env.shell || undefined,
    configuredProfilePaths: (profileName) => {
      const key = profilePlatformKey(platform);
      if (!key) {
        return [];
      }
      const profiles = vscode.workspace
        .getConfiguration('terminal.integrated.profiles')
        .get<Record<string, { path?: string | string[] } | null>>(key);
      const path = profiles?.[profileName]?.path;
      if (typeof path === 'string') {
        return [path];
      }
      return Array.isArray(path) ? path.filter((p): p is string => typeof p === 'string') : [];
    },
  };
}
