import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // xfwd forwards the browser address so the BFF can rate-limit local password logins per client.
    proxy: {
      '/events': { target: 'http://127.0.0.1:4174', xfwd: true },
      '/api': { target: 'http://127.0.0.1:4174', xfwd: true },
    },
  },
});
