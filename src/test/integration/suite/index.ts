import { tests } from './extension.test';

/** Minimal sequential runner (no mocha dependency). Entry point called by @vscode/test-electron. */
export async function run(): Promise<void> {
  let failed = 0;
  for (const { name, fn } of tests) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed++;
      console.error(`  ✘ ${name}\n      ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} integration tests passed.`);
  if (failed > 0) {
    throw new Error(`${failed} integration test(s) failed.`);
  }
}
