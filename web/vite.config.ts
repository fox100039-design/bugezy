import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發期把 /api 代理到本機 Workers（localhost:8787），避免跨域
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
