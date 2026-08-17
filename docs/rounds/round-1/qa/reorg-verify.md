# B 单包化重组 · 独立验收报告（reorg-verify）

> 验收对象：ADR-001 裁决 B 的物理重组执行（工作区未 commit 改动，35 R + 4 D + 13 M + 1 新增 README）
> 宣称：逻辑零改动；git mv 保历史；契约文件删除、六动作类型内联；195/195
> 验收人：verifier（opus，独立于实现者 haiku）· 2026-08-18
> 方法：干净态门禁复跑 + 对照 HEAD 的字节级 diff 逐项证伪 + 独立 grep 结构纪律

---

## 一、干净态门禁复跑（PASS）

`rm -rf node_modules` → `npm install` → `npm run typecheck` → `npm test`，全部原文留痕：

- `npm install`：`found 0 vulnerabilities`（仅本机 allow-scripts 环境警告，与重组无关）
- `npm run typecheck`：`@pgoone/next-step-pi`（tsc --noEmit）+ `@pgoone/next-step-web`（tsc --noEmit）全过，零错误
- `npm test`：**`Test Files 14 passed (14)` / `Tests 195 passed (195)`**，Duration 1.51s
  - 构成：next-step-pi 13 文件 194 条 + next-step-web 1 文件 1 条
- lock 完整性：复跑前后 `package-lock.json` sha1 一致（`ed5d8263…`），install 未改写 lock
- **pi 精确 pin 确认**：`packages/next-step-pi/package.json` dependencies 为 `"@earendil-works/pi-coding-agent": "0.84.2"`（无 `^`/`~` 前缀）；lock 中 node_modules 条目 version/resolved 均为 0.84.2，全 lock 仅一处依赖声明（3519 行）同为精确 `0.84.2`

## 二、逻辑零改动逐项证伪（未证伪，成立）

43 个 diff 文件中内容实际变化的仅 13 个，逐一对照 HEAD 字节级 diff：

### 2.1 域文件逐字节比对（抽 5）

方法：`git show HEAD:<旧路径> | diff - <新路径>`，零输出 = 逐字节一致：

| 文件（新路径 src/domain/ 下） | 结果 |
|---|---|
| domain/pending-change-service.ts | **IDENTICAL** |
| gate/pending-gate-service.ts | **IDENTICAL** |
| audit/entries.ts | **IDENTICAL** |
| domain/artifact-service.ts | **IDENTICAL** |
| presentation/builders.ts | **IDENTICAL** |

其余纯 rename 文件（git stat 显示 0 改动）不在怀疑范围。**`file-name.ts` 疑点已查清**：git stat 标记 Bin，实测 HEAD 版本与工作区版本逐字节 IDENTICAL；文件含 1 个 NUL 字节（`\:*?"<>|\0-]` ——文件名非法字符表字符串字面量，属领域逻辑本身），HEAD 既有，非重组引入。副作用：git 对该文件不显示文本 diff，本次以字节级 diff 补证。

### 2.2 pi 侧 harness-adapter.ts（diff 实质 4 处，全部在授权范围内）

对照 `HEAD:packages/pi-ext/src/harness-adapter.ts` 字节级 diff，差异仅：

1. import 替换：`@pgoone/next-step-core` 类型块 → `../domain/gate/ports` 相对路径
2. 文件头注释 +2 行（ADR-001 B 契约废除说明）+ 若干 L1/L2 术语改为 domain/本层
3. **六动作数据类型内联**（31 行插入）
4. `createHarnessAdapter` 返回类型：显式 `HarnessAdapter & { dispose(): void }` → 推断；`const adapter: … = {` → `const adapter = {`（契约接口删除的必然后果，ADR 执行清单第 2 条）

