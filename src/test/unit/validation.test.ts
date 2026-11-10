import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TerminalDraft } from '../../models/TerminalConfig';
import { parseWebviewMessage, sanitizeStoredConfigs, validateDraft } from '../../utils/validation';

const draft = (overrides: Partial<TerminalDraft> = {}): TerminalDraft => ({
  name: 'Frontend',
  cwd: 'frontend',
  commands: ['npm run dev'],
  shell: 'default',
  scope: 'workspace',
  ...overrides,
});

describe('validateDraft', () => {
  it('accepts a valid draft', () => {
    assert.deepEqual(validateDraft(draft(), []), {});
  });

  it('allows saving without a startup command or directory', () => {
    assert.deepEqual(validateDraft(draft({ commands: [], cwd: '' }), []), {});
  });

  it('requires a name', () => {
    assert.match(validateDraft(draft({ name: '   ' }), []).name ?? '', /Enter a terminal name/);
  });

  it('rejects duplicate names case-insensitively, ignoring whitespace', () => {
    const existing = [{ id: 'a', name: 'Frontend' }];
    assert.match(validateDraft(draft({ name: '  frontEND ' }), existing).name ?? '', /already exists/);
  });

  it('does not treat the terminal being edited as a duplicate of itself', () => {
    const existing = [{ id: 'a', name: 'Frontend' }];
    assert.equal(validateDraft(draft(), existing, 'a').name, undefined);
  });

  it('rejects line breaks inside a command and overlong names', () => {
    assert.ok(validateDraft(draft({ commands: ['a\nb'] }), []).commands);
    assert.ok(validateDraft(draft({ name: 'x'.repeat(65) }), []).name);
  });
});

describe('parseWebviewMessage', () => {
  it('accepts well-formed messages', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parseWebviewMessage({ type: 'run', id: 'abc' }), { type: 'run', id: 'abc' });
    assert.deepEqual(parseWebviewMessage({ type: 'runMany', ids: [] }), { type: 'runMany', ids: [] });
  });

  it('normalises drafts and drops blank commands', () => {
    const parsed = parseWebviewMessage({
      type: 'save',
      requestId: 3,
      draft: { name: '  A   B ', cwd: ' x ', commands: [' a ', '', '  '], shell: 'bash', scope: 'global' },
    });
    assert.ok(parsed && parsed.type === 'save');
    assert.deepEqual(parsed.draft, { name: 'A B', cwd: 'x', commands: ['a'], shell: 'bash', scope: 'global' });
  });

  it('rejects malformed or hostile input', () => {
    const bad: unknown[] = [
      null,
      'run',
      [],
      {},
      { type: 'nope' },
      { type: 'run' },
      { type: 'run', id: 42 },
      { type: 'run', id: '' },
      { type: 'run', id: 'x'.repeat(500) },
      { type: 'runMany', ids: 'a' },
      { type: 'runMany', ids: [1] },
      { type: 'browse', current: 5, scope: 'global' },
      { type: 'browse', current: '', scope: 'elsewhere' },
      { type: 'save', requestId: 1, draft: { name: 'a', cwd: '', commands: [], shell: 'fish', scope: 'global' } },
      { type: 'save', requestId: 'x', draft: { name: 'a', cwd: '', commands: [], shell: 'bash', scope: 'global' } },
      { type: 'save', requestId: 1, draft: { name: 'a', cwd: '', commands: [1], shell: 'bash', scope: 'global' } },
      { type: 'save', requestId: 1, draft: { name: 'a', cwd: '', commands: [], shell: 'bash', scope: 'global' }, editingId: 7 },
    ];
    for (const message of bad) {
      assert.equal(parseWebviewMessage(message), undefined, JSON.stringify(message));
    }
  });
});

describe('sanitizeStoredConfigs', () => {
  it('keeps valid entries and counts dropped ones', () => {
    const { items, dropped } = sanitizeStoredConfigs([
      { id: '1', name: 'A', cwd: 'a', commands: ['x', 5], shell: 'zsh' },
      { name: '' },
      'garbage',
      { id: '1', name: 'dup id' },
      { name: 'Legacy', command: 'ls', shell: 'unknown-shell' },
    ]);
    assert.equal(dropped, 3);
    assert.deepEqual(items[0], { id: '1', name: 'A', cwd: 'a', commands: ['x'], shell: 'zsh' });
    assert.deepEqual(items[1], { id: 'legacy:legacy', name: 'Legacy', cwd: '', commands: ['ls'], shell: 'default' });
  });

  it('handles a non-array value', () => {
    assert.deepEqual(sanitizeStoredConfigs(undefined), { items: [], dropped: 0 });
    assert.deepEqual(sanitizeStoredConfigs({ a: 1 }), { items: [], dropped: 1 });
  });
});
