# T1-11 验收报告 · 薄 server（L3 Web 壳后端，verifier 独立复核）

> 复核人：verifier（round-1，2026-08-18）
> 对象：git 未提交改动——5 个 M（.gitignore、apps/web 的 package.json / tsconfig.json / vitest.config.ts、package-lock.json）+ untracked（`apps/web/server/` 五文件、`apps/web/scripts/build-server.mjs`）
> 方法：干净态双门禁复跑 + pi 0.84.2 node_modules 源码独立复验架构裁定 + verifier 自写 4 条 fetch 驱动（fixture/断言全自造，跑完即删）+ 生产冒烟独立复跑（隔离 HOME 种子数据、双实例锁、信号释放、bundle 理由实证）+ 壳零领域判断全文件代码审查

---

## 一、干净态双门禁

`rm -rf node_modules`（根 + next-step-pi + web 三处）→ `npm install` → `npm run typecheck` → `npm test`：

| 步骤 | 结果 |
|---|---|
| `npm install` | exit 0（allow-scripts 警告为环境策略提示，非错误） |
| `npm run typecheck` | 2 workspaces（pi / web）`tsc --noEmit` 全过，**0 错误**（T1-10 教训的 typecheck 门禁未重蹈） |
| `npm test` | **Test Files 18 passed，Tests 259 passed**，Duration 1.82s |

零回归对账：259 = T1-10 验收基线 **238**（T1-10-verify.md 原文数字）+ 本卡新增 **21**（server.test.ts，vitest 输出单列确认）。与实现者声明「259/259（238 零回归 + 21）」一致。

## 二、架构裁定裁决（重点项：审计不经 pi SessionManager，改 WebPanelSessionManager 直写 JSONL）

### 理由①「纯 custom 条目不落盘」——独立验证成立，且对该场景是**永久性**不落盘

pi 0.84.2 `dist/core/session-manager.js` `_persist`（L724-750）逐行复核：

```js
const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
if (!hasAssistant) { /* flushed 标记后直接 return，不写文件 */ return; }
// 首条 assistant 到场：openSync(wx) 全量补写此前缓冲，置 flushed
```

`_setSessionFile`（L1136-1141）注释同证："creates the file on the first assistant response"。Web server 进程内**永远不会产生 assistant 消息**（不跑 LLM 循环，只写审计 custom 条目），故经 SessionManager 写审计不是「启动窗口期延迟可见」，而是**无限期滞留内存**——对该场景理由①严格成立（T1-07 §五·1 前置事实在本场景的适用性由 verifier 独立确认，非转引）。

### 理由②「红线被打破」——成立

- `grep -rn "earendil|pi-coding-agent" apps/web/`（排 node_modules）**零命中**（exit 1）——实现确实零 pi import。
- 若构造真 SessionManager，apps/web 必须直接 `import "@earendil-works/pi-coding-agent"`（SessionManager 无包装工厂可绕），违反详设 §2.3/H2「Web 经 L2 工厂，不直接 import pi」（ADR-001 B 后红线形态为文件夹边界 + 该条 H2 落点，语义未变）。理由②成立。
- 附验：`src/domain/` 零 pi import 红线保持（3 处 earendil 命中全为 README 说明与自检测试的字面量，且 `gate/ports.test.ts` 有固化自检测试在跑）；apps/web 对包的 import 面全部落在 `src/domain/*` 与 `src/ports/audit-port.ts`，零 `src/pi/` 引用。

### 直写方案三质量点

