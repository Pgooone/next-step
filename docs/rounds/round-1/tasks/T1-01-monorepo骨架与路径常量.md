# T1-01 · monorepo 骨架与 .nextstep 路径常量

> 柱子：**可控**（结构秩序是后续一切卡的地基；路径常量单点兑现 H1 裁决）
> 让哪条变绿：无直接 AC——支撑全部卡（T1-02 起的依赖根）；H1 裁决落点
> 层：L1（基座）｜ **新写**（搬 `ProjectRegistry` 自旧仓 `lib/domain/project-registry.ts`）

## 依赖
- 前置卡：无（第一张）

## 实现要点
- 建 monorepo（npm workspaces）：根 `package.json`（`workspaces: ["packages/*", "apps/*"]`，private）+ 统一 `tsconfig` + vitest 基线配置；目录：`packages/core/`、`packages/pi-ext/`、`apps/web/`、`pi-fork/`（fork 内核占位，README 注 UPSTREAM 纪律，不实际引入源码）。
- **H1 落点（评审 C 节裁决）**：`.nextstep` 路径常量**单点定义** `packages/core/src/config/paths.ts`：
  - `export const NEXTSTEP_DIR_NAME = "nextstep";`（用户级 `~/.nextstep` 与项目级 `<projectRoot>/.nextstep` 共用此常量）
  - 迁移清单 + `ProjectRegistry`（旧仓 `project-registry.ts` 搬入 `packages/core/src/domain/`）**都必须引用此常量**，不得散落字面量；后续 fork 实证 CONFIG_DIR_NAME 行为后只改这一处。
- `ProjectRegistry` 搬 + 适配：旧仓数据目录 `.pi` → 常量 `NEXTSTEP_DIR_NAME`；projects.json 位置随用户级目录常量；保留旧仓语义（项目不存在抛 ProjectError NOT_FOUND、list()/get()）。
- `packages/core` 的 `package.json` 声明零依赖（除 devDeps：typescript / vitest）；**不出现** `@earendil-works/*`（L1 零 pi import 的包级保证，B1）。
- 空壳测试文件验证 vitest 链路跑通。

## 验收断言（可执行）
- [ ] `pnpm test`（或 npm 等价）在 `packages/core` 跑通空壳单测（vitest 基线绿）
- [ ] 全仓 grep `\.pi\b` 于 `packages/core/src/` 零命中；`grep -rn "nextstep" packages/core/src/config/paths.ts` 为唯一路径来源（`ProjectRegistry` 引用 `NEXTSTEP_DIR_NAME` 而非字面量）
- [ ] `ProjectRegistry` 旧仓行为回归：get 不存在项目抛错；list 返回空或已注册项目（移植旧仓单测断言）
- [ ] `packages/core/package.json` 的 dependencies 为空（devDeps 除外）

## 完成判据
实现 + 门禁（vitest 绿 + 上述 grep 断言过）+ 逐卡 commit。验收由 verifier 独立复跑。
