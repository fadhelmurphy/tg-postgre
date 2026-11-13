import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';
export default mergeConfig(base, defineConfig({
  root: 'tests/harness',
  build: { outDir: '/tmp/harness-dist', emptyOutDir: true },
}));
