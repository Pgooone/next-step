import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // L1 barrel 直连源码（core 无构建产物，包名映射到源；tsconfig paths 同步此映射）。
      // fileURLToPath：路径含非 ASCII 目录名（中文），URL.pathname 会 percent-encode 导致文件不存在。
      "@pgoone/next-step-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
