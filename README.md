# Terminal Pilot

Create, configure and launch **dedicated terminals** (frontend, backend, Electron, Git, database, …) from a graphical panel in VS Code. You never have to edit `settings.json` by hand.

## Features

- **Terminal Pilot tab in the bottom panel**, next to Terminal, Problems, Output and Debug Console.
- Table of terminals: name, working directory, startup command, shell, **running / stopped** status, and Run, Stop, Edit, Duplicate and Delete buttons.
- **Add Terminal** form: name, working directory (with a native folder browser), shell (Default, PowerShell, Bash, Zsh), any number of startup commands, and scope.
- **Global or Workspace scope**: global terminals follow you everywhere, workspace terminals live in the project (and can be shared through `.vscode/settings.json`).
- **Run focuses instead of duplicating**: if the terminal is already running, Run brings it to the front.
- **Stop** a terminal, **Run all / Run selected**, **Stop all / Stop selected**.
- **Survives restarts**: definitions live in settings, and running terminals are re-attached after a window reload.
- Delete has no confirmation dialog; it offers **Undo** instead.
- Also available from the Command Palette: *Terminal Pilot: Add Terminal / Run Terminal… / Run All Terminals / Stop All Managed Terminals*.
- Works on Windows, Linux and macOS, in light, dark and high-contrast themes, with full keyboard support.

## Quick start

1. Open the **Terminal Pilot** tab in the bottom panel (or run *Terminal Pilot: Show Terminal Pilot*).
2. Click **Add Terminal**.
3. Fill in the form:

   | Field | Example |
   |---|---|
   | Terminal name | `FRONTEND` |
   | Shell | `Default` |
   | Working directory | `frontend` (relative to the workspace) or `D:/Projects/frontend` |
   | Startup commands | `npm run dev` (press **Enter** for another row, or paste several lines) |
   | Save in | Workspace / Global |

4. Click **Add terminal**, then the ▶ button on the row. A terminal named `FRONTEND` opens in that folder and runs `npm run dev`.

Keyboard: `Esc` cancels the form, `Ctrl/Cmd+Enter` saves it, and every button is reachable with `Tab`.

### Working directory rules

| You enter | Meaning |
|---|---|
| *(empty)* | The workspace folder (first folder of a multi-root workspace) |
| `frontend`, `./apps/web` | Relative to the workspace folder (portable, ideal for workspace scope) |
| `D:/Projects/frontend`, `/home/me/app` | Absolute path |
| `~/projects/api` | Home directory |
| `${workspaceFolder}/api` | Explicit workspace folder |

The directory must exist when you save and when you launch. The folder browser stores workspace-relative paths automatically for workspace-scoped terminals.

## Where things are stored

| What | Setting | Notes |
|---|---|---|
| Terminal definitions | `terminalPilot.terminals` | Global → user settings, Workspace → workspace settings |
| Dropdown profiles | `terminal.integrated.profiles.<os>` | Entries named `TP: <name>`; only these are ever modified |
| Profile sync switch | `terminalPilot.syncTerminalProfiles` | Default `true` |

Example stored entry (written for you by the UI):

```jsonc
"terminalPilot.terminals": [
  { "id": "5c1c…", "name": "FRONTEND", "cwd": "frontend", "commands": ["npm run dev"], "shell": "default" }
]
```

Only these keys are written. All other user and workspace settings and all other terminal profiles are preserved (this is covered by the integration tests).

### Launching vs. terminal profiles

- **Run in the panel** calls `vscode.window.createTerminal()` with the right shell, `cwd`, a marker environment variable, and then sends each startup command. Nothing depends on profiles.
- **Profiles** (`TP: FRONTEND` in the terminal dropdown) are a bonus. Profiles cannot carry a working directory or startup commands, so the extension bakes them into the shell arguments (`cd`, run the commands, stay interactive). Profiles are generated for PowerShell, Bash/Zsh/sh and `cmd`; for shells it does not understand (for example fish) no profile is generated rather than a wrong one. Global terminals with a workspace-relative directory are skipped, because that directory has no fixed meaning outside a workspace.

### Shells and platforms

- **Default** uses whatever your VS Code default profile is (no shell path is forced).
- **PowerShell** uses `pwsh` if it is on `PATH`, otherwise Windows PowerShell on Windows.
- **Bash** on Windows uses Git Bash (found via your `terminal.integrated.profiles.windows` "Git Bash" entry, then `git.exe`, then the standard install folders). On Linux and macOS it uses `bash` from `PATH`.
- **Zsh** uses `zsh` from `PATH`.

Nothing is hard-coded to a drive letter or install directory. If a shell is missing you get a clear message and the terminal is not launched.

### Workspace Trust

Workspace-scoped terminals run commands that come from the repository, so they are **disabled in untrusted workspaces** (the Workspace option is greyed out with an explanation). Global terminals keep working.

## Upgrading from "Terminal Manager"

This extension used to be called **Terminal Manager**. On first start, Terminal Pilot copies terminals saved under the old `terminalManager.terminals` setting (user and workspace) into `terminalPilot.terminals`, and removes the old `TM: ...` entries from `terminal.integrated.profiles.*`. The old setting itself is left in place and can be deleted by hand. Uninstall the old "Terminal Manager" extension so only one copy is active.

