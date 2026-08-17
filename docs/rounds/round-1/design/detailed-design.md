# 详细设计 · Next-Step v2.0 round-1（第一期 · 北极星闭环）

> 依据：正本 v3.4（§5.2/§5.3/§6 M1、M2a、§10 第一期、§11）、round-1 PRD（S1–S5）、QA 两份调查（缺口①审计 / 缺口②baseVersion / 缺口③CLI 感知）、原型基线（managed-doc-panel.html）。概要分层与承重墙见 `high-level-design.md`。
> 旧仓锚点（file:line 均指 `/home/pgoone/GitHubproject/Next-Step/next-step-V1.2/`）：本期所有「原样搬」资产均可照此核对。

---

## 1. 数据 schema

### 1.1 PendingChange（+ 显式 baseVersion，调查缺口②）

旧仓类型 `lib/domain/pending-change-service.ts:39-49` **原样保留**（id / artifactId / targetType / op / diff / diffBlocks / sourceActor / hitlMode / createdAt），**新增一个字段**：

```ts
export type PendingChange = {
  id: string;
  artifactId: string;
  targetType: string;                       // "artifact"
  op: "replace" | "patch";                  // 第一期仅 replace 路径（旧仓 D-D2-5 同）
  diff: PendingChangeDiff;                  // { kind:"replace"; oldContent; newContent }
  diffBlocks: DiffBlock[];                  // kind: add|del|mod；state: pending|confirmed|rejected
  sourceActor: string;
  hitlMode: "per_block" | "whole" | "auto"; // 默认 per_block
  createdAt: string;
  /** v2.0 新增：提案创建时 artifact.currentVersion 的显式快照。物化前校验，防挂起提案撞上上游回滚。 */
  baseVersion: number;
};
```

**baseVersion 的校验时机与语义**（红线「上游有未确认变更不得启动下游/重跑」的镜像纪律，调查缺口②）：

- **写入**：`buildReplacePendingChange`（旧仓 `pending-change-service.ts:205-223`）入参加 `baseVersion`，由 propose_edit 工具在落盘时从 `artifact.currentVersion` 取（见 §4 工具表）。
- **校验**：`resolveAndMaterialize`（旧仓 `:360-382`）在 `submitVersion` 之前校验 `artifact.currentVersion === change.baseVersion`；不符 → 抛新错误码 `ArtifactError("BASE_VERSION_CONFLICT")`（409 语义，文案「上游版本已变更（当前 vX ≠ 提案基底 vY），请重新提案」）。校验先于 `applyResolvedBlocks`，失败即干净失败，pending 文件**不删**（保留现场供重新提案比对）。
- **为什么乐观锁不够**：旧仓 If-Match（`artifact-service.ts:414-421`）是「物化瞬间」的并发防撞；baseVersion 是「提案创建 → 物化」整个窗口期的基底快照——用户先看 5 块、中途别人（Web 面板）回滚了文档，物化时 If-Match 也会失配，但报错时机太晚且无法区分「并发冲突」与「基底过期」；显式 baseVersion 让报错可读、可引导重新提案（调查文档 §5 预判的落点）。
- **兼容**：旧 pending 文件无 baseVersion 字段 → 读取时视为 `baseVersion = 缺失`，物化前校验直接失败并提示重新提案（不留歧义）；本字段进版本 1 的 PendingChange 即写全，无历史包袱。

### 1.2 sourceRef（M2a，第一期只写不查）

```ts
/** 块级来源引用。D4 拍板：{ artifactId + version + blockAnchor }，由工具写入而非模型输出。 */
export type SourceRef = {
  artifactId: string;
  /** 该块生效后的产物版本号（= 物化出的新版本）。 */
  version: number;
  /** 块锚点：行区间 + 就近标题，第三期归因消费；本期只保证「写了、可稳定定位」。 */
  blockAnchor: {
    lineStart: number;   // 基于 oldContent 的行区间（1 基）
    lineEnd: number;
    heading?: string;    // 该块所处最近一节标题（L1 构建时推导，尽力而为）
  };
};
```

