import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mock = 'http://127.0.0.1:18786';
const preload = (path: string) => `--import=${pathToFileURL(resolve(__dirname, path)).href}`;
export const isolated = { NODE_ENV: 'test', NODE_OPTIONS: preload('local-network.mjs') };
export { preload };

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  workers: 1,
  use: {
    baseURL: mock,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'mock' }],
  webServer: { command: 'npm run dev', cwd: resolve(__dirname, '..'), url: mock, reuseExistingServer: false, env: { ...isolated, LOCAL_WEB_PORT: '18786' } },
});
