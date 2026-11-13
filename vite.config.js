import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

// CSP hanya dipasang di build produksi (dev server butuh inline style & HMR websocket)
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; form-action 'none'";
const cspPlugin = () => ({
  name: 'tgpg-csp', apply: 'build',
  transformIndexHtml: html => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`),
});

export default defineConfig({
  base: './', // jalan di https://user.github.io/<repo>/ maupun domain custom
  plugins: [cspPlugin(), nodePolyfills({ include: ['buffer', 'process', 'util', 'events'], globals: { Buffer: true, process: true, global: true } })],
  resolve: {
    alias: [
      { find: /^os$/, replacement: here('./src/shims/os.js') },                              // GramJS: os.type()/release()
      { find: /^crypto$/, replacement: here('./node_modules/telegram/crypto/crypto.js') },   // GramJS: implementasi kripto murni-JS untuk browser
    ],
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 6000 },
  test: { environment: 'node', include: ['tests/**/*.test.js'], testTimeout: 60000 },
});