| 质量点 | verifier 独立证据 | 判定 |
|---|---|---|
| **行格式与 pi appendCustomEntry 产物同构** | pi 源码 L820-830：custom 条目恰 `{type:"custom", customType, data, id, parentId, timestamp}` 六字段；驱动对 web-panel.jsonl 每行断言 key 集合恰同六字段、type/customType/ns 全对——逐字段同构。两处差异均无害且已声明：id 格式（pi=会话内 8 截断 UUID / web=完整 UUID v4，不透明唯一串，合并时无语义影响）、无会话 header 行（文件级差异，行级同构；parentId 恒 null 是 P2-1 已登记代价） | 过 |
| **并发写安全（单 writer 锁 + 追加写）** | 进程内：appendFileSync 同步追加，异步 handler 间无交错可能；跨进程：`wx` 原子独占锁文件——冒烟实测第二实例 exit 1 + 明确报错；SIGTERM → exit(0) → 锁删除（实测）；崩溃路径（EADDRINUSE 未捕获错误退出）exit handler 仍执行、无残留锁（实测）。残余：SIGKILL 残留锁需手删（报错文案已引导，P3 量级）；锁只在生产入口 index.ts 强制（注释已声明，测试旁路合理） | 过 |
| **审计完整性（P1-4 面板读回可行性）** | 驱动逐行 JSON.parse 全成功（无半行/交错）；写后即刻可见（同步写，不依赖任何 flush 事件——正是理由①要保的性质）；跨进程重启 append-only 不丢（冒烟两代进程各写一行共 2 行）；按 data.kind 计数即可回读（链路②驱动做了全套计数断言） | 过 |

### 裁定

**维持直写方案 + 登记后续**。两条理由经独立验证均成立，改向无路：真 SessionManager 在该场景永久不落盘（理由①），伪造 assistant 消息逼 flush 会污染审计文件且仍需 apps/web import pi（理由②）。仍经 L2 工厂 `createEntryAuditPort`（src/ports）获得 AuditPort、行格式行级同构——第三期跨文件合并的迁移成本已被压到「id 格式差异 + 无 header + 无 parentId」三条已知项。**登记后续**：①第三期合并审计设计时须对照彼时 pi 版本复验行格式（pi 0.x 无格式冻结保证，pin 0.84.2 + 显式回归是本项目既有纪律）；②若出现第二个直写消费方，考虑把 WebPanelSessionManager 上收进 src/ports（当前单消费方放 apps/web 合理）。

## 三、端点独立驱动（4/4，自写 fetch 脚本已删）

| # | 驱动 | 结果 |
|---|---|---|
| 链路① | **混合裁决 2 收 3 拒**：10 行内容隔行改 5 处 → merge（deferred）→ GET pending 恰 5 块 → 逐块拒 3（各 materialized:false，中途状态恰 [rejected,pending,rejected,pending,rejected]）→ 全收剩余 → 物化 v2。**物化文件逐行断言**（被拒块旧行/被收块新行恰十行如预期）；pending 删空；web-panel.jsonl 行序 `artifact_proposed → approval_request → artifact_external_resolved → approval_response → artifact_resolved`；approval_response decisions 恰 5 块按文档序 [reject,accept,reject,accept,reject]；artifact_resolved acceptedBlocks/rejectedBlocks 各恰 2/3、sourceRefs 恰 2（M2a） | 过 |
| 链路② | **守卫与冲突闭环（HTTP 层）**：造 pending → rollback **409 PENDING_EXISTS 文案逐字**「有待确认提案未处理，暂不可回滚」+ 版本无副作用 → discard（审计 approval_response status:"discarded"、decisions:[]、note 透传）→ rollback 成功（v3=v1 内容、artifact_rollback undoing:false note:"rollback to v1"）→ **重新提案成功**（merge → 全收 → v4=新内容，死锁环闭合）→ undo 契约（P2-8：version=2 → v5=v2 内容、undoing:true）；全套审计计数恰 {proposed 3, request 3, external_resolved 3, response 3(2 resolved+1 discarded), resolved 2, rollback 2} | 过 |
| 链路③ | **reject 外部手改**：手改 → GET :id external.modified:true → reject → 物化文件=当前版内容、currentVersion 1 不变、versions 恰 1（**无幽灵版本**，H4）、modified 归 false、审计 artifact_external_resolved action:"reject" | 过 |
| 错误映射 | 404（未知 artifact / 未知路由 / 未知 changeId）；409 EXTERNAL_MODIFIED（pending 期间再手改 → resolve 被物化前检测拦截）；409 BASE_VERSION_CONFLICT（fixture 经 L1 上游撞版，断言在 HTTP 层：引导文案在 + **pending 保留现场**）；422（action 非法 / version 非整数 / body 非对象）；参数校验先于 L1 守卫的次序与源码一致（version:"1" + 有 pending → 422 非 409） | 过 |

