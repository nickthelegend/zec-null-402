import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@deployments': resolve(__dirname, '../../deployments') } },
  server: { port: 5183, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] } },
});
