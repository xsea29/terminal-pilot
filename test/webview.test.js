// Drives the real media/main.js in jsdom with the real HTML template, playing the role of the extension host.
// Run with: npm run test:webview (requires `npm run compile` first for out/providers/webviewHtml.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const project = path.resolve(__dirname, '..');
const { renderWebviewHtml } = require(path.join(project, 'out', 'providers', 'webviewHtml.js'));
const mainJs = fs.readFileSync(path.join(project, 'media', 'main.js'), 'utf8');

function boot() {
  const html = renderWebviewHtml({ nonce: 'n', scriptUri: 'x.js', styleUri: 'x.css', cspSource: 'vscode-resource:' })
    .replace(/<script[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  let persisted;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))),
    getState: () => persisted,
    setState: (s) => { persisted = s; },
  });
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  window.HTMLFormElement.prototype.requestSubmit = function () {
    this.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  };
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.eval(mainJs);
  const host = (data) => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = (id) => window.document.getElementById(id);
  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const type = (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const key = (node, k, extra = {}) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  const last = (t) => [...sent].reverse().find((m) => m.type === t);
  return { window, document: window.document, sent, host, $, click, type, key, last, errors };
}

const shells = [{ id: 'default', label: 'Default' }, { id: 'powershell', label: 'PowerShell' }, { id: 'bash', label: 'Bash' }, { id: 'zsh', label: 'Zsh' }];
const term = (o) => ({ id: 'id-' + o.name, cwd: '', commands: [], shell: 'default', scope: 'workspace', running: false, ...o });
const state = (terminals, ws = {}) => ({ type: 'state', state: { terminals, shells, workspace: { available: true, trusted: true, hasFolder: true, ...ws } } });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('posts ready and shows the empty state', (t) => {
  assert.deepStrictEqual(t.last('ready'), { type: 'ready' });
  t.host(state([]));
  assert.match(t.$('list').textContent, /No terminals yet/);
  assert.ok(t.$('list').querySelector('button[data-action="add"]'));
  assert.strictEqual(t.$('run-btn').disabled, true);
});

test('renders rows with status, actions and accessible labels', (t) => {
  t.host(state([
    term({ name: 'FRONTEND', cwd: 'frontend', commands: ['npm run dev', 'echo 2'], running: true }),
    term({ name: 'GIT', commands: [], shell: 'bash', scope: 'global' }),
  ]));
  const rows = t.document.querySelectorAll('tbody tr');
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0].textContent, /FRONTEND/);
  assert.match(rows[0].textContent, /Running/);
  assert.match(rows[0].textContent, /\+1/);
  assert.match(rows[1].textContent, /Stopped/);
  assert.match(rows[1].textContent, /No startup command/);
  assert.match(rows[1].textContent, /\(workspace root\)/);
  assert.match(rows[1].textContent, /Bash/);
  assert.ok(rows[0].querySelector('[aria-label="Stop FRONTEND"]'));
  assert.ok(rows[0].querySelector('[aria-label="Show running terminal FRONTEND"]'));
  assert.ok(rows[1].querySelector('[aria-label="Run GIT"]'));
  assert.ok(!rows[1].querySelector('[aria-label="Stop GIT"]'));
  for (const b of t.document.querySelectorAll('.icon-btn')) assert.ok(b.getAttribute('aria-label'), 'icon button without label');
});

test('row buttons post run / stop / duplicate / delete messages', (t) => {
  t.host(state([term({ name: 'A', running: true })]));
  const q = (label) => t.document.querySelector(`[aria-label="${label}"]`);
  t.click(q('Show running terminal A')); assert.deepStrictEqual(t.last('run'), { type: 'run', id: 'id-A' });
  t.click(q('Stop A')); assert.deepStrictEqual(t.last('stop'), { type: 'stop', id: 'id-A' });
  t.click(q('Duplicate A')); assert.deepStrictEqual(t.last('duplicate'), { type: 'duplicate', id: 'id-A' });
  t.click(q('Delete A')); assert.deepStrictEqual(t.last('delete'), { type: 'delete', id: 'id-A' });
});

test('bulk run / stop use the selection, and stop only targets running terminals', (t) => {
  t.host(state([term({ name: 'A', running: true }), term({ name: 'B' }), term({ name: 'C', running: true })]));
  assert.match(t.$('run-btn').textContent, /Run all/);
  t.click(t.$('run-btn')); assert.deepStrictEqual(t.last('runMany'), { type: 'runMany', ids: [] });
  t.click(t.$('stop-btn')); assert.deepStrictEqual(t.last('stopMany').ids.sort(), ['id-A', 'id-C']);

  t.click(t.document.querySelector('input[aria-label="Select B"]'));
  assert.match(t.$('run-btn').textContent, /Run selected \(1\)/);
  assert.strictEqual(t.$('stop-btn').disabled, true, 'B is not running');
  t.click(t.$('run-btn')); assert.deepStrictEqual(t.last('runMany'), { type: 'runMany', ids: ['id-B'] });

  t.click(t.document.querySelector('input[aria-label="Select all terminals"]'));
  assert.match(t.$('run-btn').textContent, /Run selected \(3\)/);
});

