# Next-Step 重构 · 需求文档（v3.4 · 正本）

> **本文档是唯一真相源（正本，权重最高），覆盖之前所有需求草稿。** 若其他文档与本文冲突，以本文为准。
> **v3.4：D1–D10 已于 2026-08-17 全部拍板（§9），各条目结论就地生效。** 拍板对话留痕附于 §9 每条之后。
> 本版已并入：用户原稿（2026-08-16）+「改写版需求文档」「需求交接稿」「D1 地基选型实证」（见 `参考/`）的全部有效增量；交叉审查记录见 §12。
> 旧实现仓库：实际位于 `/home/pgoone/GitHubproject/Next-Step/next-step-V1.2/`（本机已核对，2026-08-17；原文档称 `next-step-app/`，§7 与附录 A-5 的路径锚点均指此目录）。上游内核：`@earendil-works/pi-coding-agent` + `pi-ai`（npm，MIT，`github.com/earendil-works/pi`；旧仓声明 `^0.79.0`，上游最新 0.84.x）。

---

## 0. 一句话

**Next-Step v2.0 是一条本地多 Agent 产线：把「一句想法」变成「可动工的设计包 + 可评审的原型」；每一步产物受管、可逐块签字、可追溯到上游；成品出缺陷时系统能沿追溯链归因到具体阶段、改完只重跑下游；跑顺的队伍与经验沉淀为可复用的 Recipe 与 Skill。**

使命：让一个人用一队 AI，稳定产出**别人敢接手动工**的设计包与原型——过程全程可见、每步可签字、出错可归因、经验可复用。

## 1. 本次重构要解的三条机制性缺失（病根）

漂移的根因不是「功能加多了」。只重写代码不补这三条，v2.0 会以更快速度再漂移一次。

- **P1 · 没有主干判据**——任何功能都能被论证「有用」。对策：立三根柱子（**产能 / 可控 / 可追溯返工**），任何新功能必须写明落在哪根柱子、让哪条 AC 从红变绿；写不出，不做。
- **P2 · 概念膨胀**——Agent 档案 / agent 模板 / skill / pipeline 蓝图 / 队伍模板 / 主脑 plan，六个近义词各做一半。对策：§3 最小对象模型，六并二。
- **P3 · 没有追溯链**——「缺陷归因」在物理上不可能（V1.2 砍掉的 RTM 正是它的地基）。对策：M2 块级 `sourceRef` 最小追溯链。**这是 v2.0 唯一真正的新地基。**

> ⚠️ 常见误读：用户原稿把这条写成「断点续跑」。「从阶段重跑」已交付（人来定位、系统重跑）；本条要的是**系统来定位**。前者是编排问题（已解决），后者是追溯问题（未解决），不得混淆。

## 2. 北极星：不可协商约束

### 2.1 继承前提

| # | 前提 | 状态 |
|---|---|---|
| F1 | 一切落盘产物的改动，必经「提案 → 逐块确认 → 新版本」 | 🔒 产品定义 |
| F2 | 大动作前有计划闸；失败最多自重试 1 次，然后停下给选项 | 🔒 产品定义 |
| F3 | 本地优先、纯文件、无数据库、单用户 | 🔒 产品定义 |
| F4 | 内核策略：fork 0.84.2 为基线，**改动只限品牌与发行层**；领域逻辑全走扩展/SDK 层；loop 级改动单独评审（D1 已拍板） | 🔒 已拍板（D1） |
| F5 | 领域逻辑与 pi 接线、UI 解耦——**单包内文件夹边界**（`src/domain/` 零 pi import、零 UI import，靠目录约定 + code review 强制，ADR-001 裁决 B）；领域逻辑绝不被客户端 value-import | 🔧 实现约定（2026-08-17 ADR-001 修订：原「包边界」改「文件夹边界」） |
| F6 | 每条需求必须有可断言的验收标准，否则不进范围 | 🔧 实现约定（本期强制） |

### 2.2 本期新增红线（可被机械检查）

- ❌ 归因、沉淀、评测三类模块**只读 + 只提案**，无写权。
- ❌ Recipe / Skill / Agent 档案的改动，走与产物**同一条**确认通道（D3 已拍板：手动提案制）
- ❌ 上游存在未确认的待确认变更时，不得启动下游或重跑。
- ❌ 追溯链断链必须显式报告断链位置，不得由模型猜测补齐。
- ❌ 并行 run 不承诺归因与重跑（N8；D7 已拍板：并行编排暂停到 v2.2）。
- ❌ 不引入组件库制造第二设计范式；不做全量内联样式迁移。
- ❌ 内核 fork 改动只限品牌与发行层（TUI 字样、包名、CLI 命令名、数据目录）；**内核 diff 最小化 + UPSTREAM 对照纪律**；任何 loop 级改动须单独评审并逐条登记内核 diff 清单（D1 已拍板）。
- ⚠️ 每条新需求必须写明：落在哪根柱子 + 让哪条 AC 从红变绿。写不出 → 不做。

## 3. 最小对象模型（概念减法）

四个实体 + 两个可复用资产，除此之外不新增名词。

| 对象 | 定义 | 落盘 |
|---|---|---|
| Project | 一个工作区 = 一个目录 | 项目根 |
| Stage | 产线上的一步：谁做、做什么、**验收标准（必填、可断言）**、依赖谁 | run 内 |
| Agent | 可持久化档案：角色 + 模型 + 技能 + 工具 + 模式 + 思考强度 | `.pi/agents/` |
| Artifact | 受管产物：内容 + 版本链 + **块级来源引用 sourceRef** + 归属 stage | `.pi/artifacts/` |
| **Recipe（配方）** | 可复用产线：有序 Stage + 每步队员（池挑 ∪ 内联规格）+ 验收标准 + 执行模式 | `.pi/recipes/` |
| **Skill** | 可复用做法：给 Agent 加载的过程性知识，带版本 | `.pi/skills/` |

旧概念映射（这就是减法本身）：

| 旧概念 | 归入 | 说明 |
|---|---|---|
| pipeline 蓝图（第七轮） | Recipe | 蓝图 = 只含池挑、无验收的 Recipe 子集 |
| 队伍模板（第十三轮） | Recipe | 同一形状的超集/子集，**合并重写为 recipe-store，一次性迁移不并存** |
| 主脑 plan（第 8.6 轮） | Recipe（未落盘的一次性实例） | AI 拟的 Recipe，确认后可另存 |
| agent 模板 / 导入导出 | Agent 的序列化格式 | 不是新对象，是 Agent 的一种表示 |
| 工作流 / preset | 删除 | 与 Recipe 重复 / 外来词 |

> 收益：「一键构建持久化 agents，来源包括且不限于 skills、工作流或其他」这条无法验收的需求，拆成两条可断言操作：**从 Skill 派生 Agent**、**从 Recipe 某个 Stage 提取 Agent**。**禁用「包括且不限于」——它是把猜测写进合同。**

