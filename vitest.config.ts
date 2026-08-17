import { defineConfig } from "vitest/config";

/**
 * vitest 基线：每个包（packages/*、apps/*）自带 vitest.config.ts 作为独立 project。
 * 根目录 `npm test`（vitest run）收集全部包；包内 `npm test` 只跑本包。
 */
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