test('filter narrows the list and reports no matches', (t) => {
  t.host(state([term({ name: 'FRONTEND' }), term({ name: 'BACKEND', commands: ['go run .'] })]));
  t.type(t.$('filter'), 'go run');
  assert.strictEqual(t.document.querySelectorAll('tbody tr').length, 1);
  t.type(t.$('filter'), 'zzz');
  assert.match(t.$('list').textContent, /No terminals match/);
});

test('user-provided text is never interpreted as HTML', (t) => {
  const evil = '<img src=x onerror=alert(1)>';
  t.host(state([term({ name: evil, cwd: '<b>x</b>', commands: ['<script>1</script>'] })]));
  assert.ok(!t.$('list').querySelector('img, b, script'), 'markup was injected');
  assert.ok(t.$('list').textContent.includes(evil));
});

test('add form: validation errors from the host are shown and focus moves to the field', (t) => {
  t.host(state([]));
  t.click(t.$('add-btn'));
  assert.strictEqual(t.$('form-view').hidden, false);
  assert.strictEqual(t.$('list-view').hidden, true);
  assert.strictEqual(t.$('f-shell').options.length, 4);
  assert.strictEqual(t.document.querySelector('input[name="scope"]:checked').value, 'workspace');

  t.$('form').dispatchEvent(new t.window.Event('submit', { cancelable: true }));
  const save = t.last('save');
  assert.strictEqual(save.draft.name, '');
  t.host({ type: 'saveResult', requestId: save.requestId, ok: false, errors: { name: 'Enter a terminal name.' }, message: 'Please fix' });
  assert.strictEqual(t.$('e-name').textContent, 'Enter a terminal name.');
  assert.strictEqual(t.$('f-name').getAttribute('aria-invalid'), 'true');
  assert.strictEqual(t.document.activeElement, t.$('f-name'));
  assert.strictEqual(t.$('save-btn').disabled, false, 'save must be re-enabled after a failure');
  t.type(t.$('f-name'), 'x');
  assert.strictEqual(t.$('e-name').textContent, '', 'error clears while typing');
});

test('add form: commands rows (Enter adds, paste splits lines, remove) and submit payload', (t) => {
  t.host(state([]));
  t.click(t.$('add-btn'));
  t.type(t.$('f-name'), '  FRONTEND ');
  t.type(t.$('f-cwd'), 'frontend');
  t.$('f-shell').value = 'bash';

  const rows = () => t.$('commands').querySelectorAll('input');
  assert.strictEqual(rows().length, 1);
  t.type(rows()[0], 'npm install');
  t.key(rows()[0], 'Enter');
  assert.strictEqual(rows().length, 2, 'Enter should add a row');
  assert.strictEqual(t.document.activeElement, rows()[1]);
  t.key(rows()[1], 'Enter'); // empty row: no new row
  assert.strictEqual(rows().length, 2);

  const paste = new t.window.Event('paste', { bubbles: true, cancelable: true });
  paste.clipboardData = { getData: () => 'npm run build\r\nnpm run dev\n' };
  rows()[1].dispatchEvent(paste);
  assert.strictEqual(rows().length, 3);
  assert.deepStrictEqual([...rows()].map((r) => r.value), ['npm install', 'npm run build', 'npm run dev']);
  assert.deepStrictEqual([...rows()].map((r) => r.id), ['cmd-0', 'cmd-1', 'cmd-2']);

  t.click(rows()[1].parentElement.querySelector('button')); // remove "npm run build"
  assert.deepStrictEqual([...rows()].map((r) => r.value), ['npm install', 'npm run dev']);

  t.click(t.document.querySelector('input[name="scope"][value="global"]'));
  t.$('form').dispatchEvent(new t.window.Event('submit', { cancelable: true }));
  assert.deepStrictEqual(t.last('save').draft, {
    name: '  FRONTEND ', cwd: 'frontend', shell: 'bash', scope: 'global', commands: ['npm install', 'npm run dev'],
  });
  assert.strictEqual(t.last('save').editingId, undefined);
  assert.strictEqual(t.$('save-btn').disabled, true, 'double submit must be prevented while saving');

  t.host({ type: 'saveResult', requestId: t.last('save').requestId, ok: true });
  assert.strictEqual(t.$('form-view').hidden, true);
  assert.strictEqual(t.$('list-view').hidden, false);
  // From the empty state the visible "Add Terminal" button is the one in the empty state (the toolbar is hidden).
  assert.strictEqual(t.document.activeElement.getAttribute('data-focus-key'), 'empty-add');
});