- **写入路径**：`pending-gate-service`（§3.1）在确认物化成功后，为每个 **confirmed** 块构造一条 SourceRef，随 `artifact_resolved` 审计条目（§1.3）写入 appendEntry。**模型全程不产出 sourceRef**（正本 §6 M2 红线）。
- **第一期不消费**：没有任何读取查询路径；只保证「每条物化版本的 confirmed 块都有一份可追溯记录」。归因工具 trace_defect 属第三期（M2b）。

### 1.3 会话自定义条目：审计条目族（调查缺口①）

所有条目经 `appendEntry` 写入会话 JSONL（`type: "custom"`，持久化、不进 LLM 上下文，正本 §5.3）。五类条目 + payload schema：

```ts
// 顶层统一壳（appendEntry 的自定义条目载荷）
export type AuditEntryPayload = {
  ns: "next-step";                         // 命名空间，区分第三方扩展条目
  kind: AuditKind;
  ts: string;                              // ISO-8601
  presentation?: Presentation;             // 纯数据呈现（§1.4），两壳通用渲染器消费
} & (
  | ArtifactProposed     // kind: "artifact_proposed"
  | ArtifactResolved     // kind: "artifact_resolved"
  | ArtifactRollback     // kind: "artifact_rollback"
  | ApprovalRequest      // kind: "approval_request"
  | ApprovalResponse     // kind: "approval_response"
);

export type AuditKind =
  | "artifact_proposed"   // propose_edit 落盘 PendingChange 时
  | "artifact_resolved"   // PendingChange 全决物化出新版时
  | "artifact_rollback"   // 回滚 / 撤销回滚（= 又一次回滚）时
  | "approval_request"    // DecisionPort.ask 发起问询时（status: pending）
  | "approval_response";  // 用户裁决落定时（含逐块明细）

type ArtifactProposed = {
  kind: "artifact_proposed";
  changeId: string;
  artifactId: string;
  baseVersion: number;
  diffBlockCount: number;
  sourceActor: string;
  diffSummary: { kind: DiffBlock["kind"]; count: number }[];  // 块类型统计（1 修改/1 新增/1 删除…）
};
type ArtifactResolved = {
  kind: "artifact_resolved";
  changeId: string;
  artifactId: string;
  newVersion: number;
  acceptedBlocks: string[];        // confirmed 块 id
  rejectedBlocks: string[];        // rejected 块 id
  sourceRefs: SourceRef[];         // §1.2：confirmed 块 → sourceRef（M2a 存储落点）
};
type ArtifactRollback = {
  kind: "artifact_rollback";
  artifactId: string;
  fromVersion: number;             // 回滚前 currentVersion
  toVersion: number;               // 用户点选的目标版
  newVersion: number;              // 追加生成的新版本号（= fromVersion + 1）
  undoing: boolean;                // true = 撤销回滚（再回滚一次）
  note: string;                    // "rollback to v{n}" / "undo rollback to v{n}"
};
type ApprovalRequest = {
  kind: "approval_request";
  changeId: string;
  artifactId: string;
  status: "pending";
  mode: "block" | "whole";         // 问询分档（D6：逐块 / 整块）
  requester: "cli" | "entry";      // 哪个端口实现发起（审计可检视）
};
type ApprovalResponse = {
  kind: "approval_response";
  changeId: string;
  artifactId: string;
  status: "resolved";
  decisions: { blockId: string; decision: "accept" | "reject" }[];  // 记账永远块级（D6）
  via: "cli-keyboard" | "web-panel";   // 裁决通道（S1⑤「每次裁决落入 append-only 日志」）
};
```

**条目与操作的对应表**（实现侧单测断言用）：

| 操作 | 写入条目序列 |
|---|---|
| propose_edit 落盘 | `artifact_proposed` |
| CliDecisionPort.ask 发起 | `approval_request`（status: pending） |
| CLI 用户逐块/全收确认 | `approval_response` → `artifact_resolved`（含 sourceRefs） |
| Web 面板写回 | `approval_response`（via: web-panel）→ `artifact_resolved`（via L1 服务同一路径） |
| Web / CLI 回滚 | `artifact_rollback`（undoing: false） |
| 撤销回滚 | `artifact_rollback`（undoing: true） |
| 外部手改处理（S4 三动作） | 见待确认假设 H3 |

### 1.4 presentation：纯数据结构（D6 方案 B 内联 / 方案 A 汇总卡同一份数据）

