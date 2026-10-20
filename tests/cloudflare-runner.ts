// Cross-platform runner: run the browser smoke test against local Wrangler emulation.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/browser.smoke.ts', 'tests/transferRecovery.browser.ts'], {
  stdio: 'inherit',
  env: { ...process.env, FLASHVIEW_BACKEND: 'cloudflare' },
});
process.exit(result.status ?? 1);
