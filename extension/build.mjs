// build.mjs — 用 esbuild 打包 TypeScript → Chrome 擴充 dist/
// 產出：dist/{background,content,inject,popup}.js + manifest.json + popup.html
// 用法：node build.mjs [--watch]

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** 把靜態檔複製進 dist */
function copyStatic() {
  cpSync(resolve(root, 'manifest.json'), resolve(outdir, 'manifest.json'));
  cpSync(resolve(root, 'src/popup.html'), resolve(outdir, 'popup.html'));
  cpSync(resolve(root, 'src/annotate.html'), resolve(outdir, 'annotate.html'));
  cpSync(resolve(root, 'src/edit-report.html'), resolve(outdir, 'edit-report.html'));
  cpSync(resolve(root, 'src/offscreen.html'), resolve(outdir, 'offscreen.html')); // PM-86：麥克風錄音
  cpSync(resolve(root, 'src/mic-permission.html'), resolve(outdir, 'mic-permission.html')); // PM-88：授權頁
  cpSync(resolve(root, 'src/day-pass-checkout.html'), resolve(outdir, 'day-pass-checkout.html')); // PM-111：日票結帳跳板
  // PM-76：擴充圖示（manifest icons + action.default_icon 引用）
  cpSync(resolve(root, 'icons'), resolve(outdir, 'icons'), { recursive: true });
}

/** esbuild 插件：每次 build 結束後同步靜態檔（watch 模式也會觸發） */
const staticPlugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyStatic();
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: resolve(root, 'src/background.ts'),
    content: resolve(root, 'src/content.ts'),
    inject: resolve(root, 'src/inject.ts'),
    popup: resolve(root, 'src/popup.ts'),
    annotate: resolve(root, 'src/annotate.ts'),
    'edit-report': resolve(root, 'src/edit-report.ts'),
    offscreen: resolve(root, 'src/offscreen.ts'), // PM-86：麥克風錄音
    'mic-permission': resolve(root, 'src/mic-permission.ts'), // PM-88：麥克風授權頁
    'day-pass-checkout': resolve(root, 'src/day-pass-checkout.ts'), // PM-111：日票結帳跳板
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  sourcemap: true,
  logLevel: 'info',
  plugins: [staticPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('👀 watching… (Ctrl+C 結束)');
} else {
  await esbuild.build(options);
  console.log('✅ build 完成 → dist/');
}
