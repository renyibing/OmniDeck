import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function isExpectedProxyDisconnect(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED';
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        ws: true,
        timeout: 0,
        proxyTimeout: 0,
        configure(proxy) {
          proxy.on('error', (error, _req, res) => {
            if (isExpectedProxyDisconnect(error as NodeJS.ErrnoException)) return;
            console.warn('[vite] proxy error:', error);
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Control daemon unavailable');
            }
          });
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', error => {
              if (isExpectedProxyDisconnect(error as NodeJS.ErrnoException)) return;
              console.warn('[vite] ws proxy socket error:', error);
            });
          });
        },
      },
    },
  },
});
