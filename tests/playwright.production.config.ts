import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import config, { isolated, preload } from './playwright.config';

const production = 'http://127.0.0.1:8787';

export default defineConfig({
  ...config,
  use: { ...config.use, baseURL: production },
  projects: [{ name: 'production' }],
  webServer: {
    command: 'npm start', cwd: resolve(__dirname, '..'), url: production, reuseExistingServer: false,
    env: { ...isolated, NODE_OPTIONS: `${isolated.NODE_OPTIONS} ${preload('production-upstream.mjs')}` },
  },
});