## 4. 范围与里程碑

范围纪律：重构与扩范围不能同时做。v2.0 止于「可评审原型 + 可交接设计包」；「可上线」靠 v2.2 交接契约，不自建部署链。

| 里程碑 | 完成的定义 | 含 |
|---|---|---|
| **v2.0 · 产线可信** | 一句想法 → 设计包 + 原型；全程逐块签字；缺陷可归因到阶段并只重跑下游 | M1 M2 M3 M4 M6 |
| **v2.1 · 经验可复用** | 跑顺的队伍存成 Recipe 一键复用；对话经验沉淀为 Skill（提案制） | M5 + Recipe 市场雏形 |
| **v2.2 · 交接可上线** | 设计包能被外部编码 Agent（Claude Code / dsh / 人类团队）零翻译消费 | 交接契约 + 验收清单导出 |

**明确不做（本期）**：N1 自建部署/CI/密钥；N2 迁 dsh 或自建全新 web 端（只借 dsh 两条设计：append-only 日志按来源可检视 + 审批即服务）；N3 无人确认自动改写档案/技能（破 F1）；N4 参数/代码级自进化（无评测信号）；N5 完整 RTM 矩阵（只做块级 sourceRef）；N6 多用户/云端（破 F3）；N7 拖拽节点图画布（清单式已够，留 v2.2，D7 已拍板：暂停到 v2.2）；N8 并行 run 的归因与重跑（并行破坏累积喂下游，归因失效）。

## 5. 技术地基与分层（一核两壳）

**一句话架构**：领域逻辑全部住在一个**不认识 UI、也不认识 pi** 的纯 TS 内核里；一层薄适配层把它接到 pi 的官方 Hook 上；CLI 和 Web 只是两个壳，共享同一份会话 JSONL。改基座 = 只改内核，两壳不动。

| 层 | 放什么 | 依赖约束 | 怎么测 |
|---|---|---|---|
| L0 上游 pi | agent loop、会话树、内置工具 | **fork 基线 0.84.2，改动只限品牌与发行层**（D1 拍板）；领域逻辑不得进入 L0；loop 级改动单独评审 | — |
| L1 `src/domain/`（单包内文件夹） | diff 解析、sourceRef 血缘图、提案状态机、重试策略、doc/coding 模式规则、闸门判定、归因算法 | **零 pi import、零 UI import**（文件夹边界，ADR-001 裁决 B） | 纯单测，不需模型不需界面 |
| L2 `src/pi/`（单包内文件夹，唯一 import pi 处） | registerTool / registerCommand / tool_call 拦截 / tool_result 改写 / appendEntry / 事件订阅 | **只有这些文件 import pi**（无显式适配器接口，接线为普通模块——ADR-001） | `SessionManager.inMemory()` + stub 模型 |
| L3 两个壳 | CLI 壳 = pi 本体；Web 壳 = pi-web（只读起步）→ 薄壳（M5 起补写入） | 只读会话条目；**不得包含任何领域判断** | 手动 / E2E |

分层健康的单一标准：**删掉 Web 壳，CLI 什么也不少；删掉 CLI 壳，Web 什么也不少。**

### 5.1 HarnessAdapter（恰好 6 个动作，不预留）

起会话 / 发消息 / 注册工具 / 读会话流 / 派子 Agent / 取上下文用量——pi SDK 各有 1:1 落点（`createAgentSession()` / `session.prompt()` / `pi.registerTool()` / `session.subscribe()`+`ctx.sessionManager.getEntries()` / 官方 subagent example / `context` 事件）。Adapter 不是为换地基预留的抽象税，它现在就有能跑的实现。

### 5.2 双前端三条强制规约

1. **交互端口 DecisionPort**：闸门绝不直接调 `ctx.ui`。L1 只依赖 `DecisionPort.ask(req) → Decision`；L2 提供 `CliDecisionPort`（`ctx.ui.select/confirm/input`）与 `EntryDecisionPort`（`appendEntry({type:"approval_request",status:"pending"})` → 等 `approval_response` 条目）。副作用是正面的：每条裁决落入 append-only 日志，M2/M6 直接复用。**冻结注记（2026-08-17 拍板）：EntryDecisionPort 的跨端实时唤醒（CLI 进程挂起等待 Web 写回条目）冻结至第四期**——pi 无跨进程事件推送，需自建文件监视握手（依据 `qa/pi-cross-process-sync-investigation.md`）；第一期确认一律作用于**存储态 PendingChange**（旧仓模式：propose 落盘、resolve 独立动作，CLI/Web 是同一领域服务的两个客户端，数据层天然同步，零握手）。
2. **presentation 是数据，不是代码**：自定义条目 payload 自带纯数据 presentation（title/badges/rows/diffRef），两前端各写一个**通用渲染器**；新增条目类型时两个前端都不用改；回放与直播一致。
3. **单 writer**：一个 session 同一时刻只有一个 writer；Web 想「写」就 `fork(entryId, {position:"at"})` 出自己的分支。不为双写引入数据库（破 F3）。

### 5.3 唯一真相：会话 JSONL

`~/.pi/agent/sessions/*.jsonl` 是全部状态载体。CLI 跑的会话 Web 能回放；Web fork 的分支 CLI `/tree` 能看到；`appendEntry` 的自定义条目在同一文件且**不进 LLM 上下文**——这是双前端共享领域数据的官方通道，也是 M2 sourceRef 的存储落点。

### 5.4 pi 官方落点速查（已实证，勿重开调研）

事件流全序：`input → before_agent_start → agent_start → message_* → turn_start → context → before_provider_* → after_provider_response → tool_execution_start → tool_call → tool_execution_update → tool_result → tool_execution_end → turn_end → agent_end → agent_settled`。
`tool_call` 可 `{block:true,reason}` 拦工具、可改写 input；`tool_result` 可改写结果（middleware 链）；`tools` 白名单/`excludeTools`/`noTools` 从能力层物理禁用 write/edit；内置 `edit` 返回 `details.patch`（标准 unified patch）；`fork(entryId)`/`importFromJsonl()` 撑起重跑与血缘。

**官方 examples 挂载点对照**（仓库 `earendil-works/pi`，路径 `packages/coding-agent/examples/extensions/`）：

| 官方 example | 它演示什么 | 我们的挂载点 |
|---|---|---|
| `subagent/` | 派子 Agent 的最小机制（spawn/回收/结果聚合） | M4 编排「派子 Agent」动作（HarnessAdapter 第 5 动作） |
| `plan-mode/` | 「先拟计划、确认才执行」的计划闸 | submit_plan 确认闸（F2）的最小范式 |
| `permission-gate.ts` | tool_call 拦截 + `ctx.ui.confirm` 人工放行 | F1 闸门 / CliDecisionPort 的写法范式 |
| `protected-paths.ts` | 路径保护（禁写敏感路径） | doc 模式禁写语义的参照；受管文档保护可叠加同机制 |
| `sandbox` | 沙箱执行 | 参考，不纳入本期 |