payload 自带 presentation；CLI 与 Web 各写一个**通用渲染器**，按数据画，不做领域判断。结构对齐原型（managed-doc-panel.html）的 85 项走查断言：

```ts
export type Presentation = {
  title: string;                        // 面板顶栏：文档标题 + 版本区间（原型 .doc-title + .ver）
  badges: PresentationBadge[];          // 状态徽章（原型 .badge.pending/.ok）
  body: PresentationBlock[];            // 正文区（顺序渲染）
};

export type PresentationBadge = { kind: "pending" | "ok"; text: string };   // 「待确认 · 5 块」/「已确认 · v4 已物化」

export type PresentationBlock =
  | { kind: "diff";              // 文档内联 diff 区（方案 B 承重实证核心）
      diffRef: DiffRef }         // 原型：改动块卡片嵌原位、块内绿+红−、block-note（sourceRef 已记）
  | { kind: "rows"; rows: Row[] }        // 通用行列表（版本链抽屉 .vrow、回滚报告）
  | { kind: "banner"; tone: "warn" | "info" | "ok"; text: string; actions: string[] }
                                         // 原型：EXTERNAL_MODIFIED 警告 / 回滚报告横幅 / 成功横幅
  | { kind: "text"; text: string };

export type DiffRef = {
  artifactId: string;
  fromVersion: number;                   // 原型 verLabel「v3 → v4」
  toVersion: number;
  blocks: DiffBlockPresentation[];       // 顺序即文档内顺序（TOC 滚动链同序）
};

export type DiffBlockPresentation = {
  blockId: string;
  kind: "add" | "del" | "mod";
  tag: string;                           // 「✏️ 修改 1/5」（原型 .block-tag）
  anchor: string;                        // 「§2.1 内核策略」（原型 .block-anchor）
  lines: string[];                       // add/mod 新行；del 旧行
  oldLines?: string[];                   // mod 旧行（并排渲染用）
  state: "pending" | "confirmed" | "rejected";
  note?: string;                         // 「来源：决策记录 D1 · sourceRef 已记」（原型 .block-note）
};

export type Row = { key: string; value: string; detail?: string };   // 版本链行：v4 / 设计阶段 · designer / 时间 · note
```

**通用渲染器契约**：`render(presentation: Presentation): void`（CLI 端绘制进 ctx.ui 交互流；Web 端渲染进 React 组件树）。新增条目类型 = 新增 payload 类型 + 复用现有 PresentationBlock 组合，**两壳渲染器零改动**（正本 §5.2 规约 2，第四期出口「新增条目类型两壳零改动」在第一期就用本机制承重实证）。

**presentation 由谁构建**：L1 的 `buildPresentation(entry: AuditEntryPayload | 领域状态)` 纯函数（输入 PendingChange / Artifact / 版本链 → 输出 Presentation），L2/L3 只消费。第一期为五类条目各配一个构建函数；Web 面板的「当前待确认态」直接由 L1 服务读领域存储生成（不经条目回放，保证直播与回放一致）。

---

## 2. DecisionPort 与 AuditPort

### 2.1 DecisionPort（L1 定义接口，闸门唯一依赖）

```ts
// packages/core/src/gate/ports.ts（L1，零 pi import）
export type DecisionRequest = {
  kind: "approve_blocks";
  changeId: string;
  artifactId: string;
  title: string;                       // 「设计文档.md」v3 → v4
  blocks: DiffBlockPresentation[];     // 待裁决块（presentation 同源，两端口画法各异）
  mode: "block" | "whole";             // 分档（D6）
};
export type Decision =
  | { status: "resolved"; decisions: { blockId: string; decision: "accept" | "reject" }[] }
  | { status: "deferred" };            // 挂起（EntryDecisionPort 第一期语义：只记条目不阻塞）

export interface DecisionPort {
  ask(req: DecisionRequest): Promise<Decision>;
}
```

**红线**：L1 领域代码（含 propose_edit 流程）只依赖该接口；全仓闸门代码搜不到 `ctx.ui`（§8 风险项，代码审查项）。

### 2.2 两个实现（L2 提供）

**CliDecisionPort**（`ctx.ui`；permission-gate.ts 写法范式）：

