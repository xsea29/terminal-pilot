import * as vscode from 'vscode';
import { TerminalPilotController, Outcome } from './controllers/TerminalPilotController';
import { TerminalPilotProvider } from './providers/TerminalPilotProvider';
import { ConfigurationService } from './services/ConfigurationService';
import { ProfileService } from './services/ProfileService';
import { TerminalService } from './services/TerminalService';
import { Logger } from './utils/logger';

/** Internal surface exposed for integration tests. Not a stable public API. */
export interface TerminalPilotApi {
  controller: TerminalPilotController;
  profiles: ProfileService;
  provider: TerminalPilotProvider;
}

export function activate(context: vscode.ExtensionContext): TerminalPilotApi {
  const logger = new Logger();
  const configuration = new ConfigurationService(logger);
  const terminals = new TerminalService(logger);
  const profiles = new ProfileService(configuration, logger);
  const controller = new TerminalPilotController(configuration, terminals, logger);
  const provider = new TerminalPilotProvider(context.extensionUri, controller, logger);

  /** Native notification for results of palette commands (the webview shows its own toasts). */
  const report = (outcome: Outcome): void => {
    if (outcome.ok) {
      void vscode.window.setStatusBarMessage(outcome.message, 4000);
    } else {
      void vscode.window.showErrorMessage(outcome.message);
    }
  };

  context.subscriptions.push(
    logger,
    configuration,
    terminals,
    profiles,
    controller,
    provider,
    vscode.window.registerWebviewViewProvider(TerminalPilotProvider.viewType, provider, {
      // Keep the form (and its unsaved input) alive while the user looks at the Terminal tab.
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('terminalPilot.focus', () => provider.reveal()),
    vscode.commands.registerCommand('terminalPilot.add', () => provider.showAddForm()),
    vscode.commands.registerCommand('terminalPilot.runAll', async () => report(await controller.runMany([]))),
    vscode.commands.registerCommand('terminalPilot.stopAll', () => report(controller.stopMany([]))),
    vscode.commands.registerCommand('terminalPilot.run', async () => {
      const items = controller.list().map((t) => ({
        label: t.name,
        description: controller.isRunning(t.id) ? 'running' : t.scope,
        detail: [t.cwd || '(workspace root)', ...t.commands].join('  ·  '),
        id: t.id,
      }));
      if (items.length === 0) {
        const choice = await vscode.window.showInformationMessage('No terminals are configured yet.', 'Add Terminal');
        if (choice) {
          await provider.showAddForm();
        }
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select the terminals to launch',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (picked && picked.length > 0) {
        report(await controller.runMany(picked.map((p) => p.id)));
      }
    })
  );

  void configuration.migrateLegacySettings();
  profiles.start();
  logger.info('Terminal Pilot activated.');
  return { controller, profiles, provider };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions. Managed terminals stay open on purpose.
}