### 5.5 生态包盘点（2026-08-17 npm 实证，勿重开调研）

**结论先行：无一能做语义级 drop-in**（计划闸 / 受管文档 / sourceRef 归因是我们独有的领域语义）；但下列包可作实现参照或机制底座，能省工程时间。

| 包（npm，均 MIT） | 状态 | 对应模块 | 裁定 |
|---|---|---|---|
| `pi-subagents@0.50.0`（活跃，2026-08-15 更新） | 委派工具 + 前后稿子 Agent + 内置 scout/researcher/worker/reviewer/oracle | M4 编排 | **作 HarnessAdapter「派子 Agent」动作的实现参照/底座评估**（子会话 spawn/回收/结果聚合的工程细节已解决）；其「LLM 自由决定委派」模型与我们 F2 计划闸（人确认才派）语义不同，不直接采用 |
| 官方 `examples/extensions/subagent`、`plan-mode` | 官方最小参照（实证 2026-08-12 核） | M4 / F2 | **抄模式**：plan-mode 的「先拟计划、确认才执行」即 submit_plan 闸的最小实现范式 |
| `pi-permissions@1.0.4` / `pi-permission-system@0.8.0` | 工具调用级 allow/deny 规则门 | F1 闸门 | **参照**其 tool_call 拦截 + ctx.ui 交互写法；不管 PendingChange 块级确认，不能当 F1 用 |
| `oh-my-pi@0.2.0`（2026-06 后未更新） | prompt 级编排（替换系统提示的协调者） | M4 | **不采用**：prompt 级编排 ≠ 机制级编排（我们是 submit_plan 工具 + run 存储 + 编排器）；仅作反面对照 |
| `@agegr/pi-web@0.8.9` / `pi-web@0.14.3`（jmfederico，需 pi≥0.83）/ `@kkkiio/pi-web-ui@0.1.1` | 三个 Web 壳候选 | 第四期 Web 壳 | **已全部出局（D8 后续拍板 2026-08-17）：完全自建薄壳**；壳零领域判断红线不变 |
| Pi Package 机制本身（`pi install npm:<pkg>`，含 skills/prompts/extensions manifest） | 官方分发通道 | M5 / Recipe 分发 | **直接可用**：Skill/Recipe 的打包分发不自建，产出自 pi 官方包格式 |


## 6. 模块需求与验收标准

### M1 · 受管产物与「diff 工具化」

**沿用（迁移，不重写）**：`artifact-service`、`pending-change-service`、`lcs.ts`、块级绿/红/黄高亮、逐块 ✓/✗、版本链、回滚、外部手改检测（EXTERNAL_MODIFIED）、ArtifactPanel。这三个服务是唯一被二十轮验证过的资产。

**真新增**（把 diff 从人看的 UI 变成 Agent 可读的工具返回值）：
- `get_artifact_diff(artifactId, fromVersion, toVersion)` → 结构化变更块列表（含 sourceRef）
- `list_my_artifacts()` → 当前 Agent 名下产物 + 当前版本 + 最近改动摘要
- `get_artifact_history(artifactId)` → 版本链 + 每版归属 stage/agent

| AC | 内容 |
|---|---|
| AC-1.1 | 任一 doc 模式 Agent 可在会话中调用三个只读工具拿到结构化结果，无需人工粘贴 |
| AC-1.2 | Agent 调用 get_artifact_diff 后能正确说出「上一版改了哪几块」，与 UI 块数一致 |
| AC-1.3 | doc 模式 Agent 工具集中**不存在** write/edit；任何写入只能经 propose_edit |
| AC-1.4 | 三个新工具只读，不产生 PendingChange |

**官方参照**（附录 A-2）：内置 `edit` 工具返回 `details.patch`（标准 unified patch，SDK 消费者专用）——diff 展示不自己解析文本；doc 禁写用 `tools` 白名单 / `excludeTools` / `noTools` 能力层禁用（非 prompt 约束）。

### M2 · 追溯链与缺陷归因 🔴 本期唯一新地基

- 产物块携带 `sourceRef: { artifactId, version, blockAnchor }[]`；**由工具写入而非模型输出**；存储落 `appendEntry` 自定义条目（持久化、不进上下文）。
- Stage 的验收标准升为**必填结构化字段**（每条可断言）。
- 归因工具 `trace_defect(artifactId, blockAnchor | 自然语言描述)` → 该块上游链条 + 每环验收标准 + **最早偏离点候选**（带置信度与依据）。

| AC | 内容 |
|---|---|
| AC-2.1 | 原型产物任一块可回溯到详细设计具体段落、再回溯到需求具体条目（三跳可达） |
| AC-2.2 | 给定「原型缺少深色模式」，trace_defect 能定位到「详细设计 v1 未覆盖需求 #Y」并给出 file/anchor 级证据 |
| AC-2.3 | 追溯链中断时归因结果必须**显式报告断链位置**，不得猜测 |
| AC-2.4 | 归因只输出判断与依据，不自动改任何产物 |

### M3 · Agent 与 Recipe

**沿用**：`agent-profile-store`（model/skills/tools/thinkingLevel/mode）、AgentManager。**doc/coding 双模式保留但改造**（裁决见 §9 D10）：默认 doc（最小权限）；coding = 原始 write/edit/bash **且同样配发受管文档工具族**（补旧设计缺口：旧 coding 队员拿不到 create_artifact，追溯链会在原型阶段断链；EXTERNAL_MODIFIED 机制保证 coding agent 绕开提案直写受管 `.md` 会被下次提交检测并拒绝）。**合并重写**：`pipeline-store` + `team-template-store` → 统一 `recipe-store`（一次性迁移，不并存）。

**新增**：Agent 序列化导入导出（JSON，含技能**引用**而非副本）；从 Skill 派生 Agent；从 Recipe 某个 Stage 提取 Agent 入池；Agent 档案变更走与产物同一条确认通道（D3 已拍板：手动提案制——触发源是用户手动发起，确认通道与产物同一条）。

| AC | 内容 |
|---|---|
| AC-3.1 | 导出的 Agent 清空本地后可完整导入并跑出同样行为（模型不可用时明确报错，不静默降级） |
| AC-3.2 | 旧 pipeline.json 与旧队伍模板一次性迁移为 Recipe，迁移后旧路径不再被读取 |
| AC-3.3 | 改 Agent 档案产生待确认变更，确认后生成新版本，可回滚 |

### M4 · 编排与归因驱动重跑

**沿用**：`mastermind-orchestrator`（计划闸、失败暂停给选项、上游累积喂下游、retry 2 attempt、paused 四抉择、僵尸对账）、从阶段重跑与 run 血缘（inclusive/exclusive 两模式三守卫）、运行历史面板。45KB 单文件**先补测试再按职责拆分**。

