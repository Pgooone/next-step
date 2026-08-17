# 概要设计 · Next-Step v2.0 round-1（第一期 · 北极星闭环）

> 依据：正本《NextStep-v2.0-需求文档.md》v3.4（§5 分层、§9 D1–D10 拍板、§10 第一期、§11 启动指令）、round-1 PRD（范围圈定 + S1–S5 场景剧本）、两份 QA 调查（跨进程同步 / 旧仓回滚考古）、原型走查基线（managed-doc-panel.html，方案 B 内联 + 方案 C 回滚反馈）。
> 本文档只做概要设计；数据 schema / 端口 / 工具注册表 / 测试计划见 `detailed-design.md`（阶段二任务卡拆分不属本轮）。
> 所有决策均以正本 D1–D10 拍板结论为既定事实，不按旧推荐回退。

---

## 0. 一句话架构（复述正本 §5）

领域逻辑全部住在一个**不认识 UI、也不认识 pi** 的纯 TS 内核（L1）里；一层薄适配层（L2）把它接到 pi 的官方 Hook 上；CLI 和 Web 只是两个壳（L3），共享同一份会话 JSONL 与同一份随项目落盘的领域存储。**改基座 = 只改内核，两壳不动。**

第一期（北极星闭环）的落点：L1 原样搬三服务 → L2 注册提议三工具 + 只读三工具 → doc 工具集物理禁用 write/edit → CliDecisionPort 闸门 → sourceRef 随工具写入 appendEntry（M2a，只写不查）→ 单 Agent 会话跑通「建文档 → 提议改 → 逐块确认 → 物化留版 → 版本/回滚」；Web 轨同步落地受管文档面板全套（D8）。

---

## 1. 模块划分（五模块 + 一句话职责 + 独立性三连问）

| 模块 | 层 | 一句话职责 | 改它会不会牵连别人 | 它独有什么判断 | 删掉谁先死 |
|---|---|---|---|---|---|
| **pi-fork**（L0 内核 fork） | L0 | fork pi 0.84.2，**改动只限品牌与发行层**（TUI 字样 / 包名 / CLI 命令名 / 数据目录），领域逻辑零进入 | 不会（只改品牌与发行层，不碰 loop 与扩展 API，UPSTREAM.md 对照纪律保证跟上游合并成本可控） | 独有：agent loop、会话树、内置工具——但按 D1 我们**不拥有**改动它的判断，任何 loop 级改动须单独评审登记 | 删掉它：两壳和 L1/L2 的载体没了——但按分层健康标准，L1/L2 逻辑本身零丢失，换个地基重接线即可（这正是 L1 零 pi 依赖的意义） |
| **next-step-core**（L1） | L1 | 纯 TS 领域内核：diff 解析、受管产物存储、提案状态机、闸门判定、sourceRef 构建、presentation 构建、外部手改检测——**零 pi import、零 UI import** | 接口（DecisionPort / AuditPort / 服务函数签名）不变则不影响 L2/L3；L2/L3 只依赖它的导出面 | 独有全部领域判断：什么要确认、块怎么切、基底是否过期、外部手改是否发生、审计条目长什么样 | 删掉它：L2 工具变空壳、两壳无逻辑可调，整个产品只剩一个光杆 pi |
| **next-step-pi**（L2 适配层 = HarnessAdapter） | L2 | 唯一 import pi 的包：6 动作适配、工具注册表接线、DecisionPort 两个实现、AuditPort 的 pi 实现、tool_call 拦截 | 改它会牵连两壳（工具接线、条目通道变化）——但它自身保持「薄」：零领域判断，只做翻译与接线 | 独有：pi 接线判断（registerTool 怎么挂、事件怎么订阅、appendEntry 怎么调、ctx.ui 怎么问） | 删掉它：CLI 无扩展无闸门，Web 无审计通道，L1 的领域能力无处接 |
| **CLI 壳**（L3） | L3 | pi 本体 fork + 加载 next-step-pi 扩展，`nextstep` 命令即得可用的 doc 模式会话 | 改它不牵连 Web（分层健康单一标准：删掉 Web 壳 CLI 什么也不少） | **零领域判断**（唯一判断是「加载哪个扩展」，属发行层） | 删掉它：Web 什么也不少 |
| **Web 壳**（L3） | L3 | 自建薄壳：薄 server 直调 L1 领域服务 + 写回审计条目；前端 = 通用渲染器 + 受管文档面板（只渲染、零判断） | 改它不牵连 CLI（同一标准反向成立） | **零领域判断**：只做「读 JSONL / 读领域存储 → 渲染 presentation → 用户动作透传给 L1 服务 + 写审计条目」 | 删掉它：CLI 什么也不少 |