- `ask` 实现 = 用 `ctx.ui` 的 select/confirm/input 三件组合出 **D6 CLI 方案 A 汇总卡**：一次呈现全部块（title + 块编号 + kind + 首行摘要），快捷键协议：
  - `y`/`n` + 块号：逐块 ✓/✗（可反复翻转）
  - `a`：全部接受（`whole` 分档）——之后仍可 `n<块号>` 打回单块（混合档，D6）
  - `r`：全部拒绝
  - `回车`：全决后提交裁决（存在 pending 块时拒绝提交并提示）
- 返回 `{ status: "resolved", decisions }`；**记账永远块级**（决策数组逐块，D6 红线）。
- 交互过程中每块状态即时上屏（对齐原型「状态即时变色、进度实时更新」的 CLI 版）。
- 阻塞语义：await 用户输入，agent loop 挂起（官方 permission-gate 同款，实证可行）。

**EntryDecisionPort**（第一期仅存储态语义，跨端实时唤醒冻结至第四期，§5.2 冻结注记 + 调查结论一）：

- `ask` 实现 = 仅 `appendEntry` 写 `approval_request`（status: pending）+ `approval_response` 由 Web 面板动作产生 → **立即返回 `{ status: "deferred" }`**，不挂起、不等待、不轮询。
- 冻结注记原文照录：EntryDecisionPort 的跨端实时唤醒（CLI 进程挂起等待 Web 写回条目）需自建文件监视握手，**冻结至第四期**；第一期确认一律作用于**存储态 PendingChange**（propose 落盘、resolve 独立动作，CLI/Web 是同一领域服务的两个客户端，数据层天然同步，零握手）。
- 第一期 EntryDecisionPort **只实现 + 单测，不接线**（Web 面板的确认动作 = 用户直接调 L1 resolveAndMaterialize，不需要「问」——问的对象已是人）。

### 2.3 AuditPort（L1 定义接口，L2 提供 pi 实现）

```ts
export interface AuditPort {
  append(entry: AuditEntryPayload): Promise<void>;   // L2 实现 = appendEntry（不进 LLM 上下文）
}
```

- L1 的 pending-gate-service / rollback 流程在动作发生处经 AuditPort 写审计条目；L2 注入 pi 实现。
- Web 薄 server 也要写审计条目：经 L2 导出的 `createEntryAuditPort(sessionManager)` 工厂获得 AuditPort 实例（Web server import L2 的工厂，**不直接 import pi**，保持「只有 L2 import pi」——见概要设计 §5 与 H2）。

---

## 3. L1 闸门编排：pending-gate-service（新写，本期唯一新编排逻辑）

旧仓的确认发生在 Web 路由层（`app/api/artifacts/[id]/pending/[changeId]/resolve/route.ts`）；v2.0 要 CLI/Web 共用同一份编排且 L1 可纯单测，故把「提案 → 确认 → 物化」序列收敛为 L1 服务（新文件 `packages/core/src/gate/pending-gate-service.ts`）：

```ts
export type GateDeps = {
  artifactService: ArtifactService;
  pendingStore: PendingChangeStore;
  decisionPort: DecisionPort;
  auditPort: AuditPort;
  via: "cli-keyboard" | "web-panel";   // 裁决通道注记（S1⑤）
};

/** propose_edit 工具的执行体（L2 工具只负责翻译参数/结果，本函数承载全部领域流程）。 */
export async function proposeWithGate(
  deps: GateDeps,
  projectId: string,
  input: { artifactId: string; newContent: string; sourceActor: string },
): Promise<ProposalOutcome>;
// 流程：
// 1. 查未决：该 artifact 已有 pending → 返回引导先处理（旧仓 doc-tools.ts:178-186 语义原样保留）
// 2. oldContent = artifactService.readCurrentContent；切块 = computeReplaceDiffBlocks（旧仓 :129）
// 3. 空块 → 返回「内容无变化」；否则 buildReplacePendingChange({ ..., baseVersion: artifact.currentVersion })
// 4. pendingStore.save（落盘 → 存储态，Web 面板即刻可见，通道①）
// 5. auditPort.append(artifact_proposed)（含 diffSummary）
// 6. 按装配端口：CliDecisionPort → ask（阻塞交互）→ 得 decisions；
//    EntryDecisionPort → ask 返回 deferred（第一期不接线）
// 7. decisions 逐块落 pendingStore.resolveBlock（action 按 decision 映射）
// 8. resolveAndMaterialize（L1 内部：baseVersion 校验 → applyResolvedBlocks → submitVersion → 删 pending）
// 9. auditPort.append(approval_response)（含 decisions 明细）
// 10. auditPort.append(artifact_resolved)（含 sourceRefs：confirmed 块 → buildSourceRefs）
// 返回 { changeId, diffBlockCount, materialized, newVersion }
```

