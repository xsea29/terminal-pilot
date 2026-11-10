import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TerminalPilotApi } from '../../../extension';
import { PROFILE_PREFIX, TerminalDraft } from '../../../models/TerminalConfig';
import { TerminalService } from '../../../services/TerminalService';
import { classifyShell } from '../../../shells/bootstrap';
import { profilePlatformKey } from '../../../shells/vscodeContext';
import { Logger } from '../../../utils/logger';

export interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

const workspaceDir = process.env.TM_TEST_WORKSPACE as string;
const rootDir = process.env.TM_TEST_ROOT as string;
let api: TerminalPilotApi;
const ids: Record<string, string> = {};

const NODE_WRITE = (file: string, content: string) =>
  `node -e "require('fs').appendFileSync('${file}','${content}')"`;

async function waitFor(condition: () => boolean, what: string, timeoutMs = 40000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const draft = (name: string, cwd: string, commands: string[], extra: Partial<TerminalDraft> = {}): TerminalDraft => ({
  name,
  cwd,
  commands,
  shell: 'default',
  scope: 'workspace',
  ...extra,
});

async function mustSave(d: TerminalDraft): Promise<string> {
  const outcome = await api.controller.save(d);
  assert.ok(outcome.ok, `save "${d.name}" failed: ${outcome.message}`);
  const created = api.controller.list().find((t) => t.name === d.name);
  assert.ok(created, `"${d.name}" not listed after saving`);
  ids[d.name] = created.id;
  return created.id;
}

const workspaceSettings = () =>
  JSON.parse(fs.readFileSync(path.join(workspaceDir, '.vscode', 'settings.json'), 'utf8')) as Record<string, any>;

const terminalsNamed = (name: string) => vscode.window.terminals.filter((t) => t.name === name);

export const tests: TestCase[] = [
  {
    name: 'activates and exposes the Terminal Pilot view',
    async fn() {
      const extension = vscode.extensions.getExtension('terminal-pilot.terminal-pilot');
      assert.ok(extension, 'extension not found');
      api = (await extension.activate()) as TerminalPilotApi;
      assert.ok(api.controller);
      const commands = await vscode.commands.getCommands(true);
      for (const c of ['terminalPilot.add', 'terminalPilot.run', 'terminalPilot.runAll', 'terminalPilot.stopAll']) {
        assert.ok(commands.includes(c), `command ${c} missing`);
      }
    },
  },

  {
    name: 'migrates terminals saved by the previous version (old "terminalManager" setting)',
    async fn() {
      await waitFor(() => api.controller.list().some((t) => t.id === 'legacy-1'), 'the legacy terminal to be migrated', 15000);
      const migrated = api.controller.list().find((t) => t.id === 'legacy-1');
      assert.deepStrictEqual(
        { name: migrated?.name, cwd: migrated?.cwd, scope: migrated?.scope },
        { name: 'LEGACY', cwd: 'backend', scope: 'workspace' }
      );
      assert.ok('terminalPilot.terminals' in workspaceSettings(), 'not written to the new setting');
      await api.controller.remove('legacy-1'); // keep the later tests' expectations simple
    },
  },

  {
    name: 'the panel webview loads under its CSP and announces itself; "Add Terminal" command works',
    async fn() {
      await vscode.commands.executeCommand('terminalPilot.focus');
      await waitFor(() => api.provider.isReady, 'the webview to load and send "ready"', 20000);
      await vscode.commands.executeCommand('terminalPilot.add'); // posts showForm to the live webview
    },
  },

  {
    name: 'creates the FRONTEND / BACKEND / ELECTRON / GIT terminals (workspace scope, relative dirs)',
    async fn() {
      await mustSave(draft('FRONTEND', 'frontend', [NODE_WRITE('frontend-ran.txt', 'F')]));
      await mustSave(draft('BACKEND', 'backend', [NODE_WRITE('backend-ran.txt', 'B')]));
      await mustSave(draft('ELECTRON', 'electron', ['npm run start']));
      await mustSave(draft('GIT', '', ['git status']));
      assert.deepStrictEqual(
        api.controller.list().map((t) => t.name),
        ['FRONTEND', 'BACKEND', 'ELECTRON', 'GIT']
      );
      const state = api.controller.snapshot();
      assert.strictEqual(state.terminals.length, 4);
      assert.ok(state.terminals.every((t) => !t.running));
    },
  },

  {
    name: 'writes only its own keys and preserves existing workspace settings',
    async fn() {
      const settings = workspaceSettings();
      assert.strictEqual(settings['editor.tabSize'], 3, 'unrelated setting was lost');
      const stored = settings['terminalPilot.terminals'] as Array<{ name: string; cwd: string; commands: string[] }>;
      assert.deepStrictEqual(stored.map((t) => t.name), ['FRONTEND', 'BACKEND', 'ELECTRON', 'GIT']);
      assert.strictEqual(stored[0].cwd, 'frontend');
      assert.deepStrictEqual(stored[3].commands, ['git status']);
    },
  },

  {
    name: 'generates terminal profiles without touching existing ones',
    async fn() {
      await api.profiles.sync();
      const key = `terminal.integrated.profiles.${profilePlatformKey()}`;
      const profiles = workspaceSettings()[key] as Record<string, any>;
      assert.deepStrictEqual(profiles.MyOwnProfile, { path: 'my-shell' }, 'foreign profile was modified');
      assert.ok(!('TM: OLD' in profiles), 'leftover profile from the previous version was not cleaned up');
      if (classifyShell(vscode.env.shell).kind !== 'unknown') {
        const entry = profiles[`${PROFILE_PREFIX}FRONTEND`];
        assert.ok(entry, 'profile for FRONTEND missing');
        assert.ok(entry.path && Array.isArray(entry.args));
        assert.strictEqual(entry.overrideName, true, 'tabs would all show the shell name instead of the profile name');
        assert.strictEqual(entry.env.TERMINAL_PILOT_ID, ids.FRONTEND);
      }
    },
  },

  {
    name: 'validates names, directories and allows saving without a command',
    async fn() {
      const dupe = await api.controller.save(draft('frontend', 'frontend', []));
      assert.ok(!dupe.ok && dupe.errors?.name && /already exists/.test(dupe.errors.name), 'duplicate name accepted');

      const missing = await api.controller.save(draft('Nope', 'does-not-exist', []));
      assert.ok(!missing.ok && missing.errors?.cwd && /does not exist/.test(missing.errors.cwd));

      const noName = await api.controller.save(draft('  ', '', []));
      assert.ok(!noName.ok && noName.errors?.name);

      await mustSave(draft('NOCMD', 'backend', []));
      assert.deepStrictEqual(api.controller.list().find((t) => t.name === 'NOCMD')?.commands, []);
      await api.controller.remove(ids.NOCMD);
    },
  },

  {
    name: 'run: opens the terminal in the right directory and executes the startup command',
    async fn() {
      const outcome = await api.controller.run(ids.FRONTEND);
      assert.ok(outcome.ok, outcome.message);
      assert.strictEqual(
        terminalsNamed('FRONTEND').length,
        1,
        `terminals now: ${vscode.window.terminals.map((t) => JSON.stringify(t.name)).join(', ')}`
      );
      assert.ok(api.controller.isRunning(ids.FRONTEND));
      await waitFor(
        () => fs.existsSync(path.join(workspaceDir, 'frontend', 'frontend-ran.txt')),
        'the startup command to create frontend/frontend-ran.txt'
      );
    },
  },

  {
    name: 'run again focuses the existing terminal instead of creating a duplicate',
    async fn() {
      const outcome = await api.controller.run(ids.FRONTEND);
      assert.ok(outcome.ok && /already running/.test(outcome.message), outcome.message);
      assert.strictEqual(terminalsNamed('FRONTEND').length, 1);
      assert.strictEqual(api.controller.snapshot().terminals.find((t) => t.id === ids.FRONTEND)?.running, true);
    },
  },

  {
    name: 'runs multiple startup commands in order',
    async fn() {
      const id = await mustSave(
        draft('MULTI', 'electron', [NODE_WRITE('order.txt', '1'), NODE_WRITE('order.txt', '2'), NODE_WRITE('order.txt', '3')])
      );
      await api.controller.run(id);
      const file = path.join(workspaceDir, 'electron', 'order.txt');
      await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').length >= 3, 'three commands to finish');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '123');
    },
  },

  {
    name: 'stop terminates a managed terminal and updates its status',
    async fn() {
      const outcome = api.controller.stop(ids.FRONTEND);
      assert.ok(outcome.ok && /Stopped/.test(outcome.message), outcome.message);
      await waitFor(() => terminalsNamed('FRONTEND').length === 0, 'FRONTEND terminal to close');
      assert.strictEqual(api.controller.isRunning(ids.FRONTEND), false);
    },
  },

  {
    name: 'runMany launches several terminals and reports partial failures',
    async fn() {
      const doomed = path.join(rootDir, 'doomed');
      fs.mkdirSync(doomed);
      await mustSave(draft('DOOMED', doomed, [], { scope: 'global' }));
      fs.rmdirSync(doomed);

      const outcome = await api.controller.runMany([ids.FRONTEND, ids.BACKEND, ids.DOOMED]);
      assert.ok(!outcome.ok, 'a missing directory should be reported');
      assert.ok(/started 2/i.test(outcome.message) && /1 failed/.test(outcome.message), outcome.message);
      assert.ok(/DOOMED/.test(outcome.message) && /does not exist/.test(outcome.message), outcome.message);
      assert.ok(api.controller.isRunning(ids.FRONTEND) && api.controller.isRunning(ids.BACKEND));
      assert.strictEqual(api.controller.isRunning(ids.DOOMED), false);
      await api.controller.remove(ids.DOOMED);
    },
  },

  {
    name: 'a fresh service re-attaches to terminals that already exist (VS Code restart / reload)',
    async fn() {
      const reborn = new TerminalService(new Logger());
      try {
        assert.ok(reborn.isRunning(ids.BACKEND), 'BACKEND should be recognised by its marker');
        assert.ok(reborn.isRunning(ids.FRONTEND));
        assert.strictEqual(reborn.isRunning(ids.GIT), false);
      } finally {
        reborn.dispose();
      }
    },
  },

  {
    name: 'stopMany stops every running managed terminal',
    async fn() {
      const outcome = api.controller.stopMany([]);
      assert.ok(outcome.ok && /Stopped \d+ terminal/.test(outcome.message), outcome.message);
      await waitFor(() => !vscode.window.terminals.some((t) => ['FRONTEND', 'BACKEND', 'MULTI'].includes(t.name)), 'terminals to close');
      assert.strictEqual(api.controller.snapshot().terminals.filter((t) => t.running).length, 0);
    },
  },

  {
    name: 'duplicate creates uniquely named copies',
    async fn() {
      await api.controller.duplicate(ids.GIT);
      await api.controller.duplicate(ids.GIT);
      const names = api.controller.list().map((t) => t.name);
      assert.ok(names.includes('GIT (copy)') && names.includes('GIT (copy 2)'), names.join(', '));
      for (const t of api.controller.list().filter((t) => t.name.startsWith('GIT ('))) {
        await api.controller.remove(t.id);
      }
    },
  },

  {
    name: 'edit renames, changes commands and moves a terminal between scopes',
    async fn() {
      const outcome = await api.controller.save(
        draft('ELECTRON APP', 'electron', ['npm run start', 'echo ready'], { scope: 'global' }),
        ids.ELECTRON
      );
      assert.ok(outcome.ok, outcome.message);

      const inspected = vscode.workspace.getConfiguration('terminalPilot').inspect<any[]>('terminals');
      assert.ok(inspected?.globalValue?.some((t) => t.name === 'ELECTRON APP' && t.id === ids.ELECTRON), 'not in global settings');
      assert.ok(!inspected?.workspaceValue?.some((t) => t.id === ids.ELECTRON), 'still in workspace settings');
      assert.strictEqual(workspaceSettings()['editor.tabSize'], 3);
      assert.strictEqual(api.controller.list().filter((t) => t.id === ids.ELECTRON).length, 1);
    },
  },

  {
    name: 'delete removes the configuration and its profile; undo restores it',
    async fn() {
      const removed = await api.controller.remove(ids.GIT);
      assert.ok(removed.ok && removed.undoable);
      assert.ok(!api.controller.list().some((t) => t.id === ids.GIT));

      await api.profiles.sync();
      const key = `terminal.integrated.profiles.${profilePlatformKey()}`;
      const profiles = workspaceSettings()[key] as Record<string, unknown>;
      assert.ok(!(`${PROFILE_PREFIX}GIT` in profiles), 'profile of deleted terminal still present');
      assert.ok('MyOwnProfile' in profiles, 'foreign profile was removed');

      const restored = await api.controller.undoDelete();
      assert.ok(restored.ok, restored.message);
      const back = api.controller.list().find((t) => t.id === ids.GIT);
      assert.deepStrictEqual(back?.commands, ['git status']);
    },
  },

  {
    name: 'ignores hand-edited malformed entries instead of failing',
    async fn() {
      const config = vscode.workspace.getConfiguration('terminalPilot');
      const current = config.inspect<any[]>('terminals')?.workspaceValue ?? [];
      await config.update('terminals', [...current, 'garbage', { name: '' }, { nonsense: true }], vscode.ConfigurationTarget.Workspace);
      assert.ok(api.controller.list().some((t) => t.id === ids.GIT));
      assert.strictEqual(api.controller.snapshot().terminals.length, api.controller.list().length);
      await config.update('terminals', current, vscode.ConfigurationTarget.Workspace);
    },
  },

  {
    name: 'a terminal opened from the dropdown reports its real folder (tab subtext matches the terminal)',
    async fn() {
      if (process.platform !== 'win32' || classifyShell(vscode.env.shell).kind !== 'powershell') {
        return; // the directory report is only needed (and only generated for PowerShell) on Windows
      }
      const profilesKey = `terminal.integrated.profiles.${profilePlatformKey()}`;
      const real = (workspaceSettings()[profilesKey] as Record<string, any>)[`${PROFILE_PREFIX}FRONTEND`];
      assert.ok(real, 'generated profile missing');

      // Same profile with the directory report stripped out: the negative control.
      const args: string[] = [...real.args];
      const script = args[args.length - 1];
      const stripped = script.replace(/\[Console\]::Write\(.*?\[string\]\[char\]7\)/, 'Write-Host');
      assert.notStrictEqual(stripped, script, 'could not build the control profile');
      const control = { ...real, args: [...args.slice(0, -1), stripped] };
      const { overrideName: _ignored, ...withoutOverride } = real; // let the title follow the directory
      const { overrideName: _ignored2, ...controlWithoutOverride } = control;

      const platformKey = profilePlatformKey() as string; // short key, e.g. "windows"
      const profiles = vscode.workspace.getConfiguration('terminal.integrated.profiles');
      const tabs = vscode.workspace.getConfiguration('terminal.integrated.tabs');
      const target = vscode.ConfigurationTarget.Workspace;
      const existing = { ...(workspaceSettings()[profilesKey] as Record<string, unknown>) };
      try {
        // The tab text is `${cwdFolder}` - the same value VS Code puts in the small description next to the name.
        await tabs.update('title', '${cwdFolder}', target);
        await profiles.update(
          platformKey,
          { ...existing, TPCHECK: withoutOverride, TPCONTROL: controlWithoutOverride },
          target
        );

        const before = new Set(vscode.window.terminals);
        // VS Code refreshes its profile list asynchronously after a settings change, so retry briefly.
        const openProfile = async (profileName: string) => {
          const deadline = Date.now() + 20000;
          for (;;) {
            try {
              await vscode.commands.executeCommand('workbench.action.terminal.newWithProfile', { profileName });
              return;
            } catch (error) {
              if (Date.now() > deadline) {
                throw error;
              }
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        };
        await openProfile('TPCHECK');
        await openProfile('TPCONTROL');
        const opened = () => vscode.window.terminals.filter((t) => !before.has(t));

        // Real profile: VS Code learns about the folder we changed into.
        await waitFor(() => opened().some((t) => t.name === 'frontend'), 'the dropdown terminal to report the "frontend" folder', 30000);
        // Control: without the report VS Code has no idea which folder the shell changed into, so it can only
        // fall back to something generic (here the process name) - which is exactly the mismatch being fixed.
        await waitFor(() => opened().length >= 2, 'the control terminal to open', 15000);
        await new Promise((r) => setTimeout(r, 4000));
        assert.ok(
          opened().some((t) => t.name !== 'frontend'),
          `control terminal unexpectedly knows the folder; saw: ${opened().map((t) => t.name).join(', ')}`
        );
      } finally {
        await tabs.update('title', undefined, target);
        await profiles.update(platformKey, existing, target);
        vscode.window.terminals.filter((t) => t.name === 'frontend' || t.name === 'project').forEach((t) => t.dispose());
      }
    },
  },

  {
    name: 'cleanup: deleting everything leaves unrelated settings intact',
    async fn() {
      for (const t of api.controller.list()) {
        await api.controller.remove(t.id);
      }
      await api.profiles.sync();
      const settings = workspaceSettings();
      assert.strictEqual(settings['editor.tabSize'], 3);
      assert.ok(!('terminalPilot.terminals' in settings), 'empty terminals key should be removed');
      const key = `terminal.integrated.profiles.${profilePlatformKey()}`;
      assert.deepStrictEqual(settings[key], { MyOwnProfile: { path: 'my-shell' } });
    },
  },
];