**模块独立性验证（正本 §5 单一标准）**：删 Web 壳 → CLI 侧 6 工具 + 闸门 + 审计全在；删 CLI 壳 → Web 面板直调 L1 服务 + 面板会话 JSONL 全在。两壳唯一的共享物是「磁盘上的数据」，不是代码。

---

## 2. L0–L3 分层映射表（第一期具体化）

| 层 | 放什么（第一期） | 依赖约束 | 怎么测 |
|---|---|---|---|
| **L0** pi-fork 0.84.2 | agent loop、会话树、内置工具；fork 改动 = CONFIG_DIR_NAME="nextstep"（D9，官方导出支持 rebrand）、包名 `@pgoone/pi-coding-agent`、CLI 命令 `nextstep`、TUI 品牌字样 | 改动只限品牌与发行层（D1）；任何 loop 级改动单独评审 + 登记内核 diff 清单；领域逻辑零进入 | 不单测；发行冒烟（`nextstep` 能起会话） |
| **L1** next-step-core | 原样搬：`artifact-service` / `pending-change-service` / `lcs.ts` / `file-name.ts`；新增：PendingChange.baseVersion、闸门编排（pending-gate-service）、审计条目类型 + 构建、presentation 构建、外部手改检测服务、sourceRef 构建 | **零 pi import、零 UI import**（旧仓 file-name.ts 的「抽到无 pi 依赖独立模块」先例直接沿用） | 纯单测（vitest，内存临时目录），不需要模型不需要界面 |
| **L2** next-step-pi | HarnessAdapter 6 动作；工具注册表（提议三工具 = 旧仓 doc-tools.ts 搬 + 改造；只读三工具 = 新增）；CliDecisionPort（ctx.ui）；EntryDecisionPort（仅存储态语义，冻结注记）；AuditPort 的 pi 实现（appendEntry）；doc 会话装配（tools 白名单 / excludeTools 物理禁用 write/edit）；受管路径 tool_call 守卫 | **只有这层 import pi**；L2 无领域判断，全部逻辑调 L1 | `SessionManager.inMemory()` + stub 模型集成测试 |
| **L3** CLI 壳 | pi 本体 fork + 加载 next-step-pi 扩展 + 装配 doc 会话 | 只读会话条目与领域存储，展示与确认都经 DecisionPort/服务；不得包含领域判断 | 手动 / E2E（S5 真机） |
| **L3** Web 壳 | 薄 server（HTTP 接口表见详细设计 §6）：直调 L1 领域服务 + 经 L2 暴露的 AuditPort 写审计条目；前端通用渲染器 + 受管文档面板（块级高亮 / 确认分档 / 版本链 / 方案 C 回滚反馈 / EXTERNAL_MODIFIED 提示） | server 端可以 import L1（领域）与 L2 的「审计写入 + 会话读取」导出；**不得直接 import pi**、不得含领域判断 | Web E2E（真浏览器，S1–S4）+ 一致性断言（通道①） |

**分层健康单一标准（正本 §5）逐项成立的前提**：L1 不暴露任何 pi 类型（工具定义、ctx 等）——L1 的「工具」只是纯数据 schema，由 L2 翻译成 pi 的 ToolDefinition；L1 的「会话」概念不存在，只有领域服务函数。

---

## 3. 承重墙（第一期显式点名）

第一期有三根承重墙，任何一根倒掉，本轮出口判据（AC-1.1~1.4 + F1 纯 CLI 端到端 + EXTERNAL_MODIFIED 实测 + presentation 承重实证）全灭。实现顺序即承重顺序：

