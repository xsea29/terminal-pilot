import * as vscode from 'vscode';
import { ConfigScope, LEGACY, ManagedTerminal, PROFILE_PREFIX, TERMINAL_ID_ENV } from '../models/TerminalConfig';
import { buildProfileArgs } from '../shells/bootstrap';
import { resolveProfileShell } from '../shells/registry';
import { createShellContext, profilePlatformKey } from '../shells/vscodeContext';
import { AsyncQueue } from '../utils/asyncQueue';
import { Logger } from '../utils/logger';
import { defaultPathContext, isWorkspaceDependent, resolveWorkingDirectory } from '../utils/paths';
import { ConfigurationService } from './ConfigurationService';

type ProfileMap = Record<string, unknown>;

const TARGETS: Record<ConfigScope, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
};

/**
 * Mirrors managed terminals into `terminal.integrated.profiles.<os>` so they also show up in the
 * terminal dropdown. Only keys starting with `PROFILE_PREFIX` belong to this extension; every other
 * profile (and every other setting) is preserved.
 *
 * A profile cannot carry a working directory or startup commands, so the directory change and the
 * commands are baked into the shell's arguments (see `buildProfileArgs`). Launching from the
 * Terminal Pilot panel does not use profiles at all.
 */
export class ProfileService implements vscode.Disposable {
  private readonly queue = new AsyncQueue();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.disposables.push(
      this.config.onDidChange(() => void this.sync()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('terminalPilot.syncTerminalProfiles')) {
          void this.sync();
        }
      })
    );
    void this.sync();
  }

  /** Brings the profile entries in line with the configured terminals. Never throws. */
  sync(): Promise<void> {
    return this.queue.run(async () => {
      try {
        await this.doSync();
      } catch (error) {
        this.logger.error('Failed to sync terminal profiles', error);
      }
    });
  }

  private async doSync(): Promise<void> {
    const platformKey = profilePlatformKey();
    if (!platformKey) {
      return;
    }
    const enabled = vscode.workspace.getConfiguration('terminalPilot').get<boolean>('syncTerminalProfiles', true);
    const terminals = enabled ? this.config.list() : [];

    for (const scope of ['global', 'workspace'] as const) {
      if (scope === 'workspace' && !this.config.canUseWorkspaceScope) {
        continue;
      }
      const desired = await this.buildProfiles(terminals.filter((t) => t.scope === scope));
      await this.writeProfiles(platformKey, scope, desired);
    }
  }

  private async buildProfiles(terminals: ManagedTerminal[]): Promise<ProfileMap> {
    const ctx = createShellContext();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const pathContext = defaultPathContext(folder);
    const profiles: ProfileMap = {};

    for (const terminal of terminals) {
      // A global terminal whose directory depends on the open workspace has no meaningful fixed profile.
      if (terminal.scope === 'global' && terminal.cwd !== '' && isWorkspaceDependent(terminal.cwd, pathContext)) {
        continue;
      }
      const shell = await resolveProfileShell(terminal.shell, ctx);
      if (!shell) {
        continue;
      }
      let cwd: string | undefined;
      if (terminal.cwd !== '') {
        const resolved = resolveWorkingDirectory(terminal.cwd, pathContext);
        if (!resolved.ok || !resolved.path) {
          continue;
        }
        cwd = resolved.path;
      }
      const args = buildProfileArgs(shell, cwd, terminal.commands, process.platform);
      if (!args) {
        continue; // unknown shell flavour: better no profile than a wrong one
      }
      profiles[`${PROFILE_PREFIX}${terminal.name}`] = {
        path: shell.path,
        args,
        icon: 'terminal',
        // Without this VS Code titles the tab after the running process, so every profile would show the
        // same shell name ("powershell", "bash", ...) instead of its own.
        overrideName: true,
        env: { [TERMINAL_ID_ENV]: terminal.id },
      };
    }
    return profiles;
  }

  private async writeProfiles(platformKey: string, scope: ConfigScope, desired: ProfileMap): Promise<void> {
    const settings = vscode.workspace.getConfiguration('terminal.integrated.profiles');
    const inspected = settings.inspect<ProfileMap>(platformKey);
    const current = (scope === 'global' ? inspected?.globalValue : inspected?.workspaceValue) ?? undefined;

    // Keep everything that is not ours.
    const next: ProfileMap = {};
    for (const [key, value] of Object.entries(current ?? {})) {
      // Entries from the pre-rename version ("TM: ...") are ours too: drop them so they don't linger.
      if (!key.startsWith(PROFILE_PREFIX) && !key.startsWith(LEGACY.profilePrefix)) {
        next[key] = value;
      }
    }
    Object.assign(next, desired);

    const before = JSON.stringify(current ?? {});
    const after = JSON.stringify(next);
    if (before === after) {
      return;
    }
    await settings.update(platformKey, Object.keys(next).length > 0 ? next : undefined, TARGETS[scope]);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