**内联类型与被删契约文件逐字对照**（`git show HEAD:packages/core/src/adapter/harness-adapter.ts`）：
`JsonSchema` / `SessionStartOptions`（10 字段含全部行注释）/ `SessionHandle` / `AgentReply` / `NextStepToolDef` / `NextStepToolResult` / `SessionEntry` / `SubagentRequest` / `SubagentResult` / `ContextUsage` ——**类型本体逐字一致**；差异仅注释措辞（「L1 自有类型/由 L1 翻译」→「由本层翻译」，语义随契约废除非变即对）。`HarnessAdapter` 接口本体删除 = ADR 明令。

**签名漂移防线核实**：harness-adapter.test.ts 新增 `AdapterContractShape` 本地结构 type，其六方法签名与被删契约接口**逐字一致**（startSession/sendMessage/registerTool/readSessionStream/spawnSubagent/getContextUsage，参数与返回类型全同），测试保留「无第 7 个动作：签名无漂移」赋值断言。契约删除后编译器级对照消失，由该测试断言补位——防线未失守。

### 2.3 其余内容变化文件（全部仅 import 路径 + 注释 + 配置消亡）

| 文件 | diff 实质 |
|---|---|
| pi/harness-adapter.test.ts | import 改相对路径 + AdapterContractShape 内联（见上）；断言文案同步更名；**it 数量与逻辑零变化** |
| ports/audit-port.test.ts | 仅 3 处 import 路径 |
| pi/tool-translation.ts | 仅 1 处 import 路径 + 注释 L1→领域措辞 |
| ports/audit-port.ts | 仅 import 路径（audit 条目类型 → ../domain/...） |
| src/index.ts（原 pi-ext barrel） | `./harness-adapter` → `./pi/harness-adapter`；导出面三项不变 |
| src/domain/index.ts（原 core barrel） | 删 `export type * from "./adapter/harness-adapter"`（ADR 第 2 条）；ports/entries 两行保留 |
| tsconfig.json / vitest.config.ts | 与 `HEAD:packages/core` 版**逐字一致**；pi-ext 版的 `paths`/alias 跨包映射随包合并自然消亡，无多余删改 |
| 两级 package.json | pi 包：description 更新 + devDeps 删 `@pgoone/next-step-core: "*"` + pi 0.84.2 保持精确 pin；根：仅 description 更新 |

### 2.4 ports.test.ts 修改裁决（重点核查项，裁决：正确）

HEAD 版第三条红线断言是「**packages/core 的 package.json 依赖表**零 `@earendil-works/*`」（锚点 `../../package.json` 指向 core 包——包边界语义）。单包合并后 core/package.json 已删，`../../` 将指向 next-step-pi 自己的 package.json——而它**必须**依赖 pi（pi 扩展包），原断言在新形态下必挂且语义失效。锚点 `../../` → `../`（指 src/domain/ 目录）+ 断言改写为「扫 src/domain/ 生产源码零 `@earendil-works` 字面量」。

裁决三点：

1. **语义改写正确且更强**：HEAD 只查依赖表（源码写了 pi import 但未加依赖时该测试不报警，靠 typecheck 兜底）；新版直接扫源码文本，import 与裸引用都抓，且覆盖 domain 下全部生产源码（含未来新增文件，HEAD 的 CARD_FILES 白名单反而只锁 5 个文件）。
2. **豁免 `.test.ts` 有真实依据、非借口**：grep 证实 `pending-gate-service.test.ts:489-494` 与 ports.test.ts 自身的守卫断言**字面量**就含 `@earendil-works`（`not.toContain` 的断言字符串），不豁免则守卫自伤——这是字面量断言法的固有限制。
3. **豁免未波及生产源码**：过滤器 `f.endsWith(".ts") && !f.endsWith(".test.ts")`，所有非 test 的 .ts 均被检查；README.md 非 .ts 自动跳过。verifier 独立 grep 交叉证实：domain 下 `@earendil-works` 命中仅 README.md（文档描述）与两个 .test.ts（守卫字面量），**生产源码零命中**。

遗留弱化见 P2-2。

## 三、结构纪律（PASS）

