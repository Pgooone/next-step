# 发行轨 A 独立验收（rel-a-verify）

> 2026-08-18 · verifier（opus，独立于实现者 haiku）· 验收对象：pi 扩展入口 + 发布准备。
> 这是发布前的最后一道闸，验收强度取发布级。所有命令均在验收会话独立复跑，非引用实现者输出。

## 一、门禁双跑（独立复跑）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit`（packages/next-step-pi） | 0 错（exit 0） |
| `npm test`（仓库根，monorepo 全量） | **20 文件 / 284 tests 全过**（exit 0） |
| `npx vitest run`（包内单独） | 16 文件 / 237 tests 全过（284 − 237 = 47 为 apps/web 侧，口径吻合） |

284 基线（T1-12/T1-13 口径）零回归 ✓。

## 二、胶水纯度审计（逐行，核心项）

`packages/next-step-pi/src/extension-entry.ts`（79 行，含 33 行注释）逐行读过：

- **import 面**：node 内置（crypto/path）+ pi **type-only** import + 三个已验收模块（ProjectRegistry / assembleDocSession / translateToolDef）。「本文件只 import pi 的类型」声称属实——grep 全包非测试文件，`@earendil-works` 运行时 import 仅 `src/pi/harness-adapter.ts:1`（CLI 壳路径，扩展加载闭包不经过：session-assembly 对它只有 type-import，jiti 转译即擦除）；且该 import 已被 peerDependencies `"*"` 声明覆盖，符合官方 packages.md「核心包 import 即列 peer 不打包」。
- **factory 主体（L34-55）**：五步全是对已验收模块的调用——`process.cwd()` → `new ProjectRegistry()` → `resolveProjectForCwd`（装配）→ `assembleDocSession({projectId, sourceActor:"pi-agent", cwd, sessionManager})` → 逐工具 `pi.registerTool(translateToolDef(tool))` → `pi.on("tool_call", assembly.toolCallGuard)`。
- **API 契约对照官方 docs/extensions.md**：default export 工厂签名 ✓；`pi.on("tool_call")` 返回 `{block, reason}` 拦截语义 ✓（官方 Quick Start 同款）；`pi.appendEntry(customType, data?)` 持久化且不进 LLM 上下文 ✓（官方 §pi.appendEntry 原文核实）；`registerTool` 的 execute 五参 → `{content, details}` 结构 ✓（translateToolDef 返回同构）。
- **sessionManager 轻量适配（L44-49）**：`appendCustomEntry` → `pi.appendEntry` 直传、返回 `""`。customType `"next-step"` 统一在 `createEntryAuditPort`（`src/ports/audit-port.ts:24`，T1-07 已验收）——适配层零判断 ✓。
- **守卫路径溯源**：`assembly.toolCallGuard` = `createManagedPathGuard`（`src/pi/session-assembly.ts:116-134`，T1-10 已验收）：拦 write/edit 受管路径、读类/非受管放行——判断全部在已验收代码，入口只接线 ✓。
- **`resolveProjectForCwd`（L63-79，入口里唯一新写的函数）**：评估为**装配策略而非领域判断**——「cwd → projectId」映射是 pi 扩展形态特有（扩展每次启动都加载，必须按 root 幂等复用），无法下沉 domain（domain 不知道 pi 生命周期）。关键声称逐项核实：
  - name 冲突错误码：`project-registry.ts:83` `throw new ProjectError("INVALID", "项目重名")` —— catch `e.code === "INVALID"` 兜底分支**接线正确** ✓；
  - 幂等复用：`registry.list().find(p => p.root === cwd)` —— 探针复跑实证（见 §四）。
  - **但该函数（尤其 catch 兜底分支）无任何自动化测试**：工作区无 extension-entry.test.ts，探针与冒烟均只覆盖 happy path（未注册 create + 已注册复用），「保证扩展加载永不因项目装配炸掉 pi 启动」的兜底分支从未被执行过 → **P2-①**。
- **装配结果字段消费**：`assembly.toolsWhitelist` / `excludeTools` 被入口丢弃（不注册到 pi）。核实为形态差异而非遗漏：详设 §5 的白名单 + excludeTools 是 `createAgentSession`（CLI 壳会话）机制；pi 扩展寄生宿主，registerTool 无法剥夺宿主内置 write/edit，防线 = 受管路径守卫（详设 §5.3）。S5④「受管路径直写被硬挡」语义在扩展形态下由守卫独立承担（冒烟脚本里的 `--tools` 白名单是脚本自加，非入口行为）→ **P3-①**（登记形态差异：扩展形态安全边界 = 守卫单层，CLI 壳 = 三层）。

