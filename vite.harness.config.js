import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from './vite.config.js';
export default mergeConfig(base, defineConfig({
  root: 'tests/harness',
  build: {
    outDir: '/tmp/harness-dist', emptyOutDir: true,
    rollupOptions: { input: { index: resolve('tests/harness/index.html'), ws: resolve('tests/harness/ws.html') } },
  },
}));