- **domain 生产源码零 pi import**：独立 grep `packages/next-step-pi/src/domain/` 全目录，生产源码零命中（命中仅 README + 2 个 .test.ts 守卫字面量，见 2.4）
- **旧目录零残留**：`packages/` 下仅 `next-step-pi`；`packages/core`、`packages/pi-ext` 目录已不存在（find 报 No such file）
- **lock 零旧包名**：`next-step-core` / `pi-ext` 在 package-lock.json 中零命中
- **apps/web、pi-fork 零改动**：`git diff HEAD --stat -- apps/ pi-fork/` 为空
- **diff 无越界**：全部改动路径落在 `packages/{core,pi-ext,next-step-pi}` + 根 `package.json`/`package-lock.json`，无其他文件

## 四、文档同步核对

- **qa/ 报告零改动**：`git diff HEAD --stat -- docs/rounds/round-1/qa/ docs/rounds/round-1/adr/` 为空——七份 verifier 报告与 ADR 作为历史留痕未被触碰（正确）
- **progress.md / 根 README**：实测两处**本来就不含** `packages/core`、`pi-ext`、`next-step-core` 具体路径（progress.md 用卡片编号表述、README 目录表用 L0-L3 层级词），零改动 = 零需要，无遗漏
- **tasks/ 卡片**：含旧路径但属历史任务卡（已完成卡的验收锚点），未改动（正确）
- **缺口**：见 P2-1

## 五、Findings 分级

### P1（阻断）——无

### P2（应补，不阻断代码合并）

1. **ADR-001 执行清单第 4 条未在此工作区执行**：正本 F5 修订（「包边界」→「文件夹边界」）与 ROADMAP「三服务→Package」节同步未做。旧双包路径仍存于：`docs/rounds/round-1/ROADMAP.md:53,55`、`design/high-level-design.md:62,131,161`、`design/detailed-design.md:193,247`。若 lead 计划另行挂卡处理需显式记录，否则属执行清单欠账。
2. **domain 测试文件的 pi import 从「物理不可能」弱化为「无自动检查」**：HEAD 形态下 core 包依赖表零 pi，.test.ts 想违规 import 也编译不过；单包合并 + 字面量断言豁免 .test.ts 后，此防线消失（ADR-001 B 已接受「软纪律 + code review」，故不阻断；可在后续卡加 import-analyzer/linter 级防线补齐）。

### P3（观察记录，无需动作）

1. `file-name.ts` 含 NUL 字节（文件名非法字符表字面量，HEAD 既有），git 视为二进制、不显示文本 diff——本次已字节级补证一致；后续该文件的 diff 审查需同样走 `git show | diff -` 通道。
2. 根 README「L1 纯 TS 内核 / L2 pi 扩展」为分层词汇表述，随正本 F5 修订联动更新即可，当前无错误路径指向。
3. 新增 `src/domain/README.md`（3 行软纪律说明）质量合格：与 ports.test.ts 红线测试互相指认，一处说纪律一处固化自检。

## 六、对实现者（haiku 档）产出质量的评价

物理重组类任务交给 haiku 档是合适的：43 文件无一越界改动，13 个内容变化文件的每一处 diff 都能追溯到 ADR 执行清单条款，六动作类型内联做到与被删契约逐字一致，且在测试侧自发补上 AdapterContractShape 保住签名漂移防线——超出「机械搬运」的下限预期；扣分点是自述模糊（ports.test.ts 的历史演变说不清，需 verifier 重建）与 ADR 清单第 4 条文档同步未做也未申报。结论：haiku 可继续承接此类边界清晰的重构，但交付说明需 lead 或 verifier 复核兜底。

---

STATUS: PASS —— 干净态 195/195 + typecheck 全绿 + pi 0.84.2 精确 pin；5 核心域文件逐字节一致、harness-adapter 仅授权范围 4 处差异、内联类型与被删契约逐字同、ports.test.ts 改写裁决正确且更强；结构纪律全过；P2 两项（ADR 清单 4 文档同步未做、domain 测试 pi import 防线弱化）挂账不阻断。