1. **artifact-service / pending-change-service / lcs 迁移（原样搬）** —— 二十轮验证过的唯一核心资产（正本 §7）。「原样搬」指语义与函数签名不重写；唯一允许的改动是 PendingChange 加 baseVersion 字段与物化前基底校验（调查缺口②，属 v2.0 必补）。搬完先跑旧仓既有单测平移（回归护栏），再动任何改造。
2. **CliDecisionPort（ctx.ui）** —— F1 在纯 CLI 端到端成立的唯一闸门实现；permission-gate.ts 范式（tool_call 拦截 + ctx.ui 交互），但确认点收敛在 propose_edit 工具执行内的 L1 闸门编排里（见详细设计 §3），L1 只依赖 `DecisionPort.ask(req) → Decision` 接口，全仓闸门代码搜不到 `ctx.ui`（§8 风险「两套确认 UI 行为不一致」的红线）。
3. **appendEntry 审计条目族** —— 调查缺口①（旧仓无审计）的补法：artifact_proposed / artifact_resolved / artifact_rollback / approval_request / approval_response 五类自定义条目，既是 M2a sourceRef 的存储落点，也是 M6 可见性与归因（第三期）的地基。条目 payload 自带 presentation 纯数据，两壳通用渲染器靠它实现「新增条目类型两壳零改动」。

另有两块「支撑件」非承重但影响体验出口：presentation 纯数据 + 通用渲染器（D8 承重实证要求）、Web 面板 EXTERNAL_MODIFIED 三动作交互（S4 剧本）。

---

## 4. HarnessAdapter：恰好 6 个动作（不预留第 7 个）

接口定义在 **L1**（零 pi import，L1 领域代码只认它），实现与 pi 的 1:1 落点在 **L2**（正本 §5.1：`createAgentSession()` / `session.prompt()` / `pi.registerTool()` / `session.subscribe()`+`ctx.sessionManager.getEntries()` / 官方 subagent example / `context` 事件）。

```ts
// packages/core/src/adapter/harness-adapter.ts（L1 定义，纯 TS 类型）
// 六个动作全部有 pi 官方 1:1 落点；不预留第 7 个。L1 不 import pi，类型均为 L1 自有。

export interface HarnessAdapter {
  /** 动作 1 · 起会话（落点：createAgentSession()）。options 含 cwd、agentDir、systemPrompt、工具白名单。 */
  startSession(options: SessionStartOptions): Promise<SessionHandle>;

  /** 动作 2 · 发消息（落点：session.prompt()）。返回本轮回复文本。 */
  sendMessage(handle: SessionHandle, message: string): Promise<AgentReply>;

  /** 动作 3 · 注册工具（落点：pi.registerTool()）。工具定义是 L1 纯数据 schema，L2 翻译成 ToolDefinition。 */
  registerTool(def: NextStepToolDef): void;

  /** 动作 4 · 读会话流（落点：session.subscribe() + ctx.sessionManager.getEntries()）。直播 + 回放同一条通道。 */
  readSessionStream(handle: SessionHandle, opts: { afterEntryId?: string }): AsyncIterable<SessionEntry>;

  /** 动作 5 · 派子 Agent（落点：官方 examples/extensions/subagent；第二期 M4 消费，本期实现 + 单测不接线）。 */
  spawnSubagent(handle: SessionHandle, req: SubagentRequest): Promise<SubagentResult>;

  /** 动作 6 · 取上下文用量（落点：context 事件）。L1 侧防御上下文膨胀（§8 风险「追溯链让 Agent 输出啰嗦」）。 */
  getContextUsage(handle: SessionHandle): Promise<ContextUsage>;
}
```

配套类型（同文件，均为 L1 自有类型）：