首跑 1 失败系 **verifier 自身断言错**（给 artifact_rollback 载荷断言了设计 §1.3 schema 里本就不存在的 `via` 字段——详设仅 ApprovalResponse 有 via），修正后 4/4。实现者的 21 项测试同套件干净态全绿，覆盖 10 端点逐一 + 壳零领域静态自检（2 it），抽查无空洞断言。

## 四、生产冒烟独立复跑（隔离 HOME=/tmp 种子，未污染真实 ~/.nextstep）

| 步骤 | 结果 |
|---|---|
| `npm run server`（esbuild bundle 63.1kb / 9ms → node 直跑） | 启动 8787，日志报审计文件路径 |
| 读链路 | GET /api/artifacts → 项目下拉（H5：从默认注册表路径读到 verifier 手工种子项目）；?projectId= → artifact 列表；GET :id → 详情+版本链+external 检测，全与种子一致——**生产装配确实读文档承诺的默认路径**（H5 与 CLI 共用注册表） |
| 写链路 | POST /rollback {version:1} → {fromVersion:2,toVersion:1,newVersion:3}；物化文件恢复 v1 内容；**web-panel.jsonl 出现同构 custom 行**（六字段，data.kind=artifact_rollback） |
| 双实例锁 | 第二实例（同 HOME）exit 1，报「单 writer 独占检查失败：锁文件已存在…请先停止另一实例」 |
| 锁释放与续写 | 对 node 进程 SIGTERM → 进程退、端口释放、**锁文件删除**；重启成功再写一笔 rollback → 文件累计 2 行（两代进程 append-only 不丢，P1-4 回读可行）；崩溃路径（EADDRINUSE）exit handler 仍执行、无残留锁 |
| bundle 形态注记抽验 | `node server/index.ts` 直跑实证失败：`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode`（pi 包源码参数属性），且包内相对 import 无扩展（如 project-registry.ts `from "../config/paths"`）Node ESM 不解析——README「改 pi 包源码越界故 bundle」的说法成立 |

附带发现（操作层，非缺陷）：`kill` npm 包装层不波及 node 子进程（npm 不转发信号），停服须对 node 进程发信号。

## 五、壳零领域判断（create-server.ts 全文件代码审查）

结构 = 路由表 + 参数校验 + L1 直调 + 错误映射，与卡面红线一致：

- **零领域决策分支**：全部 if 属三类——参数合法性（→422）、`external.modified` 的有数/无数分支（呈现层组装）、mapError 的 code→HTTP 状态（详设 §6 明文「code 由 API 层映射」，序列化层职责）。守卫文案全部来自 L1（PENDING_EXISTS 文案在 gate，驱动逐字断言透传）；BASE_VERSION_CONFLICT 的引导后缀按任务卡明示由端点层附加。
- **两处词汇映射属翻译非决策**：resolve 的 `accept→confirm`（裁决词→L1 动作词，注释自证同 L2 工具翻译层职责）；审计 decisions 从 change 终态推导（`confirmed→accept`）——对 L1 结果的序列化记账（见 P3-2 观察）。
- **零项目定位判断**：带 :id 端点一律 `findArtifact` 跨项目反查，server 不判断归属。
- **写盘零越界**：server 不调 submitVersion/save/remove/rollback/原子写（实现者静态自检测试 + verifier 源码复核双确认）；写盘全在 L1（resolveAndMaterialize/rollback/reject 覆盖物化）。
- external/diff 的差异快照 = L1 纯函数 computeReplaceDiffBlocks + materializedAbsPath + getArtifact 组装，无规则分支。

**判定：壳零领域判断成立**（卡内代码审查项过）。

## 六、红线与裁量登记