**L1 纯单测锚点**：deps 全部可注入 stub（stub DecisionPort 返回预设 decisions、内存临时目录后端）——「5 块提案 → 全收 → v4 物化」整条在 L1 单测里跑通，不碰 pi。

**rollback 走同一 AuditPort**：L2/Web 调 `ArtifactService.rollback` 前后各写一条 `artifact_rollback`（内容见 §1.3；撤销回滚 = 同一入口 undoing: true）。L1 提供薄包装 `rollbackWithAudit(deps, projectId, artifactId, { version, via })`（校验 + 物化 + 审计，两壳共用）。

---

## 4. L2 工具注册表：六个工具（参数 / 返回 / 只读性）

TypeBox schema（旧仓实证：parameters 用 typebox，doc-tools.ts:74-83）。全部经 `HarnessAdapter.registerTool` 注册；返回统一 `{ content: [{ type: "text", text: JSON }] }`（模型唯一真读通道，旧仓 jsonResult 范式）。错误不抛未捕获，转文本返回（旧仓 errorResult 范式）。

| # | 工具 | 参数 schema | 返回 | 只读 | 来源 |
|---|---|---|---|---|---|
| 1 | `create_artifact` | `{ kind: string; title: string; content: string }` | `{ id, filePath, version }` | ✗（建文档直落 v1 + 物化） | 旧仓 doc-tools.ts:105-142 **原样搬**（registry 换 .nextstep 目录） |
| 2 | `propose_edit` | `{ id: string; newContent: string }` | `{ changeId \| null, diffBlockCount, note }`（null = 已有未决 / 无变化） | ✗（落 PendingChange，**不写真实文件**） | 旧仓 doc-tools.ts:144-214 **搬 + 改造**：加 baseVersion 落盘、接 pending-gate（§3）、写审计条目；promptGuidelines「完整新全文」双通道约束原样保留 |
| 3 | `list_artifacts` | `{}` | `[{ id, title, kind, currentVersion, filePath }]` | ✅ | 旧仓 doc-tools.ts:216-252 **原样搬** |
| 4 | `get_artifact_diff`（新） | `{ artifactId: string; fromVersion?: number; toVersion?: number }`（缺省 = 相邻上一版 → 当前版） | `{ artifactId, fromVersion, toVersion, blocks: { kind, lines, oldLines?, lineStart, lineEnd }[] }` | ✅ AC-1.4 | 新写；读 versions 快照 → lcsDiff → groupOpsToBlocks（与 PendingChange 同一实现，块数天然一致 → AC-1.2） |
| 5 | `list_my_artifacts`（新） | `{}` | `[{ id, title, kind, currentVersion, filePath, lastChange: { version, note, author, createdAt } }]`（「名下」= create_artifact 的 sourceActor 或任一版本 author 含该 actor；第一期单 Agent 会话 = 该会话 sourceActor） | ✅ AC-1.4 | 新写；scan registry 项目 + 版本链末版摘要 |
| 6 | `get_artifact_history`（新） | `{ artifactId: string }` | `{ artifactId, title, versions: [{ version, note, author, createdAt, stage? }] }`（stage 第一期无 Stage 概念 → 字段预留省略） | ✅ AC-1.4 | 新写；listVersions 升序（旧仓 :257-268） |

**AC-1.1**：工具 4/5/6 的返回全部为结构化 JSON（text content），agent 无需人工粘贴即可读。
**AC-1.4**：工具 4/5/6 执行路径零 `pendingStore.save` / `submitVersion` / `rollback` 调用；集成测试断言「调用后 pending 目录为空、版本链不变」（测试计划 §7）。

---

## 5. doc 模式物理禁用 write/edit（能力层，非 prompt）

D10：默认 doc（最小权限）。第一期单 Agent 会话 = doc 会话，装配（`session-assembly.ts`）：