```ts
export type SessionStartOptions = {
  cwd: string;
  agentDir: string;
  systemPrompt?: string;
  tools: NextStepToolDef[];       // 注册进会话的自定义工具
  toolsWhitelist: string[];       // 能力层白名单（doc 模式物理禁 write/edit 的落点之一）
  excludeTools?: string[];        // 能力层显式排除（双保险）
  decisionPort: DecisionPort;     // 闸门（详细设计 §3）
  auditPort: AuditPort;           // 审计条目写回（详细设计 §2.3）
  sourceActor: string;            // 本会话 Agent 身份（写入 version.author / sourceActor / list_my_artifacts 的「名下」）
  projectId: string;              // 闭包注入的当前项目（旧仓 doc-tools.ts 同款装配范式）
};
export type SessionHandle = { id: string };
export type AgentReply = { text: string; turnEnd: boolean };
export type NextStepToolDef = {           // L1 纯数据；L2 负责转 pi ToolDefinition
  name: string;
  description: string;
  parameters: JsonSchema;
  promptGuidelines?: string[];            // 旧仓 propose_edit 已验证的「整篇 vs 残篇」双通道约束
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<NextStepToolResult>;
};
export type NextStepToolResult = { content: { type: "text"; text: string }[] };
export type SessionEntry = { id: string; type: string; ts: string; payload: Record<string, unknown> };
export type SubagentRequest = { prompt: string; tools?: string[]; model?: string };   // 第二期细化
export type SubagentResult = { text: string; usage: ContextUsage };
export type ContextUsage = { totalTokens: number; inputTokens: number; outputTokens: number; entryCount: number };
```

**为什么 appendEntry 不在 6 动作里**：6 动作是「L1 领域代码对会话能力的全部需求面」；审计条目写回对 L1 暴露为 **AuditPort**（见详细设计 §2.3），appendEntry 是 L2 内部机制（与 tool_call 拦截、tool_result 改写同级），不占第 7 个动作。正本 §5.1 的 6 动作清单与之严格一致。

---

## 5. monorepo 布局提案（D1 / D9）

```
nextstep/                                # monorepo 根（npm workspaces）
├── package.json                         # workspaces: ["packages/*", "apps/*"]；private
├── pi-fork/                             # L0：fork @earendil-works/pi-coding-agent 0.84.2（vendor 目录）
│   ├── packages/coding-agent/           #    改动只限品牌与发行层（D1）
│   ├── UPSTREAM.md                      #    对照纪律：上游版本 pin + 内核 diff 逐条登记表 + 合并流程
│   └── 内核-diff-清单.md                #    每条改动一行：位置 / 改了啥 / 为什么非改不可 / 上游合并策略
├── packages/
│   ├── core/                            # L1 · @pgoone/next-step-core（零 pi 依赖，纯 TS）
│   │   └── src/
│   │       ├── domain/                  # artifact-service / pending-change-service / lcs / file-name（旧仓搬）
│   │       ├── gate/                    # pending-gate-service（提案→确认→物化编排）+ DecisionPort/AuditPort 接口
│   │       ├── audit/                   # 审计条目类型 + 构建函数 + presentation 构建
│   │       └── adapter/                 # HarnessAdapter 接口类型（§4）
│   └── pi-ext/                          # L2 · @pgoone/next-step-pi（唯一 import pi 的包）
│       └── src/
│           ├── harness-adapter.ts       # 6 动作的 pi 实现
│           ├── tools/                   # 提议三工具（doc-tools 搬+改）/ 只读三工具（新）
│           ├── ports/                   # CliDecisionPort / EntryDecisionPort / AuditPort(pi 实现)
│           ├── session-assembly.ts      # doc 会话装配（tools 白名单 / excludeTools / 受管路径守卫）
│           └── extension.ts             # pi 扩展入口（registerTool / 拦截器接线）
├── apps/
│   └── web/                             # L3 · Web 壳：薄 server + 前端（通用渲染器 + 面板）
│       ├── server/                      # HTTP 接口（详细设计 §6）：直调 L1 + 经 L2 写审计条目
│       └── web/                         # 前端：通用渲染器 / 面板组件（零领域判断）
├── docs/                                # 本仓文档（rounds/、legacy/ 只读、参考/）
└── 发行产物：`nextstep` 命令
    └── bin/nextstep                     # 指向 pi-fork CLI 入口 + 加载 @pgoone/next-step-pi 扩展
```

