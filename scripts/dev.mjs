import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'src/site-server.ts', '--api-only'], { cwd: new URL('../apps/mock/', import.meta.url), stdio: 'inherit' }),
  spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], { cwd: new URL('../apps/web/', import.meta.url), stdio: 'inherit' }),
];
function stop(code) {
  process.exitCode = code;
  for (const child of children) child.kill();
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
for (const child of children) {
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (process.exitCode === undefined) stop(code ?? 1); });
}