**结论：纯胶水声明成立**——除装配函数（含兜底）外零新写判断，守卫/装配/审计每条路径均溯源到已验收代码。

## 三、发布面审计

### dry-run 复现

独立复跑 `npm pack --dry-run`：**24 文件 / 57.8 kB**，逐文件大小与 `rel-a-smoke/publish-files.txt` 完全一致（shasum `57e1926d06276804364abf11fd93df5916396b87`）✓。

### 逐文件核对（发布级）

- **完整性**：工作区 src/ 共 40 文件 = 23 个非测试文件 + 16 个 `*.test.ts` + `test-helpers.ts`。包内 23 个 src 文件与工作区非测试文件**精确一致，无遗漏、无多余**——`files: ["src", "!src/**/*.test.ts", "!src/pi/test-helpers.ts"]` 排除规则生效。
- **零测试文件** ✓；**零密钥/环境文件** ✓（`.env.pi-test` 被 gitignore 且不在 files 白名单；冒烟临时 models.json 的 apiKey 为 `$DEEPSEEK_API_KEY` 环境引用、未落盘——复核过磁盘文件内容）；**零 .impeccable / e2e / docs 杂物** ✓。

### package.json pi 字段对照官方 packages.md 逐条

| 规范条目 | 官方要求 | 本包 | 判 |
|---|---|---|---|
| pi.extensions | 相对包根路径 | `["./src/extension-entry.ts"]` | ✓（官方示例同款 `./` 前缀；文件在 files 白名单内） |
| keywords | 含 `pi-package` 可被发现 | 含（另 4 个语义词） | ✓ |
| peerDependencies | import pi 核心包即列 peer `"*"` 且不打包 | `@earendil-works/pi-coding-agent: "*"`，无 dependencies/bundledDependencies | ✓ |
| 运行时依赖 | 第三方依赖进 dependencies 供 npm install | 零第三方运行时依赖（node 内置 + 包内相对 + pi peer） | ✓（安装后无额外依赖） |
| 版本/命名 | — | `0.1.0` 首发合理；`@pgoone` scope 与登录账号 `pgooone` 一致（npm whoami 复核） | ✓ |

### pi install 视角完整性