**发行与命名（D9 全项落地）**：

| D9 项 | 落地 |
|---|---|
| 品牌 | Next-Step（TUI 品牌字样改于 fork 发行层） |
| CLI 命令 | `nextstep`（fork bin 改名，`npm i -g @pgoone/nextstep` 后直接可用） |
| 数据目录 | **独立目录**：`~/.nextstep/`（不沿用 `~/.pi`）。fork 内核改 `CONFIG_DIR_NAME` 导出 = "nextstep"——官方支持 rebrand（跨进程调查结论四），品牌层改动比预期小。会话 JSONL 落 `~/.nextstep/agent/sessions/*.jsonl` |
| 项目级目录 | 领域存储随项目落盘：`<projectRoot>/.nextstep/artifacts/managed/`（旧仓 `.pi/` 对应迁移；**注意**：CONFIG_DIR_NAME 是否同时控制项目级目录名需 fork 后实证，见待确认假设 H1） |
| npm 发布 | 个人账号发布：`@pgoone/next-step-core`、`@pgoone/next-step-pi`、`@pgoone/nextstep`（发行壳）等 |

**内核 diff 最小化纪律（D1）**：fork 改动只限品牌/发行层，任何 diff 进 UPSTREAM.md 登记表；领域逻辑全走扩展层（pi-ext）；loop 级改动冻结（单独评审 + 登记）。

---

## 6. 第一期跨进程数据模型（调查输入的直接落点）

调查结论（pi-cross-process-sync-investigation + legacy-rollback-investigation）对本期设计的三条强制：

1. **确认一律作用于存储态 PendingChange，零握手**（§5.2 冻结注记 + 调查结论一）：CLI 与 Web 是同一领域服务的两个客户端，共享随项目落盘的领域存储（`<projectRoot>/.nextstep/artifacts/managed/`）；「Web 操作 → CLI 实时感知」不在本期（无跨进程事件推送，通道② watcher 留第二期）。CLI 会话内确认（CliDecisionPort）也是「先落盘 pending → 阻塞问 → 全决即物化」，与 Web 面板写回走同一份领域存储与同一组 L1 服务。
2. **单 writer 自守**（调查结论三，pi 不提供锁）：每个 JSONL 文件同一时刻只有一个 writer。落地：CLI 会话 JSONL 只由 CLI 进程写；Web 面板的操作审计条目写「Web 面板会话」文件（固定独立 session，见待确认假设 H2），领域存储本身由乐观锁（If-Match / baseVersion）兜底并发。
3. **审计是 v2.0 必补缺口①**：所有裁决 / 回滚 / 撤销 / 外部手改处理动作必须落 appendEntry 自定义条目（不进 LLM 上下文，§5.3 实证）。

数据流速览（详见详细设计 §2）：

```
CLI 进程                       Web 进程（薄 server）
┌────────────────────┐         ┌──────────────────────────┐
│ L2 扩展 → L1 服务    │  写      │ 前端 → HTTP → L1 服务      │  写
│ (propose/resolve/   ├────────►│ (resolve/rollback/external│
│  rollback)          │         │  )                        │
└────────┬───────────┘         └────────┬─────────────────┘
         │ 审计条目                        │ 审计条目
         ▼                               ▼
  CLI 会话 JSONL                  Web 面板会话 JSONL
  ~/.nextstep/agent/sessions/    ~/.nextstep/agent/sessions/web-panel.jsonl
         └────────── 共享领域存储（真实状态，通道①）────────────┘
  <projectRoot>/.nextstep/artifacts/managed/<id>/（artifact.json + versions/ + pending/）
```

---

## 7. 本阶段不做（round-1 范围纪律复核）

多 Agent 编排、Recipe 迁移、trace_defect 归因查询（第三期）、DAG/并行（冻结 v2.2）、自动沉淀（D3 冻结）、部署/CI、多用户、数据库、组件库。第一期工具集只有 6 个；HarnessAdapter 第 5 动作（派子 Agent）只实现不接线。

STATUS: DRAFTED —— 阶段一完成，待评审