1. **能力层白名单**：`createAgentSession({ tools: DOC_TOOLS_WHITELIST })`，其中
   `DOC_TOOLS_WHITELIST = ["create_artifact","propose_edit","list_artifacts","get_artifact_diff","list_my_artifacts","get_artifact_history","read","grep","glob","list"]` —— **物理不含 write / edit / bash**（AC-1.3 的直接落点）。
2. **双保险 excludeTools**：`excludeTools: ["write","edit","bash"]`（防白名单漏网）。
3. **受管路径 tool_call 守卫**（protected-paths.ts 范式 + 正本 §5.4）：`tool_call` 拦截对**任何**工具调用的参数做受管路径扫描（目标路径命中 `<projectRoot>/.nextstep/artifacts/managed/**` 的物化文件集合）→ `{ block: true, reason: "受管文档禁止直写，请用 propose_edit" }`。第一期 doc 模式无 write/edit/bash，本守卫是防御纵深 + S5④「受管路径直写被硬挡」的可断言载体（测试用伪造 tool_call 断言 block）。
4. **EXTERNAL_MODIFIED 兜底（D10）**：即使绕过上述两层（如未来 coding 模式配 write），物化前内容比对仍然生效（旧仓 `artifact-service.ts:130-144` 原样搬）。

> 注：coding 模式（原始 write/edit/bash + 配发受管文档工具族）属 D10 已拍板但**第二期**落地（依赖 agent-profiles）；第一期只实现 doc 装配路径。

---

## 6. 薄 server（L3 Web 壳后端）最小接口表

> 壳零领域判断：每个端点 = 参数解析（校验来自用户输入）→ 直调 L1 领域服务 / 经 L2 AuditPort 工厂写审计条目 → 序列化返回。**无任何领域逻辑在 server 层**；写盘只发生在 L1 的 resolveAndMaterialize / rollback（旧仓红线「写盘只在此处发生」，`pending-change-service.ts:355-356` 注释语义）。

| 方法 & 路径 | 直调 L1 | 审计条目 | 对应场景 |
|---|---|---|---|
| `GET /api/artifacts` | `ArtifactService.listArtifacts` | — | S1 打开面板 |
| `GET /api/artifacts/:id` | `getArtifact` + `listVersions` + `checkExternalModification`（新，见下） | — | S1 内联渲染 / S3 版本链 / S4 手改检测 |
| `GET /api/artifacts/:id/pending` | `PendingChangeStore.listPendingChanges` + presentation 构建 | — | S1 待确认态 |
| `POST /api/artifacts/:id/pending/:changeId/resolve` `{ blockId?, action }` | `resolveAndMaterialize`（L1 baseVersion 校验） | `approval_response`（via: web-panel）+ `artifact_resolved` | S1 写回 / S2 批量 |
| `POST /api/artifacts/:id/rollback` `{ version }` | `rollbackWithAudit`（§3） | `artifact_rollback`（undoing: false） | S3 |
| `POST /api/artifacts/:id/rollback/undo` `{ version }` | 同上（以目标版再回滚一次） | `artifact_rollback`（undoing: true） | S3 撤销回滚 |
| `GET /api/artifacts/:id/external/diff` | `checkExternalModification` + 差异快照 | — | S4 查看 diff |
| `POST /api/artifacts/:id/external/merge` | 外部内容 → `proposeWithGate`（entry 端口语义：落盘待确认，面板继续逐块） | `artifact_proposed` | S4 以提案方式合并 |
| `POST /api/artifacts/:id/external/reject` | 重物化当前版内容覆盖 + 审计 | 见 H3 | S4 拒绝采纳 |
| `GET /api/sessions` | 读会话 JSONL（CLI 会话 + Web 面板会话，只读） | — | 回放一致性 |

**新增 L1 服务（Web 面板专用，纯逻辑可单测）**：

```ts
/** 外部手改检测（旧仓比对逻辑 :130-144 抽成公共函数）：读真实文件 vs 当前版快照 content，逐字节比对。
 * 第一期由面板「打开时 + 每次渲染前」调用（旧仓只在写盘前检测；面板侧是显示层检测，写盘前检测原样保留）。 */
checkExternalModification(projectId, artifactId): { modified: boolean; onDiskExcerpt?: string };

/** 面板渲染用的版本间差异（get_artifact_diff 的 server 侧等价，同一 LCS 实现）。 */
diffBetweenVersions(projectId, artifactId, fromVersion, toVersion): DiffBlockPresentation[];
```

