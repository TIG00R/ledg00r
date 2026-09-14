import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    // The dev server proxies to the API so the interface reaches it on the same origin, as
    // it does in the container. Without this the front end would need CORS in development
    // and not in production, which is the kind of difference that hides a bug until deploy.
    proxy: {
      '/api': { target: process.env.LEDGER_API ?? 'http://127.0.0.1:8080', changeOrigin: true },
      '/health': { target: process.env.LEDGER_API ?? 'http://127.0.0.1:8080', changeOrigin: true },
      '/mcp': { target: process.env.LEDGER_API ?? 'http://127.0.0.1:8080', changeOrigin: true },
      '/marks': { target: process.env.LEDGER_API ?? 'http://127.0.0.1:8080', changeOrigin: true },
      // the calendar feed, so subscribing works in development as it does in the container
      '/calendar.ics': { target: process.env.LEDGER_API ?? 'http://127.0.0.1:8080', changeOrigin: true },
      // the skill, so the download on the assistant screen works here too
      '/skill.md': { target: process.env.LEDGER_API ?? 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
});
