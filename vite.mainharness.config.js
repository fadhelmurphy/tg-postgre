import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from './vite.config.js';
export default mergeConfig(base, defineConfig({
  resolve: { alias: [{ find: /^\.\/telegram\.js$/, replacement: resolve('tests/harness/fake-telegram.js') }] },
}));
