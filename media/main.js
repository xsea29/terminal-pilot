/* Terminal Pilot webview.
 *
 * - Talks to the extension host exclusively through postMessage (see src/models/messages.ts).
 * - Never uses innerHTML with dynamic data: user-provided values are always set through textContent/value.
 * - Runs under a strict CSP (nonce-only scripts, no inline handlers).
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ---------------------------------------------------------------------------------------------
  // Icons (static, trusted markup)
  // ---------------------------------------------------------------------------------------------

  const STROKE =
    'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICONS = {
    play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>',
    runAll:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5v8l6-4z"/><path d="M2 7.5v6l9-4.5z" opacity=".75"/></svg>',
    terminal: `<svg ${STROKE}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5"/><path d="M4.5 6.2l2 1.6-2 1.6M8 10h3.5"/></svg>`,
    edit: `<svg ${STROKE}><path d="M10.8 2.7l2.5 2.5L5.4 13.1l-3.1.6.6-3.1z"/></svg>`,
    copy: `<svg ${STROKE}><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5v-7a1 1 0 0 1 1-1h7"/></svg>`,
    trash: `<svg ${STROKE}><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>`,
    plus: `<svg ${STROKE}><path d="M8 3v10M3 8h10"/></svg>`,
    folder: `<svg ${STROKE}><path d="M1.8 3.8h4.2l1.5 1.7h6.7v7.2H1.8z"/></svg>`,
    close: `<svg ${STROKE}><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    grip: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></svg>',
    search: `<svg ${STROKE}><circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L14 14"/></svg>`,
    back: `<svg ${STROKE}><path d="M13 8H3M7 4L3 8l4 4"/></svg>`,
    ok: `<svg ${STROKE}><circle cx="8" cy="8" r="6.2"/><path d="M5.4 8.2l1.8 1.8 3.4-3.7"/></svg>`,
    info: `<svg ${STROKE}><circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v3.6M8 5.1v.1"/></svg>`,
    error: `<svg ${STROKE}><circle cx="8" cy="8" r="6.2"/><path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8"/></svg>`,
  };

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------

  /** Creates an element. `html` is only ever used with the constants above. */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key === 'html') {
        node.innerHTML = value;
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children) {
      if (child) {
        node.append(child);
      }
    }
    return node;
  }

  const $ = (id) => document.getElementById(id);
  const post = (message) => vscode.postMessage(message);
  const icon = (name) => el('span', { html: ICONS[name], class: 'icon', 'aria-hidden': 'true' });

  function iconButton({ name, label, action, className, disabled, focusKey }) {
    return el('button', {
      type: 'button',
      class: 'icon-btn ' + (className || ''),
      title: label,
      'aria-label': label,
      'data-action': action,
      'data-focus-key': focusKey,
      disabled,
      html: ICONS[name],
    });
  }

  function buttonContent(button, iconName, text) {
    button.replaceChildren(icon(iconName), document.createTextNode(text));
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  const saved = vscode.getState() || {};
  const state = {
    data: { terminals: [], shells: [], workspace: { available: false, trusted: true, hasFolder: false } },
    loaded: false,
    selected: new Set(),
    filter: typeof saved.filter === 'string' ? saved.filter : '',
    lastScope: saved.lastScope === 'global' || saved.lastScope === 'workspace' ? saved.lastScope : undefined,
    form: null,
    requestSeq: 0,
  };

  function persist() {
    vscode.setState({ filter: state.filter, lastScope: state.lastScope });
  }

  // ---------------------------------------------------------------------------------------------
  // List view
  // ---------------------------------------------------------------------------------------------

  function activeFocusKey() {
    const active = document.activeElement;
    return active && $('list').contains(active) ? active.getAttribute('data-focus-key') : null;
  }

  function restoreFocus(key) {
    if (!key) {
      return;
    }
    const target =
      $('list').querySelector(`[data-focus-key="${CSS.escape(key)}"]:not(:disabled)`) ||
      // e.g. the Stop button vanished after stopping: fall back to the same row's primary action
      $('list').querySelector(`[data-focus-key="${CSS.escape(key.split(':')[0])}:run"]`);
    if (target) {
      target.focus();
    }
  }

  function visibleTerminals() {
    const query = state.filter.trim().toLowerCase();
    if (!query) {
      return state.data.terminals;
    }
    return state.data.terminals.filter((t) =>
      [t.name, t.cwd, t.shell, t.scope, ...t.commands].join('\n').toLowerCase().includes(query)
    );
  }

  function renderToolbar() {
    const terminals = state.data.terminals;
    const selected = state.selected.size;

    // With nothing configured the empty state offers the one and only "Add Terminal" button.
    $('toolbar').hidden = !state.loaded || terminals.length === 0;
    buttonContent($('add-btn'), 'plus', 'Add Terminal');

    const runBtn = $('run-btn');
    buttonContent(runBtn, 'runAll', selected > 0 ? `Run selected (${selected})` : 'Run all');
    runBtn.disabled = terminals.length === 0;

    const scoped = selected > 0 ? terminals.filter((t) => state.selected.has(t.id)) : terminals;
    const stopBtn = $('stop-btn');
    buttonContent(stopBtn, 'stop', selected > 0 ? 'Stop selected' : 'Stop all');
    stopBtn.disabled = scoped.filter((t) => t.running).length === 0;

    const running = terminals.filter((t) => t.running).length;
    const total = `${terminals.length} terminal${terminals.length === 1 ? '' : 's'}`;
    $('summary').textContent = running > 0 ? `${total} · ${running} running` : total;
  }

  function renderEmptyState() {
    const add = el('button', { type: 'button', class: 'btn primary', 'data-action': 'add', 'data-focus-key': 'empty-add' });
    buttonContent(add, 'plus', 'Add Terminal');
    return el(
      'div',
      { class: 'empty' },
      el('div', { class: 'empty-icon', html: ICONS.terminal, 'aria-hidden': 'true' }),
      el('h3', { text: 'No terminals yet' }),
      el('p', {
        text: 'Create a dedicated terminal for your frontend, backend, Git or anything else. Each one opens in its own folder and runs its startup commands for you.',
      }),
      add
    );
  }

  function renderRow(t) {
    const checkbox = el('input', {
      type: 'checkbox',
      'aria-label': `Select ${t.name}`,
      'data-select': t.id,
      'data-focus-key': `${t.id}:select`,
    });
    checkbox.checked = state.selected.has(t.id);

    const shellLabel = (state.data.shells.find((s) => s.id === t.shell) || { label: t.shell }).label;

    const nameCell = el(
      'td',
      { class: 'col-name', title: t.name },
      el(
        'div',
        { class: 'name-line' },
        el('span', { class: 'name', text: t.name }),
        el('span', { class: 'chip', text: t.scope === 'global' ? 'Global' : 'Workspace' })
      )
    );

    const cwdCell = el('td', { class: 'col-cwd', title: t.cwd || 'Workspace root' });
    cwdCell.append(
      t.cwd ? el('span', { class: 'mono', text: t.cwd }) : el('span', { class: 'muted', text: '(workspace root)' })
    );

    const commandCell = el('td', { class: 'col-cmd', title: t.commands.join('\n') });
    if (t.commands.length === 0) {
      commandCell.append(el('span', { class: 'muted', text: 'No startup command' }));
    } else {
      commandCell.append(el('code', { class: 'cmd', text: t.commands[0] }));
      if (t.commands.length > 1) {
        commandCell.append(el('span', { class: 'chip more', text: `+${t.commands.length - 1}` }));
      }
    }

    const statusCell = el(
      'td',
      { class: 'col-status' },
      el(
        'span',
        { class: 'status ' + (t.running ? 'running' : 'stopped') },
        el('span', { class: 'dot' }),
        t.running ? 'Running' : 'Stopped'
      )
    );

    const actions = el(
      'div',
      { class: 'actions-cell' },
      iconButton({
        name: t.running ? 'terminal' : 'play',
        label: t.running ? `Show running terminal ${t.name}` : `Run ${t.name}`,
        action: 'run',
        className: 'run',
        focusKey: `${t.id}:run`,
      }),
      t.running
        ? iconButton({ name: 'stop', label: `Stop ${t.name}`, action: 'stop', focusKey: `${t.id}:stop` })
        : el('span', { class: 'icon-slot', 'aria-hidden': 'true' }), // keeps the other buttons aligned across rows
      iconButton({ name: 'edit', label: `Edit ${t.name}`, action: 'edit', focusKey: `${t.id}:edit` }),
      iconButton({ name: 'copy', label: `Duplicate ${t.name}`, action: 'duplicate', focusKey: `${t.id}:duplicate` }),
      iconButton({ name: 'trash', label: `Delete ${t.name}`, action: 'delete', className: 'danger', focusKey: `${t.id}:delete` })
    );

    const row = el('tr', { 'data-id': t.id });
    row.append(
      el('td', { class: 'col-select' }, checkbox),
      nameCell,
      cwdCell,
      commandCell,
      el('td', { class: 'col-shell', text: shellLabel }),
      statusCell,
      el('td', { class: 'col-actions' }, actions)
    );
    return row;
  }

  function renderTable(rows) {
    const selectAll = el('input', { type: 'checkbox', 'aria-label': 'Select all terminals', 'data-select-all': '' });
    const selectedVisible = rows.filter((t) => state.selected.has(t.id)).length;
    selectAll.checked = selectedVisible > 0 && selectedVisible === rows.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < rows.length;

    const head = el(
      'tr',
      null,
      el('th', { class: 'col-select' }, selectAll),
      el('th', { class: 'col-name', text: 'Name', scope: 'col' }),
      el('th', { class: 'col-cwd', text: 'Directory', scope: 'col' }),
      el('th', { class: 'col-cmd', text: 'Startup command', scope: 'col' }),
      el('th', { class: 'col-shell', text: 'Shell', scope: 'col' }),
      el('th', { class: 'col-status', text: 'Status', scope: 'col' }),
      el('th', { class: 'col-actions', scope: 'col' }, el('span', { class: 'sr-only', text: 'Actions' }))
    );
    const body = el('tbody');
    rows.forEach((t) => body.append(renderRow(t)));
    return el(
      'div',
      { class: 'table-card' },
      el('table', { 'aria-label': 'Managed terminals' }, el('thead', null, head), body)
    );
  }

  function renderList() {
    const focusKey = activeFocusKey();
    const all = state.data.terminals;
    state.selected = new Set([...state.selected].filter((id) => all.some((t) => t.id === id)));
    renderToolbar();

    let content;
    if (!state.loaded) {
      content = el('div', { class: 'empty compact' }, el('p', { text: 'Loading…' }));
    } else if (all.length === 0) {
      content = renderEmptyState();
    } else {
      const rows = visibleTerminals();
      content =
        rows.length === 0
          ? el('div', { class: 'empty compact' }, el('p', { text: 'No terminals match your filter.' }))
          : renderTable(rows);
    }
    $('list').replaceChildren(content);
    restoreFocus(focusKey);
  }

  function onListClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }
    const action = button.getAttribute('data-action');
    const row = button.closest('tr');
    const id = row ? row.getAttribute('data-id') : undefined;
    const terminal = state.data.terminals.find((t) => t.id === id);

    switch (action) {
      case 'add':
        return openForm(null);
      case 'edit':
        return terminal && openForm(terminal);
      case 'run':
      case 'stop':
      case 'delete':
      case 'duplicate':
        return id && post({ type: action, id });
    }
  }

  function onListChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    if (target.hasAttribute('data-select-all')) {
      const rows = visibleTerminals();
      rows.forEach((t) => (target.checked ? state.selected.add(t.id) : state.selected.delete(t.id)));
    } else if (target.hasAttribute('data-select')) {
      const id = target.getAttribute('data-select');
      target.checked ? state.selected.add(id) : state.selected.delete(id);
    } else {
      return;
    }
    renderList();
  }

  // ---------------------------------------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------------------------------------

  const FIELDS = ['name', 'shell', 'cwd', 'scope', 'commands'];

  function selectedScope() {
    const checked = document.querySelector('input[name="scope"]:checked');
    return checked ? checked.value : 'global';
  }

  function commandInputs() {
    return Array.from($('commands').querySelectorAll('input'));
  }

  function renumberCommands() {
    const inputs = commandInputs();
    inputs.forEach((input, index) => {
      input.id = `cmd-${index}`;
      input.setAttribute('aria-label', `Startup command ${index + 1}`);
      const remove = input.parentElement.querySelector('.remove');
      remove.setAttribute('aria-label', `Remove startup command ${index + 1}`);
      remove.title = 'Remove command';
      const grip = input.parentElement.querySelector('.grip');
      grip.setAttribute('aria-label', `Move startup command ${index + 1} (drag, or use the up and down arrow keys)`);
      grip.disabled = inputs.length < 2;
      grip.title = grip.disabled ? 'Add another command to reorder' : 'Drag to reorder';
    });
    $('commands-label').setAttribute('for', 'cmd-0');
  }

  /** Moves a row one place up (-1) or down (1); the saved order is simply the DOM order. */
  function moveRow(row, direction) {
    const other = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!other) {
      return false;
    }
    const before = other.getBoundingClientRect().top;
    if (direction < 0) {
      other.before(row);
    } else {
      other.after(row);
    }
    const shift = before - other.getBoundingClientRect().top;
    if (shift && other.animate) {
      other.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 140, easing: 'ease-out' });
    }
    renumberCommands();
    return true;
  }

  /** Drag a row by its grip: it swaps places as the pointer crosses its neighbours. */
  function enableReorder(row, grip) {
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || grip.disabled) {
        return;
      }
      event.preventDefault();
      grip.focus();
      row.classList.add('dragging');
      const move = (e) => {
        for (;;) {
          const up = row.previousElementSibling;
          const down = row.nextElementSibling;
          if (up && e.clientY < up.getBoundingClientRect().top + up.offsetHeight / 2) {
            moveRow(row, -1);
          } else if (down && e.clientY > down.getBoundingClientRect().top + down.offsetHeight / 2) {
            moveRow(row, 1);
          } else {
            return;
          }
        }
      };
      const stop = () => {
        row.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });

    // Keyboard: arrow keys on the grip, or Alt+Up / Alt+Down inside the text box.
    const onKey = (event, requireAlt) => {
      const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (!direction || (requireAlt && !event.altKey)) {
        return;
      }
      event.preventDefault();
      moveRow(row, direction);
      (requireAlt ? row.querySelector('input') : grip).focus();
    };
    grip.addEventListener('keydown', (event) => onKey(event, false));
    row.querySelector('input').addEventListener('keydown', (event) => onKey(event, true));
  }

  function addCommandRow(value) {
    const input = el('input', { type: 'text', placeholder: 'e.g. npm run dev', spellcheck: 'false' });
    input.value = value || '';
    const grip = el('button', { type: 'button', class: 'icon-btn grip', html: ICONS.grip });
    const remove = el('button', { type: 'button', class: 'icon-btn remove', html: ICONS.close });
    const row = el('div', { class: 'command-row' }, grip, input, remove);
    enableReorder(row, grip);

    remove.addEventListener('click', () => {
      const inputs = commandInputs();
      if (inputs.length === 1) {
        input.value = '';
        input.focus();
        return;
      }
      const index = inputs.indexOf(input);
      row.remove();
      renumberCommands();
      const remaining = commandInputs();
      (remaining[Math.max(0, index - 1)] || $('add-command-btn')).focus();
    });

    // The red outline goes away as soon as the user types something.
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); // Enter adds the next row instead of submitting
        if (input.value.trim() === '') {
          input.setAttribute('aria-invalid', 'true'); // a blank command cannot be added
          return;
        }
        const next = addCommandRow('');
        row.after(next.row);
        renumberCommands();
        next.input.focus();
      }
    });

    // Pasting several lines creates one row per line.
    input.addEventListener('paste', (event) => {
      const text = (event.clipboardData && event.clipboardData.getData('text')) || '';
      if (!/[\r\n]/.test(text)) {
        return;
      }
      event.preventDefault();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length === 0) {
        return;
      }
      input.value = lines[0];
      input.removeAttribute('aria-invalid');
      let anchor = row;
      lines.slice(1).forEach((line) => {
        const created = addCommandRow(line);
        anchor.after(created.row);
        anchor = created.row;
      });
      renumberCommands();
      commandInputs().pop().focus();
    });

    return { row, input };
  }

  /** Outlines every empty command box in red and focuses the first one. Returns true if there was one. */
  function flagBlankCommands() {
    const blanks = commandInputs().filter((i) => i.value.trim() === '');
    blanks.forEach((i) => i.setAttribute('aria-invalid', 'true'));
    if (blanks.length > 0) {
      blanks[0].focus();
    }
    return blanks.length > 0;
  }

  function appendCommandRow(value) {
    const created = addCommandRow(value);
    $('commands').append(created.row);
    renumberCommands();
    return created.input;
  }

  function updateScopeAvailability() {
    const workspace = state.data.workspace;
    const radio = document.querySelector('input[name="scope"][value="workspace"]');
    radio.disabled = !workspace.available;
    if (!workspace.available && radio.checked) {
      document.querySelector('input[name="scope"][value="global"]').checked = true;
    }
    $('h-scope').textContent = workspace.available
      ? ''
      : workspace.hasFolder
        ? 'Workspace scope is disabled because this workspace is not trusted.'
        : 'Open a folder to store terminals in the workspace.';
  }

  function openForm(terminal) {
    state.form = { editingId: terminal ? terminal.id : undefined, touched: new Set(), lastValidateId: 0, lastSaveId: 0, saving: false };

    $('form-title').textContent = terminal ? `Edit terminal “${terminal.name}”` : 'Add terminal';
    buttonContent($('save-btn'), terminal ? 'edit' : 'plus', terminal ? 'Save changes' : 'Add terminal');
    buttonContent($('browse-btn'), 'folder', 'Browse…');
    buttonContent($('add-command-btn'), 'plus', 'Add command');
    $('save-btn').disabled = false;

    $('f-name').value = terminal ? terminal.name : '';
    $('f-cwd').value = terminal ? terminal.cwd : '';

    const shell = $('f-shell');
    shell.replaceChildren(...state.data.shells.map((s) => el('option', { value: s.id, text: s.label })));
    shell.value = terminal ? terminal.shell : 'default';

    const workspaceAvailable = state.data.workspace.available;
    const scope = terminal ? terminal.scope : workspaceAvailable ? state.lastScope || 'workspace' : 'global';
    document.querySelector(`input[name="scope"][value="${scope === 'global' ? 'global' : 'workspace'}"]`).checked = true;
    updateScopeAvailability();

    $('commands').replaceChildren();
    const commands = terminal && terminal.commands.length > 0 ? terminal.commands : [''];
    commands.forEach((c) => appendCommandRow(c));

    FIELDS.forEach((f) => setError(f, ''));

    $('list-view').hidden = true;
    $('form-view').hidden = false;
    $('f-name').focus();
    $('f-name').select();
  }

  function closeForm() {
    state.form = null;
    $('form-view').hidden = true;
    $('list-view').hidden = false;
    renderList();
    const visibleAdd = $('toolbar').hidden ? $('list').querySelector('[data-focus-key="empty-add"]') : $('add-btn');
    if (visibleAdd) {
      visibleAdd.focus();
    }
  }

  function collectDraft() {
    return {
      name: $('f-name').value,
      cwd: $('f-cwd').value,
      shell: $('f-shell').value,
      scope: selectedScope(),
      commands: commandInputs().map((i) => i.value),
    };
  }

  function setError(field, message) {
    const target = $('e-' + field);
    if (target) {
      target.textContent = message || '';
    }
    const input = field === 'name' ? $('f-name') : field === 'cwd' ? $('f-cwd') : field === 'shell' ? $('f-shell') : null;
    if (input) {
      if (message) {
        input.setAttribute('aria-invalid', 'true');
      } else {
        input.removeAttribute('aria-invalid');
      }
    }
  }

  function showErrors(errors, onlyTouched) {
    FIELDS.forEach((field) => {
      const visible = !onlyTouched || state.form.touched.has(field);
      setError(field, visible ? errors[field] : '');
    });
  }

  function focusFirstInvalid(errors) {
    if (errors.name) return $('f-name').focus();
    if (errors.shell) return $('f-shell').focus();
    if (errors.cwd) return $('f-cwd').focus();
    if (errors.scope) return document.querySelector('input[name="scope"]').focus();
    if (errors.commands) return commandInputs()[0].focus();
  }

  function requestValidation(field) {
    if (!state.form) {
      return;
    }
    if (field) {
      state.form.touched.add(field);
    }
    const requestId = ++state.requestSeq;
    state.form.lastValidateId = requestId;
    post({ type: 'validate', requestId, draft: collectDraft(), editingId: state.form.editingId });
  }

  function submitForm(event) {
    event.preventDefault();
    if (!state.form || state.form.saving) {
      return;
    }
    // One empty box just means "no startup command"; an empty box between others is a mistake.
    if (commandInputs().length > 1 && flagBlankCommands()) {
      return;
    }
    state.form.saving = true;
    $('save-btn').disabled = true;
    const requestId = ++state.requestSeq;
    state.form.lastSaveId = requestId;
    post({ type: 'save', requestId, draft: collectDraft(), editingId: state.form.editingId });
  }

  function onSaveResult(message) {
    if (!state.form || message.requestId !== state.form.lastSaveId) {
      return;
    }
    state.form.saving = false;
    $('save-btn').disabled = false;
    if (message.ok) {
      state.lastScope = selectedScope();
      persist();
      closeForm();
      return;
    }
    const errors = message.errors || {};
    showErrors(errors, false);
    if (Object.keys(errors).length > 0) {
      focusFirstInvalid(errors);
    } else if (message.message) {
      showToast('error', message.message);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------------------------

  let toastTimer;

  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
  }

  function showToast(kind, text, undo) {
    clearTimeout(toastTimer);
    const toast = $('toast');
    toast.className = 'toast ' + kind;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

    const children = [
      el('span', { class: 'toast-icon', html: ICONS[kind === 'error' ? 'error' : kind === 'info' ? 'info' : 'ok'] }),
      el('span', { class: 'msg', text }),
    ];
    if (undo) {
      const button = el('button', { type: 'button', class: 'toast-undo', text: 'Undo' });
      button.addEventListener('click', () => {
        post({ type: 'undoDelete' });
        hideToast();
      });
      children.push(button);
    }
    const close = el('button', { type: 'button', class: 'icon-btn toast-close', html: ICONS.close, title: 'Dismiss', 'aria-label': 'Dismiss' });
    close.addEventListener('click', hideToast);
    children.push(close);
    if (undo) {
      children.push(el('span', { class: 'toast-timer' })); // shrinks over the undo window (see styles.css)
    }
    toast.replaceChildren(...children);
    toast.hidden = false;
    toastTimer = setTimeout(hideToast, undo ? 10000 : kind === 'error' ? 10000 : 4000);
  }

  // ---------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'state':
        state.data = message.state;
        state.loaded = true;
        renderList();
        if (state.form) {
          updateScopeAvailability();
        }
        break;
      case 'toast':
        showToast(message.kind, message.text, message.undo);
        break;
      case 'showForm':
        if (state.loaded && !state.form) {
          openForm(null);
        }
        break;
      case 'folderSelected':
        if (state.form) {
          $('f-cwd').value = message.path;
          requestValidation('cwd');
          $('f-cwd').focus();
        }
        break;
      case 'validation':
        if (state.form && message.requestId === state.form.lastValidateId) {
          showErrors(message.errors, true);
        }
        break;
      case 'saveResult':
        onSaveResult(message);
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!state.form) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeForm();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('form').requestSubmit();
    }
  });

  function init() {
    buttonContent($('add-btn'), 'plus', 'Add Terminal');
    $('search-icon').innerHTML = ICONS.search;
    $('back-btn').innerHTML = ICONS.back;
    $('back-btn').addEventListener('click', closeForm);
    $('filter').value = state.filter;
    $('filter').addEventListener('input', (event) => {
      state.filter = event.target.value;
      persist();
      renderList();
    });

    $('add-btn').addEventListener('click', () => openForm(null));
    $('run-btn').addEventListener('click', () => post({ type: 'runMany', ids: [...state.selected] }));
    $('stop-btn').addEventListener('click', () => {
      // "Stop all" must only touch managed terminals that are actually running.
      const scope = state.selected.size > 0 ? state.data.terminals.filter((t) => state.selected.has(t.id)) : state.data.terminals;
      post({ type: 'stopMany', ids: scope.filter((t) => t.running).map((t) => t.id) });
    });

    $('list').addEventListener('click', onListClick);
    $('list').addEventListener('change', onListChange);

    $('form').addEventListener('submit', submitForm);
    $('cancel-btn').addEventListener('click', closeForm);
    $('browse-btn').addEventListener('click', () => post({ type: 'browse', current: $('f-cwd').value, scope: selectedScope() }));
    $('add-command-btn').addEventListener('click', () => {
      if (!flagBlankCommands()) {
        appendCommandRow('').focus();
      }
    });

    $('f-name').addEventListener('input', () => setError('name', ''));
    // Don't nag about an empty name just because focus left the (auto-focused) field; submit reports it.
    $('f-name').addEventListener('blur', () => {
      if ($('f-name').value.trim() !== '') {
        requestValidation('name');
      }
    });
    $('f-cwd').addEventListener('input', () => setError('cwd', ''));
    $('f-cwd').addEventListener('blur', () => requestValidation('cwd'));
    document.querySelectorAll('input[name="scope"]').forEach((radio) =>
      radio.addEventListener('change', () => {
        setError('scope', '');
        if ($('f-cwd').value.trim() !== '') {
          requestValidation('cwd');
        }
      })
    );

    renderList();
    post({ type: 'ready' });
  }

  init();
})();
