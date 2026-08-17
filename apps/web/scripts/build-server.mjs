// 薄 server 生产入口 bundle（T1-11）：esbuild 把 server/index.ts 与 L1 领域包打成
// 单文件 ESM（dist-server/index.js，.gitignore 已覆盖），Node >=20 直接可跑。
// 为什么 bundle：Node 原生直跑 TS 需要 pi 包全部 import 带 .ts 扩展 + 参数属性转换，
// 改 pi 包源码越界（T1-11 只动 apps/web）；bundle 后无任何运行时 import 解析问题。
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist-server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "info",
});