## Running the extension from source (F5)

```bash
npm install
```

Open this folder in VS Code and press **F5** (*Run Extension*). A new *Extension Development Host* window opens with the extension loaded; open a folder in it, then open the **Terminal Pilot** tab in the bottom panel.

## Packaging a `.vsix`

```bash
npm install
npm run package          # compiles, then runs: vsce package
```

This produces `terminal-pilot-1.0.0.vsix`. Install it with:

```bash
code --install-extension terminal-pilot-1.0.0.vsix
```

or in VS Code: **Extensions** view → `…` menu → **Install from VSIX…**.

> Before publishing to the Marketplace, set your own `publisher` and a `repository` URL in `package.json`.

## Tests

```bash
npm test
```

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | validation, message parsing, path resolution, quoting, shell lookup, profile argument building |
| Webview | `npm run test:webview` | the real `media/main.js` driven in jsdom: rendering, form, keyboard, escaping, message payloads |
| Integration | `npm run test:integration` | a real VS Code instance: create/edit/delete/duplicate, settings preservation, terminal launch in the right folder, ordered commands, focus-instead-of-duplicate, stop, re-attach, profile sync |

The integration suite uses an installed VS Code (the default Windows location, or `VSCODE_EXECUTABLE_PATH`) and otherwise downloads one. It runs with an isolated user-data directory, so it never touches your own settings.

## Architecture

```text
src/
├── extension.ts                    wiring only: creates the objects below, registers commands/view
├── models/
│   ├── TerminalConfig.ts           domain types, limits, constants (no vscode imports)
│   └── messages.ts                 typed webview <-> host protocol
├── controllers/
│   └── TerminalPilotController.ts  use-cases (save, delete+undo, duplicate, run, stop, bulk) -> Outcome
├── services/
│   ├── ConfigurationService.ts     persistence via the Configuration API; serialised writes; scopes
│   ├── TerminalService.ts          create / track / focus / stop terminals; re-attach after reload
│   └── ProfileService.ts           mirrors terminals into terminal.integrated.profiles.* (owned keys only)
├── shells/
│   ├── registry.ts                 one adapter per shell (the single place to add a shell)
│   ├── bootstrap.ts                quoting + profile argument building per shell family
│   ├── pathLookup.ts               PATH / PATHEXT lookup without spawning processes
│   └── vscodeContext.ts            builds the environment description from the live VS Code
├── providers/
│   ├── TerminalPilotProvider.ts  webview transport: validate messages, call controller, push state
│   └── webviewHtml.ts              pure HTML template with the Content Security Policy
├── utils/                          validation, paths, errors, logger, async queue
└── test/                           unit + integration tests
media/                              main.js, styles.css, icon.svg (webview UI, no framework)
test/webview.test.js                jsdom tests for media/main.js
```

Design rules that keep it manageable:

- **Layering**: UI (provider + `media/`) → controller (use-cases) → services (config, terminals, profiles) → pure helpers (`models`, `utils`, `shells`). Lower layers never import upper ones.
- **Pure core**: validation, path resolution, shell lookup and quoting do not import `vscode`, so they are unit-tested without an editor.
- **One protocol file**: `models/messages.ts` defines every message; `parseWebviewMessage` validates each incoming message strictly (types, lengths, enums) before anything is acted on.
- **Stable ids**: terminals are tracked by id, not name, so renaming never loses track of a running terminal.
- **Ownership markers**: the extension only edits settings it created (`terminalPilot.terminals`, profile keys starting with `TP: `).

### Extending

- **Add a shell**: add its id to `SHELL_IDS` (`models/TerminalConfig.ts`), add it to the `enum` in `package.json`, and add one adapter in `shells/registry.ts`. The form's drop-down is populated from the registry.
- **Add a field** (for example environment variables): extend `TerminalConfig`/`TerminalDraft`, `validateDraft`/`parseDraft`/`sanitizeStoredConfigs`, pass it to `createTerminal` in `TerminalService.launch`, and add the input in `webviewHtml.ts` / `media/main.js`.
- **Add an action**: add a message to `models/messages.ts`, handle it in `TerminalPilotProvider.onMessage`, implement it in the controller. Palette commands reuse the same controller methods.

## Security

- Strict CSP: `default-src 'none'`, scripts only with a per-load nonce, styles and images only from the extension's media folder; no inline handlers.
- The webview never uses `innerHTML` with dynamic data; terminal names and commands are rendered as text.
- Every message from the webview is validated, and unknown messages are dropped and logged.
- Stored settings are re-validated on read, because users can edit `settings.json` by hand.
- Workspace-scoped commands are ignored until the workspace is trusted.

## Known limitations

- Commands are typed into the terminal one after another. A long-running first command (for example a dev server) delays the next ones until it exits, which is the same as typing them yourself. Use separate terminals for separate long-running processes.
- A relative working directory is resolved against the **first** folder of a multi-root workspace.
- Running **Run all** does not switch the panel to the Terminal tab (that would hide Terminal Pilot); the rows simply turn to *Running*. Click a row's button to jump to its terminal.
- "Re-attach after restart" relies on VS Code reviving terminals (`terminal.integrated.enablePersistentSessions`, on by default). Terminals VS Code does not revive are simply shown as stopped.

## License

MIT
