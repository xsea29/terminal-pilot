import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Terminal Pilot');

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? ` (${error.stack ?? error.message})` : error ? ` (${String(error)})` : '';
    this.write('ERROR', message + detail);
  }

  private write(level: string, message: string): void {
    this.channel.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
