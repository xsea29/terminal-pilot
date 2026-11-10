import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  PathContext,
  isWorkspaceDependent,
  resolveWorkingDirectory,
  toPortablePath,
  validateWorkingDirectory,
} from '../../utils/paths';

const win: PathContext = { workspaceFolder: 'C:\\work\\repo', home: 'C:\\Users\\me', platform: 'win32' };
const posix: PathContext = { workspaceFolder: '/work/repo', home: '/home/me', platform: 'linux' };

describe('resolveWorkingDirectory', () => {
  it('resolves relative paths against the workspace (Windows)', () => {
    assert.deepEqual(resolveWorkingDirectory('frontend', win), { ok: true, path: 'C:\\work\\repo\\frontend' });
    assert.deepEqual(resolveWorkingDirectory('./a/b', win), { ok: true, path: 'C:\\work\\repo\\a\\b' });
  });

  it('keeps absolute paths and normalises separators (Windows)', () => {
    assert.deepEqual(resolveWorkingDirectory('D:/Projects/frontend', win), { ok: true, path: 'D:\\Projects\\frontend' });
  });

  it('resolves relative paths against the workspace (POSIX)', () => {
    assert.deepEqual(resolveWorkingDirectory('backend', posix), { ok: true, path: '/work/repo/backend' });
    assert.deepEqual(resolveWorkingDirectory('/opt/x/', posix), { ok: true, path: '/opt/x/' });
  });

  it('expands ~ and ${workspaceFolder}', () => {
    assert.deepEqual(resolveWorkingDirectory('~/proj', posix), { ok: true, path: '/home/me/proj' });
    assert.deepEqual(resolveWorkingDirectory('${workspaceFolder}/api', posix), { ok: true, path: '/work/repo/api' });
  });

  it('treats empty as the workspace root', () => {
    assert.deepEqual(resolveWorkingDirectory('', posix), { ok: true, path: '/work/repo' });
    assert.deepEqual(resolveWorkingDirectory('', { home: '/h', platform: 'linux' }), { ok: true, path: undefined });
  });

  it('reports relative paths when no folder is open', () => {
    const none: PathContext = { home: '/h', platform: 'linux' };
    assert.equal(resolveWorkingDirectory('x', none).ok, false);
    assert.equal(resolveWorkingDirectory('${workspaceFolder}', none).ok, false);
  });
});

describe('isWorkspaceDependent', () => {
  it('detects paths whose meaning depends on the open workspace', () => {
    assert.equal(isWorkspaceDependent('frontend', posix), true);
    assert.equal(isWorkspaceDependent('${workspaceFolder}/x', posix), true);
    assert.equal(isWorkspaceDependent('/abs/path', posix), false);
    assert.equal(isWorkspaceDependent('~/x', posix), false);
    assert.equal(isWorkspaceDependent('D:\\x', win), false);
  });
});

describe('toPortablePath', () => {
  it('makes paths inside the workspace relative with forward slashes', () => {
    assert.equal(toPortablePath('C:\\work\\repo\\apps\\web', win), 'apps/web');
    assert.equal(toPortablePath('C:\\work\\repo', win), '.');
    assert.equal(toPortablePath('/work/repo/a', posix), 'a');
  });

  it('keeps paths outside the workspace absolute', () => {
    assert.equal(toPortablePath('D:\\other', win), 'D:\\other');
    assert.equal(toPortablePath('/etc', posix), '/etc');
  });
});

describe('validateWorkingDirectory (real file system)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-paths-'));
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  const ctx: PathContext = { workspaceFolder: dir, home: os.homedir() };

  it('accepts existing directories (relative and absolute)', async () => {
    assert.equal(await validateWorkingDirectory('sub', ctx), undefined);
    assert.equal(await validateWorkingDirectory(path.join(dir, 'sub'), ctx), undefined);
    assert.equal(await validateWorkingDirectory('', ctx), undefined);
  });

  it('rejects missing paths and files', async () => {
    assert.match((await validateWorkingDirectory('nope', ctx)) ?? '', /does not exist/);
    assert.match((await validateWorkingDirectory('file.txt', ctx)) ?? '', /not a directory/);
  });
});