| 项 | 结果 |
|---|---|
| apps/web 零 pi import | 过（grep 零命中；import 面 = src/domain/* + src/ports/audit-port，零 src/pi） |
| H2/P2-1 裁量登记 | 过——README「审计通道与裁量登记」节 + web-panel-audit.ts 文件头双落档，内容含卡面要求三要素：固定文件替代真 fork 的正本 §5.2 裁量声明、代价（无 parentId 血缘、跨文件合并推迟第三期）、单 writer 自守 |
| GET /api/sessions 不回潮（P2-2） | 过——路由表恰 10 条，无 sessions |
| 端点表与详设 §6 对齐 | 过（10/10；P2-2 修订形态）；merge 审计实现为 artifact_proposed + artifact_external_resolved(merge) 双写（详设表格只列前者、实现是超集且与 H3 第六类一致，README 按实际 documenting） |
| P3 单进程假设 | 过——启动独占检查实测有效（见四） |

## 七、分级 findings（无阻塞项）

| 级 | 项 | 说明 |
|---|---|---|
| INFO（继承） | `~/.nextstep`（注释/README）vs `~/nextstep`（运行时实际） | `NEXTSTEP_DIR_NAME="nextstep"` 无点，T1-01 P3-1 已登记的跨卡张力，H1 实证裁决至今未落。本卡代码正确走常量（单点纪律对），但 index.ts 注释与 README 两处新写了带点的 `~/.nextstep/...`——文档口径跟了设计文档而非常量真值（冒烟日志实际路径为 `home/nextstep/`）。建议措辞随常量或标注「随 H1 裁决」；不阻塞 |
| P3-1 | 设计 §6 的 `diffBetweenVersions` L1 服务未实现且未登记 | 详设 §6「新增 L1 服务」列了两条，checkExternalModification 落了（T1-06），diffBetweenVersions 无任何卡承接、无端点消费（第一期版本间 diff 从 pending presentation 走）。属设计→任务卡翻译缺口非实现者私自裁剪；建议在进度或设计文档登记该 consciously cut，T1-12 面板若需版本间 diff 再捞回 |
| P3-2 | resolve 端点内联 decisions 词汇映射 | `b.state === "confirmed" ? "accept" : "reject"` 在壳内复制了 L1 状态名词汇——序列化级、类型安全（DiffBlock 类型漂移会编译红），可接受；若 L1 状态更名此行是隐性耦合点，记录备查 |
| P3-3 | SIGKILL 残留锁需手删 | 单 writer 锁无 owner 存活校验；报错文案已引导手动处理，P3 单进程假设内可接受，第三期多实例化时再上 pid/心跳校验 |

## 结论

干净态双门禁全绿（typecheck 0 错 + 259/259，238 零回归 + 21 对账吻合）；**架构裁定裁决：维持直写 + 登记后续**——两条理由（pi `_persist` 纯 custom 永不落盘〔该场景无 assistant〕、apps/web 零 pi import 红线）经 pi 源码与 grep 独立复验成立，三质量点（六字段行级同构、单 writer 锁实测、append-only 即刻可读回）全部独立证实；verifier 自写 4 条 fetch 驱动全过（混合裁决物化逐行/死锁闭环/无幽灵版本/错误映射全覆盖）；生产冒烟独立复跑通（H5 默认路径读、写+审计落生产路径、双实例锁拒、SIGTERM 释放+重启续写、bundle 理由经 `node index.ts` 直跑失败实证）；壳零领域判断经全文件代码审查成立；P2-1 裁量登记双落档。findings 仅 INFO×1（继承的目录名口径）+ P3×3，无阻塞。haiku 实现质量高：卡面 10 端点/错误映射/审计裁量全部落地且与设计一致，裁量理由的注释陈述完整到可直接复核，测试含壳零领域的可执行静态自检——瑕疵止于文档口径与一处设计项未登记裁剪。

STATUS: PASS —— 干净态 typecheck 0 错 + 259/259（238 零回归 + 21 对账吻合）；架构裁定裁决「维持 WebPanelSessionManager 直写 + 登记后续」（pi _persist 无 assistant 永不落盘与零 pi import 红线两理由独立验证成立，行格式六字段同构/单 writer 锁/即刻可读回三质量点实测通过）；verifier 自写 4 条 fetch 驱动全过（2 收 3 拒逐行物化、409→discard→重提案死锁闭环、reject 无幽灵版本、404/409/422 映射）；生产冒烟独立复跑（默认路径读写、双实例锁拒、SIGTERM 释放重启续写、bundle 理由实证）；壳零领域判断过；裁量登记落档；无阻塞 findings（INFO×1 继承 + P3×3）
