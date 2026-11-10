import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildProfileArgs, classifyShell, posixQuote, powershellQuote } from '../../shells/bootstrap';
import { findOnPath } from '../../shells/pathLookup';
import { listShells, resolveLaunchShell } from '../../shells/registry';
import { ShellNotFoundError, ShellSpec } from '../../shells/types';

const pwsh: ShellSpec = { path: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'], kind: 'powershell', name: 'pwsh' };
const bash: ShellSpec = { path: '/bin/bash', args: [], kind: 'posix', name: 'bash' };

describe('quoting', () => {
  it('quotes for PowerShell, including typographic quotes', () => {
    assert.equal(powershellQuote("it's"), "'it''s'");
    assert.equal(powershellQuote('a\u2019b'), "'a\u2019\u2019b'");
  });

  it('quotes for POSIX shells', () => {
    assert.equal(posixQuote("it's"), `'it'\\''s'`);
    assert.equal(posixQuote('a b'), "'a b'");
  });
});

describe('classifyShell', () => {
  it('recognises common shells on any platform', () => {
    assert.equal(classifyShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe').kind, 'powershell');
    assert.equal(classifyShell('C:\\Windows\\System32\\cmd.exe').kind, 'cmd');
    assert.equal(classifyShell('/usr/bin/zsh').kind, 'posix');
    assert.equal(classifyShell('/usr/bin/fish').kind, 'unknown');
  });
});

describe('buildProfileArgs', () => {
  it('changes directory, runs commands and stays interactive (PowerShell)', () => {
    assert.deepEqual(buildProfileArgs(pwsh, 'D:\\it\'s\\app', ['npm run dev', 'git status'], 'win32'), [
      '-NoLogo',
      '-NoExit',
      '-Command',
      "Set-Location -LiteralPath 'D:\\it''s\\app'; npm run dev; git status",
    ]);
  });

  it('execs an interactive shell after the commands (POSIX)', () => {
    assert.deepEqual(buildProfileArgs(bash, '/work/my app', ['npm start'], 'linux'), [
      '-c',
      "cd '/work/my app' || exit 1; npm start; exec '/bin/bash' -i",
    ]);
  });

  it('uses forward slashes for Git Bash on Windows', () => {
    const gitBash: ShellSpec = { path: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'], kind: 'posix', name: 'bash' };
    const args = buildProfileArgs(gitBash, 'D:\\Projects\\frontend', [], 'win32');
    assert.ok(args && args.join(' ').includes("cd 'D:/Projects/frontend'"));
    assert.ok(args && !args.join(' ').includes('-i -i'));
  });

  it('returns just the base args when there is nothing to do, and nothing for unknown shells', () => {
    assert.deepEqual(buildProfileArgs(pwsh, undefined, [], 'win32'), ['-NoLogo']);
    const fish: ShellSpec = { path: '/usr/bin/fish', args: [], kind: 'unknown', name: 'fish' };
    assert.equal(buildProfileArgs(fish, '/x', ['ls'], 'linux'), undefined);
  });
});

describe('findOnPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shells-'));
  fs.writeFileSync(path.join(dir, 'fakeshell.exe'), '');
  fs.writeFileSync(path.join(dir, 'plain'), '');

  it('honours PATHEXT on Windows and is case-insensitive about PATH', async () => {
    const found = await findOnPath(['fakeshell'], { Path: dir, PATHEXT: '.EXE;.CMD' }, 'win32');
    assert.equal(found?.toLowerCase(), path.win32.join(dir, 'fakeshell.exe').toLowerCase());
  });

  // A POSIX PATH cannot represent "C:\..." directories, so this case only makes sense on a POSIX host.
  it('finds exact names on POSIX and returns undefined when missing', { skip: process.platform === 'win32' }, async () => {
    assert.equal(await findOnPath(['plain'], { PATH: dir }, 'linux'), path.posix.join(dir, 'plain'));
    assert.equal(await findOnPath(['missing'], { PATH: dir }, 'linux'), undefined);
  });
});

describe('shell registry', () => {
  it('lists every supported shell, default first', () => {
    assert.deepEqual(
      listShells().map((s) => s.id),
      ['default', 'powershell', 'bash', 'zsh']
    );
  });

  it('"default" never forces a shell path (uses the user default)', async () => {
    assert.deepEqual(await resolveLaunchShell('default', { platform: 'linux', env: {} }), {});
  });

  it('reports a clear error when a shell is not installed', async () => {
    await assert.rejects(
      resolveLaunchShell('zsh', { platform: 'linux', env: { PATH: os.tmpdir() + path.sep + 'does-not-exist' } }),
      ShellNotFoundError
    );
  });
});