**新增**：Stage 从一次性对象升为「引用 Recipe 中的一步」（跨 run 对齐同一步）；重跑入口增加**归因驱动**路径：trace_defect 结果可一键「从这一步重跑」。

**官方/社区参照**（附录 A-2/A-3）：计划闸范式抄官方 `examples/extensions/plan-mode`；子 Agent 派生机制评估 `pi-subagents`（npm）与官方 `examples/extensions/subagent`；重跑/血缘用 `fork(entryId, {position:"at"})` / `importFromJsonl()`，不自建版本模型。

| AC | 内容 |
|---|---|
| AC-4.1 | 从归因结果一键重跑：`<K` 阶段复用已确认产物最新版本，`≥K` 阶段重新生产 |
| AC-4.2 | 源 run 只读、深拷；新旧 run 在历史面板并列且血缘可见；刷新后仍在 |
| AC-4.3 | 上游有未确认变更时，重跑必须**拒绝启动并说明原因** |

### M5 · 经验沉淀（提案制自进化）· v2.1，本期不开工；**D3 拍板后修订：自动沉淀冻结，手动演化入口排后期**

- **冻结（D3 拍板）**：会话结束自动产出沉淀提案——在存在至少一条可自动判定的质量信号之前不评估、不开工。
- **新增排后期（D3 拍板）**：**手动演化入口**——用户主动发起（CLI 斜杠命令 `pi.registerCommand` / 对话内对主脑说「改 xx」/ Web 面板按钮），AI 产出提案，走与产物同一条逐块确认通道落新版本。覆盖四类受管对象 + 主脑预设：Skill（内容/版本说明）、Agent 档案（角色/系统提示、模型、思考强度、**工具集**、doc/coding 模式）、Recipe（步骤/队员/验收标准）、主脑预设（系统提示模板）。
- 机制零新增：复用 M1 的 `propose → PendingChange → 逐块确认 → 版本 → 回滚` 机器（回滚本身也是一次新版本），M3 的 AC-3.3 已验证档案类接入。
- （冻结项，D3 拍板留档）Skill 语义版本 + 变更说明 + 来源会话链接；使用计数 + 最近使用时间；久未用「建议归档」；外部 Skill 提示注入静态扫描。
- （冻结项，D3 拍板留档）**双版本对比测试**（同一 Recipe 两 run 各 pin 不同对象版本、diff 产出）：不进本期 AC。备注：run schema 仍记录本次消费的对象版本（Agent/Skill/Recipe 版本号）——它是 sourceRef 血缘的一部分，零额外成本，为未来解冻留口。

| AC | 内容 |
|---|---|
| AC-5.1 | Skill 提案以待确认变更呈现，逐块确认后才落盘并产生新版本 |
| AC-5.2 | 任一 Skill 可回滚到任意历史版本；回滚本身也是一次新版本 |
| AC-5.3 | 系统**永不**在无人确认时修改 Skill 或 Agent 档案（红线自检项） |
| AC-5.4 | 含已知注入模式的 Skill 被拒载并在 UI 明示命中规则 |

**v2.1 准入门禁**：M5 只有在存在**至少一条可自动判定的质量信号**（如原型 pageErrors=0、门禁全绿、验收标准勾选完成率）时才开工。没有信号的自进化 = 无方向的方向盘。

### M6 · 看板与可见性

**沿用**：ArtifactPanel、PipelineBoard、MastermindRunHistory、队员卡。

**新增**：**产物看板**（以产物为第一视角：当前版本 / 待确认块数 / 归属 stage/agent / 上游链 / 历史版本）；**Trajectory 视图**（按来源分类展示模型实际看到的一切：系统提示、上下文注入、工具调用与结果、子 Agent 调度；订阅 §5.4 事件流自建——**全模块中唯一没有现成实现可参照的一块，预算给足**；遵守 presentation 纯数据规约）。

| AC | 内容 |
|---|---|
| AC-6.1 | 产物看板可按「有待确认变更」筛选，数字与逐块确认面板一致 |
| AC-6.2 | 任一 Agent 回复可展开其本轮真实输入来源清单，与会话日志逐条对上 |

## 7. 迁移清单（重构不是重写）

| 资产（旧仓锚点） | 处置 | 说明 |
|---|---|---|
| `lib/domain/lcs.ts` `artifact-service.ts` `pending-change-service.ts` `file-name.ts` | **原样搬**（→ L1） | 最有价值的核心资产，二十轮验证过 |
| `lib/domain/agent-profile-store.ts` `project-registry.ts` `session-agent-map.ts` `lib/pi/agent-profile-session.ts` `extra-skill-dirs.ts` | 搬 + 适配器边界（L1/L2） | 抽 HarnessAdapter |
| `lib/pi/doc-tools.ts` `orchestrator-session.ts` | 搬 + 改 `pi.registerTool` 接线（L2） | 提议三工具 + submit_plan |
| `lib/domain/mastermind-orchestrator.ts` `mastermind-run-store.ts` `mastermind-from-canvas.ts` `dag-graph.ts` | 搬 + 瘦身（先补测试再拆）；`mastermind-from-canvas.ts` `dag-graph.ts` 只读冻结、不迁 | DAG/并行已拍板暂停到 v2.2（D7） |
| `lib/domain/pipeline-store.ts` `team-template-store.ts` | **合并重写为 recipe-store** | 一次性数据迁移，不并存，旧路径不再读 |
| `lib/domain/orchestrator.ts` `dispatch-store.ts`（第一代 dispatch） | **删除**（保留只读迁移） | 被 Recipe + 主脑全覆盖 |
| `lib/rpc-manager.ts` `lib/pi/session-reattach.ts` `concurrency-gate.ts` `factory-config.ts` `evict-agent-sessions.ts` `run-controllers.ts` | **删除** | pi-web 进程模型补丁层；编排器自持会话表 + 计数信号量取代 |
| 全部 `app/api/**`（54 路由）+ SSE | **删除** | L3 壳直连 packages；本地单用户无需 HTTP 层 |
| `components/ModelsConfig.tsx` `SkillsConfig.tsx` `/api/models*` `/api/skills*` `/api/auth/*` | **删除** | pi 内核自带模型/技能/凭证管理 |
| `components/ArtifactPanel.tsx` `PendingChangeCard.tsx` `dag-canvas/*` `Pipeline*` `Mastermind*` `lib/artifact-view/*` `lib/stores/*` | 迁至 Web 壳，数据改直连 packages；守壳零领域判断红线 | 通用渲染器承载 presentation |
| `lib/main-session.ts` `session-grouping.ts` `SessionSidebar` 三分组 | 重做 | 会话管理回归 pi SessionManager；归属语义由 profiles 模块重建 |
| `docs/新增功能开发流程.md` | **保留为一等资产** | 这份 13 阶段流程本身就是第一条内置 Recipe |
| `docs/**` 其余设计史 / ADR / QA | 随仓迁移（`docs/legacy/` 只读） | 祖先设计史 |
| 组件库地基 / shader 首页 / 按钮 token | 冻结 | 服务性支出，本期不投入 |
| `app/ui/page.tsx` `spike/` `bin/pi-web.js` `scripts/build-win.mjs` | 不迁 | 开发期杂物 |
| 现有 pi-web 侧改动 | **审查 + 迁回扩展层** | 盘点其中哪些是领域逻辑，必须搬回 L1/L2 |

