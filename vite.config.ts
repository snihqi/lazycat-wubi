import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** 版本号只有一个来源：package.json，顶栏显示的版本号就是它。 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * 两份产物，内容完全一样，只是形态不同：
 *   · `npm run build`        → dist/ 普通静态站（可部署，笔画数据按需拉）
 *   · `npm run build:single` → dist-single/index.html 单文件（双击离线可玩）
 *
 * 单文件开关两种写法都认：`npm run build:single`（跨平台，走 --mode single），
 * 或者 `SINGLE=1 npm run build`（POSIX shell）。
 *
 * 笔画数据只有一份（`src/data/strokes.json`），练习用到的字全在主文件里，
 * 所以没有「按需分片」这条路径。
 */
export default defineConfig(({ mode }) => {
  const single = process.env.SINGLE === '1' || mode === 'single';
  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: single ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
    build: {
      outDir: single ? 'dist-single' : 'dist',
      target: 'es2020',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 2000,
      rollupOptions: single
        ? { output: { inlineDynamicImports: true } }
        : {
            output: {
              manualChunks: {
                data: ['./src/data/index.ts'],
              },
            },
          },
    },
    server: { port: 5183 },
    mode,
  };
});
