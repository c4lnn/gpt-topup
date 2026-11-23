import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { API_PORT } from '../mock/src/runtime-config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1', port: Number(process.env.LOCAL_WEB_PORT ?? 5173), strictPort: true,
    proxy: { '^/api(?:/|\\?|$)': `http://127.0.0.1:${API_PORT}` },
  },
});
