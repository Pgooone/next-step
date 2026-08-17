# T1-01 独立验收复核（verifier）

> 复核对象：`docs/rounds/round-1/tasks/T1-01-monorepo骨架与路径常量.md`
> 实现产出：根 `package.json` / `tsconfig.base.json` / `vitest.config.ts` / `packages/core/` / `packages/pi-ext/` / `apps/web/` / `pi-fork/README.md`
> 复核时间：2026-08-17 22:18–22:25 ｜ 方式：干净态复跑 + 自写驱动断言（不引用实现者测试）+ 红线审计
> 环境：npm（无 pnpm），node ≥20，Linux/WSL2

---

## 一、干净态复跑门禁

| 步骤 | 命令 | 结果原文（关键行） |
|---|---|---|
| 清空依赖 | `find . -name node_modules -type d -not -path './重构前文档/*' -prune -exec rm -rf {} +` | 全部 node_modules 移除，`ls node_modules` → No such file or directory |
| 重装 | `npm install` | `found 0 vulnerabilities`，exit 0（仅 esbuild postinstall 被 allow-scripts 拦的 warning，不影响运行） |
| 类型检查 | `npm run typecheck`（根，`--workspaces --if-present`） | core / pi-ext / web 三包 `tsc --noEmit` 全过，exit 0 |
| 全仓测试 | `npm test`（根，vitest projects: `packages/*`、`apps/*`） | `Test Files 4 passed (4)` `Tests 18 passed (18)`，exit 0 |
| 包内独立 | `cd packages/core && npm test` | `Test Files 2 passed (2)` `Tests 16 passed (16)`，exit 0 |

**结论：干净态门禁全绿。**

---

## 二、卡验收断言独立验证（自写断言）

### A. H1 单点常量

| # | 断言 | 命令 | 结果 |
|---|---|---|---|
| A1 | `"nextstep"` 字面量仅出现在常量定义与其测试 | `grep -rn '"nextstep"' packages/ apps/ pi-fork/` | 仅 2 命中：`packages/core/src/config/paths.ts:8`（定义）、`paths.test.ts:6`（断言）✓ |
| A2 | core 源码零 `.pi` 字面量 | `grep -rn '\.pi\b' packages/core/src/` | 零命中 ✓ |
| A3 | ProjectRegistry 引用常量而非字面量 | `grep -n 'NEXTSTEP_DIR_NAME\|nextstep\|\.pi\b' packages/core/src/domain/project-registry.ts` | 仅 `:12`（import）与 `:35`（`join(homedir(), NEXTSTEP_DIR_NAME, "projects.json")`）；`:33` 为注释描述，非代码 ✓ |
| A4 | （追加）编译产物零 `.pi` 残留 | 独立 tsc 编译产物上 `grep '\.pi\b'` | 零命中 ✓ |

### B. L1 纯洁（B1 包级保证）

| # | 断言 | 命令 | 结果 |
|---|---|---|---|
| B1 | core 无 earendil / pi-coding-agent 痕迹 | `grep -rni 'earendil\|pi-coding-agent' packages/core/` | 零命中（连注释都无，强于卡面「除注释说明」）✓ |
| B2 | core 零 dependencies | 读 `packages/core/package.json` | `dependencies = undefined`（字段不存在）；devDeps 仅 `@types/node` / `typescript` / `vitest` ✓ |

全仓依赖清单复核（根 / core / pi-ext / web）：dependencies 全空，devDeps 仅 typescript / vitest / @types/node——无数据库、无组件库。

### C. 旧仓行为回归（搬运保真）

**C1 · 源码逐行 diff**（旧仓 `Next-Step/next-step-V1.2/lib/domain/project-registry.ts` vs 新 `packages/core/src/domain/project-registry.ts`）：

```diff
+import { NEXTSTEP_DIR_NAME } from "../config/paths";
-/** 默认注册表位置：~/.pi/projects.json（与 docs/02、docs/05.1 一致）。 */
+/** 默认注册表位置：~/.nextstep/projects.json（随用户级目录常量，脱离旧仓数据目录）。 */
 export function defaultRegistryPath(): string {
-  return join(homedir(), ".pi", "projects.json");
+  return join(homedir(), NEXTSTEP_DIR_NAME, "projects.json");
 }
```

仅此两处，`Project` / `ProjectError` / `normalizeRoot` / `list` / `get` / `create` / `update` / `remove` / `validateRoot` / `writeAll` 全部逐行一致——正是卡要求的「搬 + 适配（`.pi` → 常量）」。