## 8. 风险

| 风险 | 等级 | 对策 |
|---|---|---|
| 重构中途又开始加功能 | 🔴 | §2.2 末条红线 + 每轮开工对照 §2.1 |
| 「可上线产品」范围回潮 | 🔴 | D2 拍板后写进北极星；v2.2 前拒绝一切部署类需求 |
| 追溯链让 Agent 输出啰嗦 / 上下文爆 | 🟡 | sourceRef 由工具写入 + appendEntry 不进上下文；归因走轻读 |
| 自进化静默变坏 | 🔴 | D3 甲方案 + v2.1 准入门禁（须先有质量信号） |
| 归因给出自信的错答案 | 🟡 | AC-2.3 强制报断链；输出必须带证据与置信度，无证据不结论 |
| 适配器抽象过度 | 🟡 | HarnessAdapter 恰好 6 个动作，不预留 |
| 领域逻辑泄入 Web 壳组件树 | 🔴 | Web 壳已定完全自建（§9 D8 后续拍板）；「壳零领域判断」为代码审查项——壳只做渲染与写回，判断全在 L1 |
| 两套确认 UI 行为不一致 | 🔴 | 强制 DecisionPort；闸门代码搜不到 `ctx.ui` |
| fork 后上游跟进负担（D1 已拍板 fork） | 🔴 | UPSTREAM.md 对照纪律 + 内核 diff 最小化清单；改动只限品牌/发行层 |

## 9. 决策记录（D1–D10 全部已拍板，2026-08-17）

> 本轮拍板以逐条拷问方式完成。每条含：**结论** + **关键对话留痕**（决策动机与过程中的重要转折）。已拍板条目即日生效，不再是待确认假设。

| # | 决策 | 结论 | 状态 |
|---|---|---|---|
| **D1** | 内核策略：fork vs 不 fork | **乙（有纪律的 fork）**：fork 0.84.2 为基线；改动只限品牌与发行层（TUI 字样、包名、CLI 命令名、数据目录）；领域逻辑全走扩展/SDK 层；loop 级改动单独评审 + 内核 diff 最小化清单 + UPSTREAM.md 对照纪律 | ✅ 已拍板 |
| **D2** | 产物边界 | **甲**：止于设计包 + 原型；可上线靠 v2.2 交接契约；v2.2 前拒绝一切部署类需求；F3 不动摇 | ✅ 已拍板 |
| **D3** | 自进化强度 | **甲′（手动提案制）**：冻结 M5 自动沉淀提案；确认通道（提案 → 逐块确认 → 版本 → 回滚）不变；新增「手动演化入口」排后期，覆盖四类受管对象 + 主脑预设；双版本对比测试冻结 | ✅ 已拍板（含用户修订） |
| **D4** | 追溯粒度 | **甲**：块级 sourceRef（artifactId + version + blockAnchor），工具写入，appendEntry 存储不进上下文 | ✅ 已拍板 |
| **D5** | 六并二 | **接受**。蓝图/队伍模板/主脑plan → Recipe；agent 模板/导入导出 → Agent 序列化格式；删「工作流」「preset」；合并明细见 D5 留痕 | ✅ 已拍板 |
| **D6** | DecisionPort 与确认呈现 | **推荐项 + 呈现选型**：CLI 弹窗 / Web 条目，规则一份；确认分档（整块/逐块/混合），记账永远块级；CLI 呈现 A 为主 B 可选；Web 呈现 B（文档内联）为目标、A 保底 | ✅ 已拍板（含用户新增需求） |
| **D7** | DAG 画布/并行编排 | **暂停到 v2.2**：本期只交付串行产线；`dag-graph` / `mastermind-from-canvas` 只读冻结；N8 维持 | ✅ 已拍板 |
| **D8** | Web 壳节奏与 Web 壳选型 | **修订版确认**：每期一条 Web 适配轨；第一期即落地受管文档面板全套 + 最小写入通道；presentation 纯数据 + 通用渲染器第一期做承重实证；第四期缩为壳完善增量。**后续拍板（2026-08-17）：Web 壳 = 完全自建薄壳**——不 fork pi-web、不部署原版 pi-web 作调试台；第四期「壳选型定案」条目取消 | ✅ 已拍板 |
| **D9** | 品牌/发行 | 品牌 **Next-Step**；CLI 命令 `nextstep`；数据目录**另起独立目录**（不沿用 `~/.pi`）；npm **个人账号**发布；pin **0.84.2** | ✅ 已拍板 |
| **D10** | doc/coding 双模式 | **甲**：保留为能力预设；coding = 原始 write/edit/bash + 配发受管文档工具族；受管路径直写硬挡 + EXTERNAL_MODIFIED 兜底；主会话恒为主脑预设 | ✅ 已拍板 |

### D1 留痕：fork 只为品牌与发行

- **用户动机**：希望别人通过自己的 npm 就能下载到「属于我修改过的 pi」。
- **关键澄清**：发行诉求不 fork 也能满足（wrapper 包依赖 pin 版本 + 捆绑扩展/配置 + bin 启动脚本）；真正的分水岭是「有没有必须动内核源码的修改」。
- **用户回答的分水岭**：要改 TUI 界面品牌字样 + 认为 agent loop 也会需要改 → fork 成立。
- **AI 挑战**：「loop 会需要改」是推测语气；所有领域挂载点已有官方 Hook，不需要动 loop。
- **最终定案**（用户原话）：「fork 只为品牌与发行（TUI 字样、包名、CLI 命令名），领域逻辑仍全部走扩展层——内核 diff 越小，跟上游的合并成本越低；哪天真的要改 loop，再单独评审那一次改动。」

### D2 留痕

用户原话「按你推荐的来」。无争议：差异化在「产线可信 + 可归因」，不在部署；部署是红海。

### D3 留痕：从「自动自进化」转向「手动提案制」

