import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { TerminalPilotController, Outcome } from '../controllers/TerminalPilotController';
import { HostMessage, ToastKind } from '../models/messages';
import { Logger } from '../utils/logger';
import { resolveWorkingDirectory, toPortablePath } from '../utils/paths';
import { parseWebviewMessage } from '../utils/validation';
import { renderWebviewHtml } from './webviewHtml';

/**
 * Webview UI in the bottom panel. This class is purely a transport/presentation adapter:
 * it validates incoming messages, delegates to the controller and pushes state back.
 */
export class TerminalPilotProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'terminalPilot.view';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private pendingShowForm = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: TerminalPilotController,
    private readonly logger: Logger
  ) {
    this.disposables.push(this.controller.onDidChange(() => this.scheduleRefresh()));
  }

  // ----- WebviewViewProvider -------------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;

    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this.renderHtml(view.webview, mediaRoot);

    const subscriptions = [
      view.webview.onDidReceiveMessage((raw: unknown) => void this.onMessage(raw)),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.refresh();
        }
      }),
    ];
    view.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  // ----- public API ----------------------------------------------------------------------------

  /** True once the webview's script has loaded and announced itself (proves HTML + CSP + script work). */
  get isReady(): boolean {
    return this.ready;
  }

  /** Opens the panel tab and shows the "Add terminal" form. */
  async showAddForm(): Promise<void> {
    this.pendingShowForm = true;
    await vscode.commands.executeCommand(`${TerminalPilotProvider.viewType}.focus`);
    this.flushPendingForm();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${TerminalPilotProvider.viewType}.focus`);
  }

  /** Shows an outcome in the webview when it is visible, otherwise as a native notification. */
  notify(outcome: Outcome): void {
    const kind: ToastKind = outcome.ok ? 'success' : 'error';
    if (this.view?.visible && this.ready) {
      this.post({ type: 'toast', kind, text: outcome.message, undo: outcome.ok && outcome.undoable });
    } else if (outcome.ok) {
      void vscode.window.setStatusBarMessage(outcome.message, 4000);
    } else {
      void vscode.window.showErrorMessage(outcome.message);
    }
  }

  // ----- messaging -----------------------------------------------------------------------------

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private flushPendingForm(): void {
    if (this.pendingShowForm && this.ready) {
      this.pendingShowForm = false;
      this.post({ type: 'showForm' });
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 40);
  }

  private refresh(): void {
    if (this.view && this.ready) {
      this.post({ type: 'state', state: this.controller.snapshot() });
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.logger.warn('Ignored an invalid message from the webview.');
      return;
    }

    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          this.refresh();
          this.flushPendingForm();
          return;

        case 'validate': {
          const errors = await this.controller.validate(message.draft, message.editingId);
          this.post({ type: 'validation', requestId: message.requestId, errors });
          return;
        }

        case 'save': {
          const outcome = await this.controller.save(message.draft, message.editingId);
          this.post({
            type: 'saveResult',
            requestId: message.requestId,
            ok: outcome.ok,
            errors: outcome.ok ? undefined : outcome.errors,
            message: outcome.ok ? undefined : outcome.message,
          });
          if (outcome.ok) {
            this.notify(outcome);
          }
          return;
        }

        case 'browse': {
          const picked = await this.pickFolder(message.current);
          if (picked) {
            const path = message.scope === 'workspace' ? toPortablePath(picked, this.controller.pathContext()) : picked;
            this.post({ type: 'folderSelected', path });
          }
          return;
        }

        case 'run':
          this.notify(await this.controller.run(message.id));
          return;
        case 'runMany':
          this.notify(await this.controller.runMany(message.ids));
          return;
        case 'stop':
          this.notify(this.controller.stop(message.id));
          return;
        case 'stopMany':
          this.notify(this.controller.stopMany(message.ids));
          return;
        case 'delete':
          this.notify(await this.controller.remove(message.id));
          return;
        case 'duplicate':
          this.notify(await this.controller.duplicate(message.id));
          return;
        case 'undoDelete':
          this.notify(await this.controller.undoDelete());
          return;
      }
    } catch (error) {
      this.logger.error(`Unhandled error processing "${message.type}"`, error);
      this.notify({ ok: false, message: 'Something went wrong. See the "Terminal Pilot" output channel.' });
    }
  }

  private async pickFolder(current: string): Promise<string | undefined> {
    const resolvedCurrent = current ? this.safeResolve(current) : undefined;
    const defaultUri =
      resolvedCurrent !== undefined
        ? vscode.Uri.file(resolvedCurrent)
        : vscode.workspace.workspaceFolders?.[0]?.uri;
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Folder',
      title: 'Select the working directory',
      defaultUri,
    });
    return picked?.[0]?.fsPath;
  }

  private safeResolve(input: string): string | undefined {
    const resolved = resolveWorkingDirectory(input, this.controller.pathContext());
    return resolved.ok ? resolved.path : undefined;
  }

  // ----- HTML ----------------------------------------------------------------------------------

  private renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    return renderWebviewHtml({
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'styles.css')).toString(),
      cspSource: webview.cspSource,
    });
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}
