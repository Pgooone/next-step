// 前端面板 bundle（T1-12）：零框架原生 ES 模块 → 单文件（esbuild，复用 server 同款依赖）。
// 静态产物 dist-web/ 由薄 server 静态路由托管（create-server serveStatic，index.ts 注入）。
// 为什么 bundle：浏览器无法直接 import .ts；esbuild 只做转译+打包，不引入任何框架/运行时依赖。
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist-web");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(root, "web/main.ts")],
  outfile: join(outdir, "bundle.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
});

// index.html / styles.css 原样复制（无 CSS 打包需求）
cpSync(join(root, "web/index.html"), join(outdir, "index.html"));
cpSync(join(root, "web/styles.css"), join(outdir, "styles.css"));
console.log(`[next-step-web] 前端产物已输出: ${outdir}`);
