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
    buttonContent($('add-btn'), 'plus', 'Add Terminal');

    const runBtn = $('run-btn');
    buttonContent(runBtn, 'runAll', selected > 0 ? `Run selected (${selected})` : 'Run all');
    runBtn.disabled = terminals.length === 0;

    const scoped = selected > 0 ? terminals.filter((t) => state.selected.has(t.id)) : terminals;
    const running = scoped.filter((t) => t.running).length;
    const stopBtn = $('stop-btn');
    buttonContent(stopBtn, 'stop', selected > 0 ? 'Stop selected' : 'Stop all');
    stopBtn.disabled = running === 0;

    $('filter').hidden = terminals.length === 0;
  }

  function renderEmptyState() {
    const add = el('button', { type: 'button', class: 'btn primary', 'data-action': 'add', 'data-focus-key': 'empty-add' });
    buttonContent(add, 'plus', 'Add Terminal');
    return el(
      'div',
      { class: 'empty' },
      el('span', { html: ICONS.terminal, 'aria-hidden': 'true' }),
      el('h3', { text: 'No terminals yet' }),
      el('p', {
        text: 'Create dedicated terminals for your frontend, backend, Git or anything else. Each one opens in its own folder and runs its startup commands for you.',
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

    const commandCell = el('td', { class: 'col-cmd', title: t.commands.join('\n') });
    if (t.commands.length === 0) {
      commandCell.append(el('span', { class: 'muted', text: 'No startup command' }));
    } else {
      commandCell.append(el('span', { class: 'mono', text: t.commands[0] }));
      if (t.commands.length > 1) {
        commandCell.append(el('span', { class: 'badge', text: `+${t.commands.length - 1}` }));
      }
    }

    const cwdCell = el('td', { class: 'col-cwd', title: t.cwd || 'Workspace root' });
    cwdCell.append(
      t.cwd ? el('span', { class: 'mono', text: t.cwd }) : el('span', { class: 'muted', text: '(workspace root)' })
    );

    const nameCell = el('td', { class: 'col-name', title: t.name });
    nameCell.append(
      el('strong', { text: t.name }),
      el('span', { class: 'badge', text: t.scope === 'global' ? 'Global' : 'Workspace' })
    );

    const statusText = t.running ? 'Running' : 'Stopped';
    const statusCell = el(
      'td',
      { class: 'col-status' },
      el('span', { class: 'status ' + (t.running ? 'running' : 'stopped') }, el('span', { class: 'dot' }), statusText)
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
        : null,
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
    return el('table', { 'aria-label': 'Managed terminals' }, el('thead', null, head), body);
  }

  function renderList() {
    const focusKey = activeFocusKey();
    const all = state.data.terminals;
    state.selected = new Set([...state.selected].filter((id) => all.some((t) => t.id === id)));
    renderToolbar();

    let content;
    if (!state.loaded) {
      content = el('p', { class: 'muted', text: 'Loading…' });
    } else if (all.length === 0) {
      content = renderEmptyState();
    } else {
      const rows = visibleTerminals();
      content =
        rows.length === 0
          ? el('div', { class: 'empty' }, el('p', { text: 'No terminals match your filter.' }))
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
      const remove = input.parentElement.querySelector('button');
      remove.setAttribute('aria-label', `Remove startup command ${index + 1}`);
      remove.title = 'Remove command';
    });
    $('commands-label').setAttribute('for', 'cmd-0');
  }

  function addCommandRow(value) {
    const input = el('input', { type: 'text', placeholder: 'e.g. npm run dev', spellcheck: 'false' });
    input.value = value || '';
    const remove = el('button', { type: 'button', class: 'icon-btn', html: ICONS.close });
    const row = el('div', { class: 'command-row' }, input, remove);

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

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); // Enter adds the next row instead of submitting
        if (input.value.trim() !== '') {
          const next = addCommandRow('');
          row.after(next.row);
          renumberCommands();
          next.input.focus();
        }
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
    $('add-btn').focus();
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

    const children = [el('span', { class: 'msg', text })];
    if (undo) {
      const button = el('button', { type: 'button', class: 'btn link', text: 'Undo' });
      button.addEventListener('click', () => {
        post({ type: 'undoDelete' });
        hideToast();
      });
      children.push(button);
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
    $('add-command-btn').addEventListener('click', () => appendCommandRow('').focus());

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