- **用户想法**（原话要点）：「目前冻结自进化，而是设计手动进化，有一个入口让用户或是用户在对话内叫 AI 改动包括且不限于 skill、agents 提示词、还有 agent 使用的 tools……我不知道要如何实现，这个可以放在后期做」。
- **AI 对齐**：这个想法不是否定提案制，而是砍掉「自动触发」、保留提案制全部机械；实现上不是新机制，是 F1 确认通道的第四类客户，入口后期加三个（斜杠命令 / 对话内 / Web 面板）。
- **用户追问**：「这些对象如何进行版本管理？想退回原来的版本，或者拿两个版本测试对比」。
- **AI 答复**：版本管理零新机制（回滚 = 以旧版内容生成新版本，历史 append-only）；版本对比用 `get_artifact_history` + LCS 块级 diff；**双版本跑测对比**是唯一新东西（同一 Recipe 两 run 各 pin 不同对象版本），需要 run schema 记录消费的对象版本。
- **用户定案**：「没必要但可以记录冻结，前期不需要加这么重的功能，先要保证主线可用再来考虑其他」→ 双版本对比测试冻结；run schema 记录消费对象版本保留（sourceRef 血缘顺带做）。

### D4 留痕

- 第一版用术语讲（块级 sourceRef / RTM / appendEntry），用户反馈「说人话，我看不懂」。
- 用「产线一环扣一环，出问题倒查；账记多细」重讲：粗记只能说「设计阶段出的问题」，块记能定位到「设计漏了深色模式这条、需求第 5 条明明写了」，全记（RTM）维护不起。
- 用户拍板：「甲」。
- **教训留痕**：对非技术用户的决策沟通，先讲「查问题能查到什么」再讲技术名词。

### D5 留痕：概念错位澄清

- **用户第一反应**：「我不知道如何选择，我只知道在 pi 中可以用 pi-Package 的 subagent 或者其他关于 agent 的 Package 来负责 pipeline 蓝图 / 队伍模板。到时候再来选择具体学习参考哪个 Package」。
- **AI 澄清概念错位**：`pi-subagents` 解决「怎么派一个子 Agent 干活」（执行机制，工具箱）；「pipeline 蓝图 / 队伍模板」解决「产线长什么样」（数据，排班表）。电话可以买，排班表只能自己写——pi 生态没有现成包能替你定义你的产线步骤与验收标准。
- **用户定案**：「先接受吧，并且记录好哪些被合并了」→ 合并明细存档（见上表）；「到时候再选参考哪个 Package」保留为第二期编排底座选型（pi-subagents vs 官方 subagent example），与本条无关。

### D6 留痕：从「端口策略」扩展到「确认交互分档 + 呈现方案选型」

- **用户质疑 1**：「逐块确认是否太过麻烦？是不是应该学习 notion 显示更改了文档内哪些内容？一次改了特别多总不能一块块确认吧。第二终端内如何呈现文档内的修改？最好给个简图」。
- **AI 答复**：确认分档（整块通过 / 逐块 / 混合先全收再打回单块）；**交互可分档、记账永远块级**（sourceRef 与回滚按块）；给出 CLI 汇总卡简图。
- **用户质疑 2**：「Web 条目大概长什么样子」→ 给出 Web 单卡逐块简图，说明「数据一份、两前端各画」与回放/直播一致。
- **用户质疑 3**：「别限定死，CLI 和 Web 还有没有更好的呈现方案？分别给出简图」。
- **AI 铺开候选**：CLI 三方案（A 汇总卡+快捷键 / B 逐块流式 / C 并排对照），Web 三方案（A 单卡逐块 / B 文档内联沉浸审阅（Notion 风，改动嵌原位）/ C 并排双栏 PR 风）。
- **用户定案**：「CLI 选 A 为主 + B 可选；Web 选 B 为目标、A 为保底」。B（文档内联）是差异化体验，第一期实证其块锚点定位；有坑退 A 不丢功能。
- **用户追问**：端口策略那段看不懂 → 用「规矩只有一本、问法各显神通」重讲（闸门不准直接弹窗，只说「我需要问用户」，两个翻译官分别把问题变成终端弹窗 / 日志条目卡片）。

### D7 留痕

- AI 用「如果只能选一张牌：缺陷可归因 vs 多 Agent 并行跑」问差异化定位（推荐归因：并行编排满大街，块级追溯 + 归因驱动重跑没人做）。
- **用户定案**（原话）：「暂时不需要并行 run」。

### D8 留痕

- AI 呈现代价（第一期就要做 Web：受管文档面板全套 + 写入通道）与被否旧方案的对比（第四期一次性补 Web 的两个风险：招牌 UX 太晚被真实用户碰；CLI-only 假设埋雷）。
- 明确不建议再砍第一期 Web 轨（写回通道是 presentation 实证核心，砍了等于把唯一体验风险点推后）。
- **用户定案**（原话）：「那你的推荐来」。
- **后续拍板（2026-08-17，进入原型环节前）**：用户问「Web 端是 fork pi-web 还是完全自己写」。AI 给三选项（fork pi-web / 自建薄壳 / 第三方三候选）并推荐自建，理由：①壳的职责（读会话 JSONL → 渲染 presentation → 写回条目）决定通用渲染器横竖要自己写，pi-web 现成 UI 大半用不上；②D1 刚拍「fork diff 最小化」，pi-web 无插件机制、加 UI 须改 React 组件树 = 第二个大 diff fork 跟进黑洞；③旧仓 rpc-manager 等整批补丁层正是「领域长在 pi-web 上」的病根复刻。用户拍板（原话）：「那就先不要原版 pi-web了，下一步看下自建薄壳的原型ui吧」——连原版 pi-web 只读调试台也不部署，Web 壳完全自建。

### D9 留痕

一次性定四个命名决定：品牌延续 Next-Step（改名无收益）；命令 `nextstep`；**数据目录另起**（fork 是独立产品，与原版 pi 共存时共目录会互踩会话与配置，违单 writer 精神）；npm 个人账号。用户逐条确认。

### D10 留痕

- AI 指出乙（删 mode 字段）两头不成立（全体 doc = 原型无法落代码；全体 coding = F1 破功），甲是唯一活口；要确认的只是「coding 队员补配受管文档工具族」这个修补。
- **用户定案**：「甲按你的推荐」。

### 拍板后遗留冻结/备注清单

| 项 | 状态 | 解冻条件 / 时点 |
|---|---|---|
| M5 自动沉淀提案 | 冻结 | 存在至少一条可自动判定的质量信号后再评估 |
| 手动演化入口（四类对象 + 主脑预设） | 排后期 | 主线可用后单独立项 |
| 双版本对比测试 | 冻结 | 同上；run schema 记录消费对象版本随 sourceRef 顺带做 |
| 编排底座选型（pi-subagents vs 官方 example） | 留待 | 第二期开工时评估 |
| ~~Web 壳三候选定案~~（已定：自建薄壳） | 已决 | D8 后续拍板（2026-08-17） |
| loop 级内核改动 | 冻结 | 任何改动单独评审 + 登记内核 diff 清单 |
| **EntryDecisionPort 跨端实时唤醒** | **冻结** | 第四期（出口判据「同一闸门双端确认」正好覆盖）；需自建文件监视握手，依据 qa/pi-cross-process-sync-investigation.md |
| **回滚反馈交互**（方案 C：正文切换 + 回滚报告 + 撤销回滚） | **已定** | 2026-08-17 用户拍板；原型已实证（walkthrough-report.md 复走二全 PASS） |