**C2 · 独立驱动断言**（不引用实现者测试：源文件复制到 `/tmp/t1-01-verify/`，独立 `tsc --strict` 编译——编译本身即过——后用 node 驱动，12 断言全 PASS，exit 0）：

| 断言 | 结果 |
|---|---|
| `NEXTSTEP_DIR_NAME === "nextstep"`（卡规定值） | PASS |
| `list()` 文件不存在返回 `[]` 且不创建文件 | PASS |
| `create()` 落盘后 `list()` 含项目、`get()` 命中返回同一对象（uuid/ISO 时间戳） | PASS |
| `get()` 未知 id 抛 `ProjectError(NOT_FOUND)` | PASS |
| `create()` 空 name / 重名 / root 不存在（默认不触盘）抛 `INVALID` | PASS（3 条） |
| `list()` 损坏 JSON 抛 `INVALID` | PASS |
| `remove()` 只移注册项、磁盘目录仍在、重复 remove 抛 `NOT_FOUND` | PASS |
| `defaultRegistryPath() = join(homedir(), NEXTSTEP_DIR_NAME, 'projects.json')`（常量驱动） | PASS |
| `normalizeRoot()` 展开 `~` 与 `~/`（旧仓行为） | PASS |
| 原子写后无 `.tmp-*` 残留 | PASS |

### D. 占位包最小性

- `packages/pi-ext/`、`apps/web/`：各 1 个纯注释占位 `index.ts` + 1 个 `1+1` 空壳测试 + package.json/tsconfig/vitest.config 三件套，无投机代码（find 全量文件清单核对）。
- `pi-fork/`：仅 `README.md`（UPSTREAM 纪律 + 目录规划），零源码。

---

## 三、红线审计

| 红线 | 验证 | 结果 |
|---|---|---|
| 未改动 `重构前文档/` | `git status --porcelain 重构前文档/` | 零输出 ✓ |
| 未改动 `docs/`（T1-01 范围内） | `git status` / `git diff HEAD` | 见下方流程提醒 P3-2 ✓（唯一一处 docs 修改系验收期间 lead 侧流程文档更新，非实现产出） |
| 无数据库 / 组件库引入 | 全部 4 个 package.json 依赖清单 | 仅 typescript / vitest / @types/node ✓ |
| tsconfig strict 真开 | `tsconfig.base.json` `"strict": true`，三包均 `extends`；另以独立 `tsc --strict` 编译 core 源码通过 | ✓ |
| `.gitignore` 卫生 | vitest 缓存（`packages/core/node_modules/.vite/...`）被 `node_modules/` 规则覆盖 | `git check-ignore` IGNORED ✓ |
| fork 内核不实际引入（D1） | `pi-fork/` 仅 README | ✓ |

---

## 四、发现的问题

无阻塞问题。三条 P3 记录（不构成 FAIL）：

- **P3-1（跨卡张力，留给 H1 实证）**：`NEXTSTEP_DIR_NAME = "nextstep"` 无点前缀，故 `defaultRegistryPath()` 现值为 `~/nextstep/projects.json`，而概要设计 §5 D9 表格写 `~/.nextstep/`（带点）。常量值系任务卡原文规定，实现与卡一致；且单点结构保证 fork 实证后改常量一处即可全仓跟随。**提醒**：T1-08/T1-09（发行轨 fork 实证）须显式裁决常量终值（`nextstep` vs `.nextstep`），并同步核对 fork `CONFIG_DIR_NAME` 的真实拼接行为。
- **P3-2（流程提醒，给 lead）**：`docs/rounds/round-1/tasks/README.md` 存在一处未提交修改（mtime 22:22:50，晚于实现落盘 22:18，内容为补「UI 卡须智谱识图核验」验收纪律）——系验收期间 lead 侧流程更新，非实现者改动。逐卡 commit T1-01 时勿将此文件混入本卡 commit。
- **P3-3（建议）**：tsconfig 未开 `noUncheckedIndexedAccess`（卡面未要求，仅记录）；core devDeps 含 `@types/node`，超出卡面写的「typescript / vitest」两项，但为 `tsc --noEmit` 校验 node API 所必需，属工具链类型而非运行时依赖，可接受。

---

STATUS: PASS —— 干净态门禁全绿，卡断言独立验证通过，红线无违反