test('browse and live directory validation round-trip', (t) => {
  t.host(state([]));
  t.click(t.$('add-btn'));
  t.click(t.document.querySelector('input[name="scope"][value="global"]'));
  t.click(t.$('browse-btn'));
  assert.deepStrictEqual(t.last('browse'), { type: 'browse', current: '', scope: 'global' });

  t.host({ type: 'folderSelected', path: 'D:/Projects/frontend' });
  assert.strictEqual(t.$('f-cwd').value, 'D:/Projects/frontend');
  const v = t.last('validate');
  assert.strictEqual(v.draft.cwd, 'D:/Projects/frontend');

  // A stale response must be ignored, the current one applied.
  t.host({ type: 'validation', requestId: v.requestId - 1, errors: { cwd: 'stale' } });
  assert.strictEqual(t.$('e-cwd').textContent, '');
  t.host({ type: 'validation', requestId: v.requestId, errors: { cwd: 'The directory does not exist.', name: 'hidden: untouched' } });
  assert.strictEqual(t.$('e-cwd').textContent, 'The directory does not exist.');
  assert.strictEqual(t.$('e-name').textContent, '', 'untouched fields must not show errors on blur-validation');
});

test('edit form is prefilled and sends editingId', (t) => {
  t.host(state([term({ name: 'BACKEND', cwd: 'backend', commands: ['a', 'b'], shell: 'zsh', scope: 'global' })]));
  t.click(t.document.querySelector('[aria-label="Edit BACKEND"]'));
  assert.match(t.$('form-title').textContent, /Edit terminal .BACKEND./);
  assert.strictEqual(t.$('f-name').value, 'BACKEND');
  assert.strictEqual(t.$('f-cwd').value, 'backend');
  assert.strictEqual(t.$('f-shell').value, 'zsh');
  assert.strictEqual(t.document.querySelector('input[name="scope"]:checked').value, 'global');
  assert.deepStrictEqual([...t.$('commands').querySelectorAll('input')].map((i) => i.value), ['a', 'b']);
  assert.match(t.$('save-btn').textContent, /Save changes/);
  t.$('form').dispatchEvent(new t.window.Event('submit', { cancelable: true }));
  assert.strictEqual(t.last('save').editingId, 'id-BACKEND');
});

test('Escape cancels the form, Ctrl+Enter submits', (t) => {
  t.host(state([]));
  t.click(t.$('add-btn'));
  t.key(t.document, 'Enter', { ctrlKey: true });
  assert.ok(t.last('save'));
  t.host({ type: 'saveResult', requestId: t.last('save').requestId, ok: false, errors: {} , message: 'boom'});
  t.key(t.document, 'Escape');
  assert.strictEqual(t.$('form-view').hidden, true);
});

test('workspace scope is disabled (with an explanation) when no folder is open', (t) => {
  t.host(state([], { available: false, hasFolder: false }));
  t.click(t.$('add-btn'));
  assert.strictEqual(t.document.querySelector('input[name="scope"][value="workspace"]').disabled, true);
  assert.strictEqual(t.document.querySelector('input[name="scope"]:checked').value, 'global');
  assert.match(t.$('h-scope').textContent, /Open a folder/);
});

test('toast shows messages, announces errors assertively and offers Undo', (t) => {
  t.host(state([]));
  t.host({ type: 'toast', kind: 'success', text: 'Deleted "A".', undo: true });
  assert.strictEqual(t.$('toast').hidden, false);
  assert.match(t.$('toast').textContent, /Deleted "A"/);
  t.click(t.$('toast').querySelector('button'));
  assert.deepStrictEqual(t.last('undoDelete'), { type: 'undoDelete' });
  assert.strictEqual(t.$('toast').hidden, true);

  t.host({ type: 'toast', kind: 'error', text: 'Nope' });
  assert.strictEqual(t.$('toast').getAttribute('aria-live'), 'assertive');
  assert.strictEqual(t.$('toast').getAttribute('role'), 'alert');
});

test('showForm from the host opens the add form once state is loaded', (t) => {
  t.host(state([]));
  t.host({ type: 'showForm' });
  assert.strictEqual(t.$('form-view').hidden, false);
});

test('keyboard focus survives a state refresh (e.g. status change)', (t) => {
  t.host(state([term({ name: 'A' }), term({ name: 'B' })]));
  const edit = t.document.querySelector('[data-focus-key="id-B:edit"]');
  edit.focus();
  t.host(state([term({ name: 'A', running: true }), term({ name: 'B' })]));
  assert.strictEqual(t.document.activeElement.getAttribute('data-focus-key'), 'id-B:edit');
  const stop = t.document.querySelector('[data-focus-key="id-A:stop"]');
  stop.focus();
  t.host(state([term({ name: 'A' }), term({ name: 'B' })]));
  assert.strictEqual(t.document.activeElement.getAttribute('data-focus-key'), 'id-A:run', 'focus falls back to the row primary action');
});

let failed = 0;
for (const { name, fn } of tests) {
  const t = boot();
  try {
    fn(t);
    assert.deepStrictEqual(t.errors, [], 'uncaught errors in webview');
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       '));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} webview tests passed`);
process.exit(failed ? 1 : 0);