安装后 jiti 加载 `src/extension-entry.ts` 所需的一切均在包内：guard-probe 用 **pi 自带同款 jiti** 从 src/ 直载入口成功（六工具注册 + 守卫挂载 + 真实存储断言全过）——传递闭包（extension-entry → session-assembly → doc-tools → domain/* + ports/* + tool-translation）全部命中包内 23 文件。另有真机 `pi --extension` 启动帧证据（见 §四）。

## 四、真机抽验（独立复跑）

- **装配探针复跑**：在全新 cwd（/tmp/rel-a-verify-probe）+ 实现者隔离 HOME 复跑 `guard-probe.mjs` —— **PASS**。本次走了 `resolveProjectForCwd` 的 create 注册路径（探针 cwd 未注册 → factory 注册 → 断言 2 按复用契约找到），加上实现者原跑覆盖的已注册复用路径，两条 happy path 均有实证。守卫断言全过：write/edit 受管路径 block（文案逐字一致）、read 放行、非受管路径放行。验收后已清理探针项目（隔离注册表恢复原样）。
- **pi 启动帧轻抽验（本验收独立执行）**：tmux 起 `pi v0.84.2 --extension src/extension-entry.ts`（隔离 HOME、不调真模型）——启动帧 `[Extensions] extension-entry.ts` 加载无报错 ✓。
- **smoke.pane 帧证据链核对（实现者留证）**：四类证据齐全且真实——
  1. 启动帧：`[Extensions] extension-entry.ts`（pi v0.84.2）；
  2. 汇总卡：「已决 0/1 块」初始帧 + y1 / a / Enter 逐键帧；
  3. 物化断言：v2 →（二轮场景）v3，versions 快照 + 物化文件正文（「修改后的需求段落。」→「（审计确认）」逐字演进）+ 隔离注册表含 rel-a-smoke 项目；
  4. 审计四条目：`artifact_proposed → approval_request → approval_response（via cli-keyboard，decisions accept）→ artifact_resolved（newVersion/sourceRefs）`，customType=next-step、sourceActor=pi-agent（入口传入值）、parentId 链完整、append-only 时序一致。
- **发现（P2-②）**：smoke.pane 含两个 wait_for 超时帧（L38「启动超时」/ L112「汇总卡未出现」）——逐帧核实为 **grep 模式与 TUI 实际渲染失配**（超时帧里 pi 横幅已渲染、汇总卡在超时同秒被下一 shot 捕获），非功能故障；pane 另含脚本外追加帧（「补按键后最终帧」「审计会话最终帧」等）——实现者手工补按键完成场景并追加二轮审计场景。证据链真实（时间戳/changeId/parentId 自洽），但 `tui-smoke.sh` 现状不可无人值守复跑 → 登记 P2，不阻塞发布（发布物是包，不是 QA 脚本）。
- **隔离 HOME 纪律** ✓：fd/rg 下载至 FAKE_HOME/.pi、注册表/会话 JSONL 均在 FAKE_HOME 下；仓库 git status 仅 `package.json` 修改 + `extension-entry.ts` 新增，与「唯一新增源码」声明一致，零仓库污染、零真实 ~/nextstep 污染。`.env.pi-test` 的 key 全程未进任何验收产出。

## 五、findings 分级

| 级 | 项 | 说明 | 处置 |
|---|---|---|---|
| P1 | — | 无 | — |
| P2 | ① 入口零自动化测试 | `resolveProjectForCwd` 的 catch INVALID 随机后缀兜底分支从未被任何测试/探针执行；「扩展加载永不炸 pi 启动」的声称缺兜底证据 | 发布后补 extension-entry 单测（含同名冲突场景） |
| P2 | ② 冒烟脚本不可无人值守 | wait_for 两处模式失配（`'>\|❯\|┃'` 与「已决 0/」未匹配实际渲染），场景靠手工补按键完成 | 修 tui-smoke.sh 等待模式；不阻塞发布 |
| P3 | ③ 扩展形态安全边界单层 | whitelist/excludeTools 不适用 pi 宿主（详设本就只约束 createAgentSession 形态），守卫独立承担 S5④ | 登记形态差异即可 |
| P3 | ④ appendEntry 适配返回 "" | 条目 id 被 AuditSessionManager 契约要求返回但适配面不消费 | 已注释声明，观察 |

## 六、发布放行结论

**可发布。**

- 门禁双跑全绿（typecheck 0 错 + 根 284/284 零回归）；
- 纯胶水声明成立：入口零领域判断，守卫/装配/审计全链溯源已验收模块，pi API 契约与官方文档逐条吻合；
- 发布面干净精确：24 文件 dry-run 复现一致、零测试/密钥/杂物、pi 字段与 peerDeps 逐条合规、安装后加载闭包完整（同款 jiti 探针 + 真机启动帧双证据）、scope 与 npm 账号一致；
- 真机抽验：探针独立复跑 PASS（两条 happy path 均实证）、smoke 帧证据链四类齐全真实。
- P2×2 均不触及包本身的正确性与安装后行为（一为防御分支缺测试、一为 QA 脚本自动化度），登记后放行，不构成发布阻断。

**haiku 质量一句**：实现质量高——纯胶水约束守得住（唯一新写函数是装配必需且兜底接线经核实正确）、发布面白名单精确到文件、隔离纪律与 key 不落盘全程到位；扣分在冒烟脚本等待模式失配靠手工补跑收尾、以及入口零测试覆盖未在产出中自行声明。

STATUS: PASS —— 门禁 typecheck 0 错 + 284/284 零回归；胶水纯度逐行核过（零领域判断、守卫/装配/审计全链溯源已验收代码、pi API 契约对照官方文档吻合、兜底错误码接线核实正确）；发布面 24 文件/57.8kB dry-run 复现一致、零测试/密钥/杂物、pi 字段与 peerDeps 逐条合规、安装闭包完整（jiti 探针独立复跑 PASS + 真机启动帧 [Extensions] 双证据）、@pgoone scope 与账号一致；smoke 帧证据链四类（启动/汇总卡/物化/审计四条目）真实齐全；P2×2（入口兜底分支零测试覆盖、冒烟脚本模式失配不可无人值守）+ P3×2 登记不阻塞，发布放行：可发布。
