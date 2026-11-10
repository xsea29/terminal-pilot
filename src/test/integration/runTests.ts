import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Prefers an installed VS Code (VSCODE_EXECUTABLE_PATH, or the default Windows install); otherwise downloads one. */
function findInstalledVsCode(): string | undefined {
  if (process.env.VSCODE_EXECUTABLE_PATH) {
    return process.env.VSCODE_EXECUTABLE_PATH;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const candidate = path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
    return fs.existsSync(candidate) ? candidate : undefined;
  }
  return undefined;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-it-'));
  const workspace = path.join(root, 'project');
  for (const dir of ['frontend', 'backend', 'electron', '.vscode']) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  // Pre-existing user content that the extension must never destroy.
  const profileKey = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform as 'win32'] ?? 'linux';
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify(
      {
        'editor.tabSize': 3,
        [`terminal.integrated.profiles.${profileKey}`]: {
          MyOwnProfile: { path: 'my-shell' },
          // Left behind by the pre-rename version ("Terminal Manager"); must be cleaned up.
          'TM: OLD': { path: 'old-shell' },
        },
        // Terminals saved by the pre-rename version; must be carried over to the new setting.
        'terminalManager.terminals': [{ id: 'legacy-1', name: 'LEGACY', cwd: 'backend', commands: [], shell: 'default' }],
      },
      null,
      2
    )
  );

  delete process.env.ELECTRON_RUN_AS_NODE; // set when launched from inside VS Code's own terminal

  // @vscode/test-electron starts Code through a shell on Windows, which splits arguments at spaces.
  // If the project lives in a folder such as "Terminal Pilot", point it at a space-free link instead.
  let projectDir = path.resolve(__dirname, '../../..');
  if (/\s/.test(projectDir)) {
    const link = path.join(root, 'ext');
    fs.symlinkSync(projectDir, link, 'junction');
    projectDir = link;
  }

  try {
    await runTests({
      vscodeExecutablePath: findInstalledVsCode(),
      extensionDevelopmentPath: projectDir,
      extensionTestsPath: path.join(projectDir, 'out', 'test', 'integration', 'suite'),
      extensionTestsEnv: { TM_TEST_WORKSPACE: workspace, TM_TEST_ROOT: root },
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir',
        path.join(root, 'user-data'),
        '--extensions-dir',
        path.join(root, 'extensions'),
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

main().catch((error) => {
  console.error('Integration tests failed:', error);
  process.exit(1);
});
