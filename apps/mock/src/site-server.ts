import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { API_PORT, MOCK_PORT, PRODUCTION_UPSTREAM_ORIGIN, type RuntimeConfig } from './runtime-config.js';
import { createSiteApi } from './site-api.js';

try {
  const dev = process.argv.includes('--api-only');
  const host = !dev && process.argv.includes('--container') ? '0.0.0.0' : '127.0.0.1';
  const config: RuntimeConfig = dev
    ? { mode: 'mock', apiPort: API_PORT, mockPort: MOCK_PORT }
    : { mode: 'production', apiPort: API_PORT, upstreamOrigin: PRODUCTION_UPSTREAM_ORIGIN };
  const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (!dev && !existsSync(new URL('../../web/dist/index.html', import.meta.url))) throw new Error('缺少前端产物，请先运行 npm run build');
  const app = createSiteApi(config);
  if (!dev) app.use(express.static(root, { dotfiles: 'deny', redirect: false }));
  const mock = config.mode === 'mock' ? createApp().listen(config.mockPort, '127.0.0.1') : undefined;
  if (mock) await once(mock, 'listening');
  const server = app.listen(config.apiPort, host);
  await once(server, 'listening');
  console.log(`Site (${config.mode}): http://${host}:${config.apiPort}`);
} catch (error) {
  console.error(error instanceof Error && !('code' in error) ? error.message : '无法启动本站服务');
  process.exit(1);
}
