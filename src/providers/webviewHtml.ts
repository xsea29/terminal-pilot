export interface WebviewHtmlOptions {
  nonce: string;
  scriptUri: string;
  styleUri: string;
  /** `webview.cspSource` */
  cspSource: string;
}

/** Pure template (no `vscode` import) so it can be rendered in tests. */
export function renderWebviewHtml({ nonce, scriptUri, styleUri, cspSource }: WebviewHtmlOptions): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Terminal Pilot</title>
</head>
<body>
  <main id="app">
    <section id="list-view" aria-label="Managed terminals">
      <div class="toolbar" role="toolbar" aria-label="Terminal Pilot actions">
        <button id="add-btn" class="btn primary" type="button"></button>
        <button id="run-btn" class="btn" type="button"></button>
        <button id="stop-btn" class="btn" type="button"></button>
        <input id="filter" class="filter" type="search" placeholder="Filter terminals" aria-label="Filter terminals" />
      </div>
      <div id="list"></div>
    </section>

    <section id="form-view" hidden aria-labelledby="form-title">
      <form id="form" novalidate autocomplete="off">
        <h2 id="form-title"></h2>

        <div class="grid">
          <div class="field">
            <label for="f-name">Terminal name</label>
            <input id="f-name" type="text" maxlength="64" placeholder="e.g. Frontend" aria-describedby="e-name" />
            <div class="error" id="e-name" role="alert"></div>
          </div>

          <div class="field">
            <label for="f-shell">Shell</label>
            <select id="f-shell" aria-describedby="e-shell"></select>
            <div class="error" id="e-shell" role="alert"></div>
          </div>

          <div class="field wide">
            <label for="f-cwd">Working directory</label>
            <div class="row">
              <input id="f-cwd" type="text" placeholder="Leave empty for the workspace root, or e.g. frontend" aria-describedby="h-cwd e-cwd" />
              <button id="browse-btn" class="btn" type="button"></button>
            </div>
            <div class="hint" id="h-cwd">Absolute, or relative to the workspace folder. <code>~</code> and <code>\${workspaceFolder}</code> are supported.</div>
            <div class="error" id="e-cwd" role="alert"></div>
          </div>

          <fieldset class="field wide scope" aria-describedby="e-scope">
            <legend>Save configuration in</legend>
            <label class="radio"><input type="radio" name="scope" value="workspace" /> <span>Workspace <small>only this project</small></span></label>
            <label class="radio"><input type="radio" name="scope" value="global" /> <span>Global <small>all projects</small></span></label>
            <div class="hint" id="h-scope"></div>
            <div class="error" id="e-scope" role="alert"></div>
          </fieldset>

          <div class="field wide">
            <label id="commands-label" for="cmd-0">Startup commands <small>(optional, run in order)</small></label>
            <div id="commands" role="group" aria-labelledby="commands-label"></div>
            <div><button id="add-command-btn" class="btn link" type="button"></button></div>
            <div class="error" id="e-commands" role="alert"></div>
          </div>
        </div>

        <div class="actions">
          <button id="save-btn" class="btn primary" type="submit"></button>
          <button id="cancel-btn" class="btn" type="button">Cancel</button>
        </div>
      </form>
    </section>
  </main>

  <div id="toast" class="toast" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