---

## 7. 测试计划骨架（三层；每条 AC-1.x + S1–S5 至少一个可执行断言）

### 7.1 L1 纯单测（vitest；内存临时目录后端，不碰 pi）

| 断言 | 覆盖 |
|---|---|
| 迁移回归：旧仓单测平移（artifact-service / pending-change-service / lcs 全部既有用例在新仓跑绿） | 原样搬护栏 |
| baseVersion 匹配 → resolveAndMaterialize 物化成功；上游先 rollback 一次 → resolve 抛 BASE_VERSION_CONFLICT、pending 文件保留 | 调查缺口② / S3 冲突路径 |
| 旧 pending 无 baseVersion → 读取即校验失败提示重新提案 | 兼容语义 |
| `applyResolvedBlocks` 不变量：全 confirmed = newContent；全 rejected/pending = oldContent；块数失配抛 INVALID（旧仓 :165-198 既有断言） | 部分确认重建（S1④ 被拒块不进 v4） |
| 乐观锁：If-Match 失配 → VERSION_CONFLICT（旧仓 :414-421） | 并发兜底 |
| EXTERNAL_MODIFIED：写盘前外部改文件 → 干净失败；`checkExternalModification` 返回 modified | S4 / 旧仓 :130-144 |
| 回滚 = 追加新版：rollback 后版本链长度 +1、旧版全在、物化文件 = 目标版内容 | S3 ①-③ / 旧仓 :324-365 |
| gate 全流程（stub DecisionPort）：5 块全收 → v4 物化、2 收 3 拒 → v4 = v3 + 被收块 | S1 / S2 |
| 审计序列：propose → ask → 全决后 JSONL 依次出现 artifact_proposed / approval_request / approval_response / artifact_resolved（via/decisions 字段断言）；rollback 出现 artifact_rollback | S1⑤ / S3④ |
| sourceRefs：confirmed 块数 = sourceRefs 条数；每条的 artifactId/version/blockAnchor 行区间与 diff 一致 | M2a 只写 |
| presentation 构建：5 块提案的 Presentation 与原型结构对齐（blocks 数 / kind / tag / anchor / note） | 承重实证（数据侧） |

### 7.2 L2 集成测试（`SessionManager.inMemory()` + stub 模型，无真实 API）

| 断言 | 覆盖 |
|---|---|
| doc 会话装配后 `session` 工具注册表**不含** write/edit/bash（白名单 + excludeTools 生效） | AC-1.3 / S5① |
| 六工具全部可调用：create_artifact → propose_edit（stub CliDecisionPort 逐块 y/n）→ 物化 → list_artifacts / get_artifact_history 可见新版本 | AC-1.1 / S5③ |
| get_artifact_diff 返回块数与同版本 PendingChange 的 diffBlocks 数一致（同一 LCS） | AC-1.2 |
| 只读三工具调用后：pending 目录为空、版本链不变、无任何新审计条目 | AC-1.4 |
| 受管路径守卫：伪造 write 到受管 .md 的 tool_call → `{ block: true }` | S5④ / D10 |
| propose_edit 有未决时二次调用 → 返回引导先处理（旧仓 :178-186） | 防叠加 |
| 审计条目确实**不进 LLM 上下文**：stub 模型收到的 messages 中无自定义条目内容 | §5.3 / M2a |
| EntryDecisionPort：ask → 只写 approval_request(pending) 且返回 deferred，无阻塞 | 冻结注记 |

### 7.3 Web E2E（真浏览器；fixture JSONL + 预置领域存储；Playwright）

