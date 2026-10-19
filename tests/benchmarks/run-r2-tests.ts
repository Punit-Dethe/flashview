import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/r2Experiment.test.ts'], {
  stdio: 'inherit', env: { ...process.env, FLASHVIEW_TEST_R2: '1' },
});
process.exit(result.status ?? 1);