## 10. 分期实施（最小可信闭环先行，逐期叠加）

> 原则（用户 2026-08-17 拍板）：**先抽出最基础最关键的功能实现，第二步再往上加**。每期有可验收出口；后期依赖前期的数据格式，禁止跳期（M2a 的 sourceRef 必须在第一期随工具写入，否则全部产物返工补血缘）。

### 第一期 · 北极星闭环（纯 CLI，单 Agent）—— 最小切片

**做什么**：L1 原样搬（artifact-service / pending-change-service / lcs）→ L2 注册提议三工具（create_artifact / propose_edit / list_artifacts）+ 只读三工具（get_artifact_diff / list_my_artifacts / get_artifact_history）→ doc 工具集物理禁用 write/edit（tools 白名单/excludeTools）→ CliDecisionPort（ctx.ui 逐块 y/n）→ **sourceRef 随工具写入 appendEntry**（M2a，只写不查）→ 单 Agent 会话跑通「建文档 → 提议改 → 逐块确认 → 物化留版 → 版本/回滚」。
**出口**：AC-1.1~1.4 全绿；F1 在纯 CLI 端到端成立；EXTERNAL_MODIFIED 保护实测有效。
**不做什么**：多 Agent、编排、Web、归因查询。
**参照**：`permission-gate.ts`（tool_call 拦截 + ctx.ui.confirm 写法）；`protected-paths.ts`（禁写语义）；`edit.details.patch`（diff 不自己解析）；`pi.dev/docs/latest/extensions`（registerTool / appendEntry / ctx.ui）。
**Web 轨（本期即做，D8 已拍板）**：受管文档面板全套——块级绿/红/黄高亮、**确认分档交互（整块收 / 逐块 ✓/✗ / 混合，D6 拍板）**（写回 approval_response，**作用于存储态 PendingChange，非会话内实时握手——见 §5.2 冻结注记**）、版本链、回滚（方案 C：正文切换 + 回滚报告 + 撤销回滚）、外部手改检测提示；**Web 呈现以「文档内联沉浸审阅（改动嵌文档原位，Notion 风）」为目标方案做承重实证，保底退「单卡逐块列表」（D6 拍板）**；薄 server 直调 L1 领域服务，组件零领域判断。

### 第二期 · 多 Agent 产线（CLI）

**做什么**：agent-profiles（档案 + 注入 + doc/coding 预设，D10）→ recipe-store（含旧数据一次性迁移）→ 主脑 submit_plan + 计划闸（复用 DecisionPort）→ serial 编排（runWorker 自持会话、累积喂下游、retry/pause/四抉择）→ 从阶段重跑 + run 血缘。
**出口**：一句需求 → 主脑拆活 → 计划确认 → 串行产线跑通，每阶段产受管文档且 sourceRef 链不断。
**参照**：`plan-mode/`（计划闸范式）；`subagent/` + npm `pi-subagents`（派子 Agent 机制底座评估，§5.5）。
**Web 轨（本期即做，D8 修订）**：计划卡（确认/打回/否决 → 写回 approval_response）、run 进度呈现与 run 历史列表、队员卡只读视图。

### 第三期 · 归因闭环（CLI）

**做什么**：trace_defect（M2b 归因查询：上游链 + 每环验收标准 + 最早偏离点候选 + 断链显式报告）→ 归因驱动重跑（AC-4.1/4.3）→ coding 队员接入原型阶段（受管文档工具族配发）。
**出口**：AC-2.1~2.4、AC-4.x 全绿——「原型有缺陷 → 系统定位到阶段 → 一键重跑下游」真实跑通。
**参照**：`fork(entryId, {position:"at"})` / `importFromJsonl()`（重跑与血缘，不自建版本模型）；`appendEntry`（sourceRef 落点，不进 LLM 上下文）。
**Web 轨（本期即做，D8 修订）**：归因结果视图（上游链 + 每环验收标准 + 最早偏离点候选 + 断链显式标记）+ 一键「从这一步重跑」入口。

### 第四期 · Web 壳完善（D8 修订后：只剩增量）

**做什么**：通用渲染器完善（presentation 纯数据全条目类型覆盖）→ 产物看板 + Trajectory 视图（M6）→ 双前端同一 fixture JSONL 快照回归。（壳选型已提前定案：自建薄壳，见 §9 D8 后续拍板；原「三候选拍板」取消。）
**出口**：同一闸门终端与浏览器都能完成确认；删壳互不影响（§5 单一标准）；新增条目类型两壳零改动。
**参照**：`registerEntryRenderer`（终端通用渲染）；Web 壳三候选 `@agegr/pi-web` / `pi-web`（jmfederico）/ `@kkkiio/pi-web-ui`（D8 拍板时选）；`pi --mode rpc`（薄壳驱动）。

### （v2.1）M5 经验沉淀

准入门禁：存在至少一条可自动判定的质量信号才开工。

## 11. 启动指令（可直接复制给接手的 AI Agent）

```
角色：你是 Next-Step v2.0 的架构与设计负责人。
输入：本文件（`doc/NextStep-v2.0-需求文档.md`，v3 正本，自包含，不需要其他资料；背景参考可读 `doc/参考资料/`）。

任务（按顺序，不要跳步）：
1. 复述你理解的三根柱子（产能/可控/可追溯返工）与 F1–F4，
   并指出你认为实施中最容易被违反的一条及原因。
2. 产出 概要设计.md：模块划分、L0–L3 分层映射、显式点名承重墙、
   HarnessAdapter 六个动作的接口签名。
3. 产出 详细设计.md：sourceRef / PendingChange / Recipe / 会话条目 schema、
   DecisionPort 接口与两个实现、presentation 纯数据结构。
4. 拆任务卡：每张卡标明「落在哪根柱子 + 让哪条 AC-x.y 从红变绿
   + 属于 L1/L2/L3 + 沿用还是新写」。
5. 出测试计划：每条 AC 至少一个可执行断言。

硬性要求：
- 本轮只做 M1 M2 M3 M4 M6（v2.0）；M5 属 v2.1，只留接口不实现。
- 分期固定（§10）：第一期 北极星闭环 → 第二期 多 Agent 产线 → 第三期 归因闭环 → 第四期 Web 壳；禁止跳期。
- 不得引入数据库 / 多用户 / 云端；不得引入组件库。
- 不得让 AI 在无人确认时写入任何落盘产物（含文档/档案/Recipe/Skill）。
- 领域逻辑不得写进前端；闸门不得直接调终端交互 API。
- D1–D10 已全部拍板（§9 决策记录，2026-08-17），按拍板结论设计，不得按旧推荐项回退。
- 遇到本文档没写清的前提，先提问，不要自行假设。

第一条回复只包含：第 1 步复述 + 你发现的文档缺口清单 + 第 2 步的组织方式。
```

