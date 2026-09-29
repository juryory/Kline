import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = `127.0.0.1:${process.env.PORT || 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  // 含 KLineChart + ECharts 约 1MB（gzip 约 330KB），只在内网加载，不拆包
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: true, // 允许内网其他机器（导播机）访问开发服务器
    port: 5173,
    proxy: {
      '/api': `http://${backend}`,
      '/ws': { target: `ws://${backend}`, ws: true },
    },
  },
});
