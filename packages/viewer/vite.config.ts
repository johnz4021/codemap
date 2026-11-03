import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the API to a running codemap server: CODEMAP_SERVER_PORT (default 4317).
const server = `http://127.0.0.1:${process.env.CODEMAP_SERVER_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5317,
    proxy: {
      '/api': { target: server, headers: { host: server.slice('http://'.length) } },
      '/ws': { target: server, ws: true, headers: { host: server.slice('http://'.length) } },
    },
  },
});
