import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            request.setHeader('Origin', 'http://localhost:3000');
          });
        },
        target: 'http://localhost:3000',
      },
    },
  },
});
