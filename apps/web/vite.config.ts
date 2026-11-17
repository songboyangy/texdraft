import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * pdf.js 的 CMap 与标准字体数据：不提供时，中文等 CID 字体的文字在预览中显示不出来。
 * 构建时复制到 dist/pdfjs/，开发服务器直接从 node_modules 提供。
 */
function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const dirs = ['cmaps', 'standard_fonts'];
  let outDir = 'dist';
  return {
    name: 'texdraft-pdfjs-assets',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const [dir] = rel.split('/');
        const file = path.resolve(root, rel);
        if (!dirs.includes(dir) || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return next();
        res.setHeader('cache-control', 'public, max-age=86400');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const d of dirs) fs.cpSync(path.join(root, d), path.join(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

const api = process.env.API_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: [
      // 从 Overleaf 移植的代码（src/lib/overleaf）保持原有的 @/ 导入路径
      { find: /^@overleaf\/o-error$/, replacement: path.resolve(import.meta.dirname, 'src/lib/overleaf/shims/o-error.ts') },
      { find: /^@\//, replacement: path.resolve(import.meta.dirname, 'src/lib/overleaf') + '/' },
    ],
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    host: '127.0.0.1',
    // 部分服务器 inotify 配额不足，用轮询监听文件变化
    watch: { usePolling: process.env.VITE_POLL === '1', interval: 500 },
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/collab': { target: api.replace(/^http/, 'ws'), ws: true },
      '/mcp': { target: api, changeOrigin: false },
    },
  },
});