| 断言 | 覆盖 |
|---|---|
| S1 全流程：5 块内联高亮嵌原位（绿+/红−）；逐块 ✓/✗ 三色即时变化、进度 0/5→5/5；有待定块时写回禁用；写回后 v4 物化、被拒块不进 v4（读物化文件断言）；面板会话 JSONL 有 approval_response（via: web-panel） | S1 ①-⑤ |
| S2：全部接受一键后无待定块；单块仍可翻转（混合档）；写回后 v4 = 提案全文 | S2 |
| S3：版本链抽屉 v1–v4 归属/时间/摘要完整；回滚 v2 → v5 正文切换（§4 恢复、提案块灰化「未生效」）、回滚报告横幅（撤销 5 块、确认过 N 块、appendEntry 注记）、「查看差异」「撤销回滚」动作存在；撤销回滚 → v6 = v4 内容、回滚版仍在链上 | S3 ①-⑤ |
| S4：外部手改（测试先改物化文件）→ 打开面板见警告横幅、版本操作冻结；「查看 diff」可见差异；「以提案方式合并」后走逐块确认；「拒绝采纳」后物化文件恢复系统版本 | S4 ①-③ |
| 一致性（通道①）：CLI 侧（L2 集成/真机）物化 v4 → Web 面板重载显示 v4；Web 面板写回 → CLI 侧 `list_artifacts` / `get_artifact_history` 读到新版本 | 唯一真相 JSONL / S5③ |

### 7.4 出口判据映射（PRD）

| 出口判据 | 断言来源 |
|---|---|
| AC-1.1~1.4 全绿 | 7.1（数据侧）+ 7.2（AC-1.3/1.4 主战场）+ 7.3（真浏览器） |
| F1 在纯 CLI 端到端成立 | 7.2 全流程（inMemory）+ 真机 S5 冒烟（手动清单：create → propose → 汇总卡 → 物化） |
| EXTERNAL_MODIFIED 保护实测有效 | 7.1（L1 干净失败）+ 7.3 S4（面板提示三动作） |
| presentation 纯数据 + 通用渲染器承重实证 | 7.1（presentation 构建）+ 7.3（Web 渲染与原型 85 项断言对齐）+ CLI 渲染走查 |

---

## 8. 待确认假设清单（集中列出，不自行拍板）

| # | 假设 / 待确认点 | 建议（设计倾向） | 影响面 |
|---|---|---|---|
| H1 | fork 后实证 `CONFIG_DIR_NAME` 是否同时控制**项目级** `.pi` 目录名（调查结论四只确认用户级 rebrand 支持） | 若只影响用户级，项目级领域存储目录手动定为 `<projectRoot>/.nextstep/` 并与 fork 内核的项目级配置保持一致 | 迁移清单路径、ProjectRegistry |
| H2 | Web 面板审计条目落「独立固定会话文件」（`web-panel.jsonl`，Web server 是唯一 writer）而非真 `fork(entryId, {position:"at"})` 分支 | 第一期无 entry 级操作需求，固定文件已满足单 writer + 可回放；真 fork 语义留第四期壳完善 | §5.3 单 writer 落地、审计跨文件合并（第三期归因时处理） |
| H3 | 外部手改「拒绝采纳 / 以提案合并」动作的审计条目类型：五类审计族未覆盖 | 建议新增 `artifact_external_resolved`（第六类，含 action: merge\|reject），或并入 `artifact_resolved` 以 note 区分——评审定夺 | §1.3 条目族、S4 |
| H4 | 「拒绝采纳」是否生成新版本 | 建议**不生成**（内容未变，只重物化 + 审计条目）；如需版本链留痕可生成 `v{n+1} = v{n}` | rollback 语义边界、S4③ |
| H5 | 第一期 Web 面板的「当前项目」来源 | 建议 server 启动读 ProjectRegistry 项目列表 + 面板顶部项目下拉；单用户单项目场景默认聚焦 | 薄 server 端点签名 |
| H6 | blockAnchor 的 heading 推导「尽力而为」是否可接受 | 建议接受：行区间是硬锚（LCS 可复现），heading 仅辅助可读；第三期 trace_defect 消费时再定细化格式 | §1.2 sourceRef schema |

---

## 9. 本阶段不做（复核，防范围回潮）

- 多 Agent / 编排 / agent-profiles（第二期）；trace_defect 归因查询（第三期）；DAG 画布 / 并行 run（冻结 v2.2）；M5 自动沉淀与手动演化入口（D3 冻结/排后期）；Recipe 迁移（第二期）；组件库 / 数据库 / 多用户 / 云端 / 部署链（N 清单）。
- HarnessAdapter 第 5 动作（spawnSubagent）只实现 + 单测，不接线（第二期 M4 消费）。
- 会话级实时感知（通道② file-trigger watcher）不进第一期；第一期只有通道①（读时自然同步）。

STATUS: DRAFTED —— 阶段一完成，待评审
