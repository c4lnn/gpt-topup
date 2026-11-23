export const API_PORT = 8787;
export const MOCK_PORT = 8788;
export const PRODUCTION_UPSTREAM_ORIGIN = 'https://admin-lm.zdhxylc.shop';

export type RuntimeConfig = { apiPort: number } & (
  { mode: 'mock'; mockPort: number } |
  { mode: 'production'; upstreamOrigin: string }
);