## 12. 交叉审查留痕（2026-08-17）

- 输入：本文 v2（K 版）、用户原稿、`参考/` 三份（改写版 / 交接稿 / D1 实证）、匿名 `参考/05-对比审查与合并裁定-已被推翻-仅留痕.md`。
- 裁定：用户指令本文权重最高 → **本文为正本**；匿名裁定文件「正本=交接稿、K 版撤回」的结论被用户指令推翻，该文件仅作输入参考。
- 并入增量：M2 追溯链（最大漏项）、M1 三只读工具、M5 提案制自进化、M6 产物看板 + Trajectory、概念六并二（Recipe/Skill）、L0–L3 分层 + HarnessAdapter + DecisionPort + presentation 纯数据 + 单 writer、迁移清单两项修正（pipeline/team-template 合并非删除；开发流程文档升一等资产）。
- 待拍板冲突项（已于 v3.4 全部拍板）：D1（fork，拍板为乙）、D7（DAG 暂停，拍板为暂停）、D8（Web 壳节奏，拍板为每期一轨）——见 §9。
- v3.1（2026-08-17 用户追加两问后修订）：新增 D10（doc/coding 双模式保留为能力预设、coding 配发受管文档工具族补旧缺口）；§10 构建顺序改为「分期实施」——第一期北极星闭环（纯 CLI 单 Agent 最小切片）→ 第二期多 Agent 产线 → 第三期归因闭环 → 第四期 Web 壳；M2 拆为 M2a（sourceRef 随工具写入，第一期）/ M2b（trace_defect 归因查询，第三期）。
- v3.2（2026-08-17）：新增 §5.5 生态包盘点（npm 实证）与附录 A 引用清单；官方 examples 挂载点对照写入 §5.4；M1/M4 补官方参照行。
- v3.3（2026-08-17，用户三问）：D10 补完主会话定位（主脑预设 = coding 全套 + submit_plan + 受管文档完整工具族含 propose_edit，受管路径直写硬挡）；D8 修订为「每期一条 Web 适配轨」（第一期即落地受管文档面板全套，第四期缩为壳完善增量）；§10 各期补 Web 轨与参照行。正本迁至 `doc/NextStep-v2.0-需求文档.md`。
- v3.4（2026-08-17，逐条拷问拍板）：**D1–D10 全部拍板**（§9 改为决策记录 + 每条对话留痕）。要点：D1 乙（有纪律的 fork 0.84.2，改动只限品牌/发行层）；D3 甲′（手动提案制：M5 自动沉淀冻结、手动演化入口排后期、双版本对比测试冻结）；D6 扩展（确认分档 + 呈现选型：CLI A 汇总卡为主 B 逐块流式可选，Web B 文档内联为目标 A 单卡保底）；D7 暂停（dag-graph/mastermind-from-canvas 只读冻结）；D9 定名（Next-Step / `nextstep` / 独立数据目录 / npm 个人账号）。F4、§2.2 红线、§5 L0、§7 迁移清单、§8 风险、§11 启动指令同步改写为已拍板表述。

---

## 附录 A · 引用与来源清单（全部已实证，勿重开调研）

### A-1 上游内核与文档
| 来源 | 定位 | 实证 |
|---|---|---|
| `@earendil-works/pi-coding-agent` + `pi-ai`（npm） | 上游内核（L0），仓库 `github.com/earendil-works/pi`（monorepo） | npm registry：最新 0.84.2，MIT（2026-08-17 查） |
| pi SDK 文档 `packages/coding-agent/docs/sdk.md` | `createAgentSession` / `createAgentSessionRuntime` / `SessionManager` / `tools`·`noTools`·`excludeTools` / `edit.details.patch` | D1 实证（2026-08-12） |
| pi 扩展文档 `pi.dev/docs/latest/extensions` | 事件全序 / `registerTool` / `registerCommand` / `appendEntry` / `registerEntryRenderer` / `ctx.ui` / `{block:true}` | 同上 + pi.dev 在线文档 |
| 解析视频《（一）pi-agent 从复杂到简单》（卡兵说，bilibili） | agent loop 四视角（State/Message/Event/Hooks）；本仓存 `dsh-原理解析.mp4` | 已观片核实 |

### A-2 官方 examples（`earendil-works/pi` 仓库 `packages/coding-agent/examples/extensions/`）
| example | 用途 | 本文挂载点 |
|---|---|---|
| `subagent/` | 派子 Agent 最小机制 | M4（§6）、§5.4 |
| `plan-mode/` | 计划闸范式 | M4 submit_plan 确认闸（F2） |
| `permission-gate.ts` | tool_call 拦截 + ctx.ui.confirm | F1 / CliDecisionPort |
| `protected-paths.ts` | 路径保护 | doc 禁写语义参照 |
| `sandbox` | 沙箱 | 参考，本期不纳入 |

### A-3 社区包（npm，2026-08-17 实证元数据；均 MIT）
| 包 | 版本/活跃度 | 用途 | 本文裁定 |
|---|---|---|---|
| `pi-subagents` | 0.50.0，2026-08-15 更新 | 委派 + 多 Agent 工作流 | M4「派子 Agent」机制底座评估（§5.5） |
| `pi-permissions` / `pi-permission-system` | 1.0.4 / 0.8.0 | 工具调用级权限门 | F1 工程写法参照（§5.5） |
| `oh-my-pi` | 0.2.0，停更 | prompt 级编排 | 不采用（反面对照） |
| `@agegr/pi-web` / `pi-web`（jmfederico）/ `@kkkiio/pi-web-ui` | 0.8.9 / 0.14.3 / 0.1.1 | Web 壳候选 | 第四期 D8 再选 |

### A-4 dsh（仅借设计，不迁实现，N2）
| 来源 | 用途 |
|---|---|
| `github.com/deepseek-ai/deepseek-harness`（v0.1 dev preview，npm `0.1.0-rc.6`，2026-08-13 发布） | 借两条设计：append-only 日志按来源可检视；approval 作为一等服务 |
| 其 Discussion #853（web RPC 无 auth）、issue #461（danger-full-access 删家目录） | 不迁的安全依据 |

### A-5 项目内文档
| 文档 | 角色 |
|---|---|
| `参考/01-用户原始需求草稿.md` | 需求起点（2026-08-16 用户原稿） |
| `参考/02-改写版需求文档.md` | 需求增量来源（M1–M6 / 六并二 / D1–D5） |
| `参考/03-需求交接稿.md` | 禁止项 / 分层 / DecisionPort / 启动指令范式来源 |
| `参考/04-D1地基选型实证.md` | 地基实证依据（§5 全部 pi 落点） |
| `next-step-app/`（旧实现仓） | 迁移资产锚点（§7） |
| `参考/05-对比审查与合并裁定-已被推翻-仅留痕.md` | 匿名输入，其「正本=交接稿」结论已被用户指令推翻（§12），仅作参考 |
