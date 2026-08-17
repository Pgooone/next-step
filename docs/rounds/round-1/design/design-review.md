# 设计评审 · round-1（概要 + 详细设计）

> 评审人：独立 design-reviewer / 评审时间：2026-08-17
> 评审对象：`high-level-design.md`、`detailed-design.md`（状态 DRAFTED）
> 依据（冲突时以下列为准）：正本 v3.4（§2 红线、§5 分层与三规约、§6 M1/M2a AC、§7 迁移清单、§9 D1–D10、§10 第一期）、round-1 PRD（S1–S5 + 基线冻结声明）、QA 两份调查、旧仓源码抽查（`/home/pgoone/GitHubproject/Next-Step/next-step-V1.2/lib/domain/`、`lib/pi/doc-tools.ts`）、原型走查报告（85 项断言 + 复走二）
> 方法：逐条对照 + 旧仓 file:line 锚点抽查（已核实：PendingChange :39-49 / buildReplacePendingChange :205-223 / resolveAndMaterialize :360-382 / applyResolvedBlocks :165-198 / assertVersionMatch :414-421 / assertNotExternallyModified :130-144 / rollback :324-365 / doc-tools :105-252 全部与设计引用一致）

---

## A. 起草人自报三挑战点裁决

### A1 · propose_edit 确认点收敛进工具执行内（pending-gate-service + CliDecisionPort.ask 同步阻塞）

**裁决：方向成立，但失败路径未定义、实证场景混用，需补三处。**

1. **与 D6 不矛盾，与正本一致**。正本 §10 第一期的执行序「propose_edit → CliDecisionPort（ctx.ui 逐块 y/n）→ 物化留版」与设计收敛一致；「独立命令式确认」（工具返回已提案、用户另发命令）反而需要额外 registerCommand，与 HarnessAdapter 恰好 6 动作、工具集恰好 6 个的纪律冲突。D6 的「汇总卡+快捷键」是呈现层交互，两种承载（工具内阻塞 / 独立命令）都能实现它——工具内阻塞是更简且与正本序一致的选择。**不矛盾，采纳**。

2. **阻塞期间用户取消 / agent 超时 / 会话 fork 的行为全部未定义**（P1-1）。`Decision` 类型只有 `resolved | deferred`，无取消/中止分支；`NextStepToolDef.execute(args, signal)` 的 AbortSignal 在 ask 阻塞期间 abort 时 pending 文件去向（保留/删除）未定；用户 Ctrl+C / 取消确认后工具返回什么、agent 下一回合如何被告知——未定。更隐蔽的是：**「重新提案」会被 proposeWithGate 步骤 1 的「查未决」挡住**，取消后 pending 留在存储态，agent 无法推进。修复：Decision 加取消分支（或明确定义「abort/取消 → 工具返回『已提案未确认，changeId=…，可用 Web 面板或重试处理』文本，pending 保留」），并为每条路径配断言。

3. **「官方 permission-gate 同款，实证可行」是场景混用**（P1-1）。正本 §5.4 实证的是 **tool_call 拦截器事件处理器内** await `ctx.ui.confirm`（确认后工具照常执行）；设计把确认放在**工具 execute 内部**（proposeWithGate 在 execute 里 await ask），且交互模型是「汇总卡 + 快捷键反复翻转 + 即时上屏」——ctx.ui 的 select/confirm/input 原语能否承载多轮状态交互（不是 permission-gate 的单次 confirm）**从未实证**。原型走查只实证了 Web 呈现，CLI 汇总卡交互是零实证。修复：新增 H7 假设（execute 内 ctx.ui 可用性与能力边界）+ 明确 D6 保底路径（B 逐块流式 = 逐块 confirm 序列，退化不丢 F1）+ 拆卡时列为 propose_edit 卡的实现前 spike。

### A2 · Web 审计条目落独立 web-panel.jsonl 而非真 fork

**裁决：成立，不违反 S1⑤ 与 §5.2 单 writer；但偏离正本字面需登记裁量。**

- **S1⑤「每次裁决落入 append-only 日志」**：Web 面板裁决写 `approval_response`（via: web-panel）进 web-panel.jsonl——逐字满足；`via` 字段同时兑现 dsh 借的设计「append-only 日志按来源可检视」（正本 §4 N2）。
- **§5.2 规约 3（单 writer）**：固定独立文件 + Web server 唯一 writer = 规约的忠实实现。正本「Web 想『写』就 `fork(entryId,{position:"at"})` 出自己的分支」是规约的**示例性落法**而非独立约束；设计以「第一期无 entry 级操作需求」为由改固定文件，理由成立（fork 的父子分支血缘与 /tree 可见性第一期无消费者）。
- **代价需显式登记**（P2-1）：真 fork 分支带 parentId 血缘、CLI `/tree` 可溯源；web-panel.jsonl 是独立 session，无血缘，第三期归因的「跨文件审计合并」要自己搭。设计 H2 已注「第三期归因时处理」——建议把「偏离 §5.2 fork 字面的实现裁量」登记进设计决策记录（哪怕一行），并在测试计划注明第一期不承诺跨文件合并。
- **审计完整性盲区**：第一期对「跨文件审计序列可合并排序」无任何断言——建议 7.3 补一条「同一 artifact 的 CLI 条目与 Web 条目按 ts 合并后构成完整操作史」的轻量断言，或显式注明推迟第三期。

### A3 · BASE_VERSION_CONFLICT 后的恢复路径

**裁决：不成立——恢复路径死锁，且原型已实证的守卫在设计中丢失。P1-2（本期必落卡）。**

1. **死锁成立**：冲突后 pending 无法 resolve（baseVersion 校验在 resolveAndMaterialize 内，先于 applyResolvedBlocks 即失败）、无任何删除/放弃 pending 的路径（端点表无 discard、CLI 无命令）、重新提案被 proposeWithGate 步骤 1「查未决」挡住（旧仓 doc-tools.ts:178-186 语义原样保留）——**三条路全断**。设计 1.1 写「pending 文件保留（保留现场供重新提案比对）」——比对完没有出口。「兼容：旧 pending 无 baseVersion → 校验直接失败并提示重新提案」同样死锁。**「重新提案时覆盖还是并存」设计未答**——并存不允（查未决挡），覆盖=discard 后重建，但 discard 不存在。
2. **守卫丢失放大触发面**：原型复走二实证「有待确认提案未处理，暂不可回滚」（历史行回滚禁用，PASS）；详细设计 §6 rollback 端点、§7.3 S3 断言均未体现该守卫。若守卫在，baseVersion 冲突收敛为「并发窗口兜底」（低频）；若不在，**「CLI propose 挂起 + Web 回滚」是 S1+S3 场景的自然组合（第一期主场景路径）**，必撞冲突、必死锁。
3. 修复（三条全落卡）：
   - `rollbackWithAudit` / rollback 端点补「存在未决 pending → 拒绝回滚」守卫（对齐原型实证，reuse 提示文案）；
   - 新增 discard 路径：`POST /api/artifacts/:id/pending/:changeId/discard`（直调 `PendingChangeStore.remove` + 审计条目，CLI 侧由 propose_edit 的冲突返回文本引导）；
   - 7.1 补断言链：「resolve 抛 BASE_VERSION_CONFLICT → discard → 重新提案成功」，闭环恢复路径。

---

## B. 硬性约束逐条核对

| # | 约束 | 裁决 | 说明 |
|---|---|---|---|
| B1 | L1 零 pi import | ✅ | 概要 §2/§4 + 详细 §2.1/§2.3 全部满足；HarnessAdapter 类型、DecisionPort/AuditPort、NextStepToolDef 均为 L1 自有类型，无 pi 类型泄漏（AbortSignal 是平台全局非 pi 类型）；L3 Web server 只经 L2 工厂拿 AuditPort，不直接 import pi |
| B2 | HarnessAdapter 恰好 6 动作不预留 | ✅ | 与正本 §5.1 逐字一致；第 5 动作实现+单测不接线 ✓。**瑕疵**：getContextUsage（动作 6）无任何消费点（P2-7，见 D 节） |
| B3 | 闸门只认 DecisionPort | ✅ | §2.1 红线 + 代码审查项齐全；Web resolve 端点不经 DecisionPort 有冻结注记 + 「问的对象已是人」语义支撑，不违反（P3 备忘：§6 明示一句） |
| B4 | sourceRef 由工具写入 | ✅ | §1.2 模型不产出 + L1 gate 构建 + appendEntry 存储 + M2a 只写不查 + 测试断言，全部到位 |
| B5 | 旧仓三服务语义原样搬 | ✅ | 抽查全部锚点属实；唯一改动（PendingChange+baseVersion、buildReplacePendingChange 入参、resolveAndMaterialize 校验）均给理由（调查缺口②）；create_artifact「registry 换 .nextstep」注明是 D9 延伸 |
| B6 | D1–D10 拍板不回退 | ✅ | fork 只品牌层 + UPSTREAM 纪律 ✓；D6 分档/记账块级/CLI A 主 B 可选/Web B 目标 A 保底 ✓；D7/D8/D9/D10 全部落实；冻结注记原文照录 ✓ |
| B7 | AC-1.1~1.4 + S1–S5 断言映射 | ⚠️ 全覆盖但两条断言不可执行/漂移 | AC-1.2 断言对象漂移且技术不可执行（P1-6）；S3④ 回滚报告数据源缺口（P1-4）；approval_request 序列断言不可执行（P1-3） |
| B8 | 范围不回潮 | ⚠️ 一处轻微 | `GET /api/sessions`（§6）无 S1–S5 消费场景，疑似回潮苗头（P2-2） |

B 节无 P0。

---

## C. H1–H6 裁决建议

| # | 假设 | 裁决 | 一句话理由 |
|---|---|---|---|
| H1 | CONFIG_DIR_NAME 是否控制项目级目录 | **采纳设计倾向** | fork 后实证属实现期 spike；落卡要求：`.nextstep` 路径常量单点定义（迁移清单 + ProjectRegistry 共用一处），实证后只改一处 |
| H2 | web-panel.jsonl 固定文件 vs 真 fork | **采纳** | 单 writer 自守成立、S1⑤ 满足、无 entry 级操作需求；代价（无血缘、跨文件合并推迟第三期）显式登记（P2-1） |
| H3 | 外部手改处理动作的审计条目类型 | **改向：新增第六类 `artifact_external_resolved`**（action: merge\|reject），必须本期定 | ①拒绝采纳不是 PendingChange 全决物化（无 diffBlocks、无新版本），并入 artifact_resolved 污染其 schema（acceptedBlocks/sourceRefs 无意义）；②「拒绝采纳」是一次裁决，S1⑤ 需类型承接；③第三期归因不该解析 note 字符串。定案即冻结条目族 v1，后续加类型走扩展流程 |
| H4 | 「拒绝采纳」是否生成新版本 | **采纳：不生成** | 内容=当前版无变化，生成 v{n+1}=v{n} 是幽灵版本，污染 get_artifact_history 消费；审计条目已留痕。若未来要链上留痕走第三期 |
| H5 | Web 面板「当前项目」来源 | **采纳** | server 读 ProjectRegistry + 顶部下拉，单项目默认聚焦；旧仓 project-registry.ts 搬+适配（正本 §7 同） |
| H6 | blockAnchor heading 尽力而为 | **采纳** | 行区间硬锚可复现、heading 仅可读；第三期 trace_defect 消费时再定细化。但行区间基线规则需本期定（P2-4），heading 给「向上找最近标题行」简单实现即可（P3） |

---

## D. 自查盲区（起草人未列）

除 A 节三条外，另发现 15 项，其中 5 项 P1：

### P1（应修，带病进拆卡须在卡里体现）

**P1-3 · approval_request 写入责任未定，审计序列断言不可执行**（详细 §3 步骤 5–10 vs §1.3 对应表）
- 问题：proposeWithGate 步骤清单写 artifact_proposed（5）、approval_response（9）、artifact_resolved（10），**无 approval_request 步骤**；对应表归给「CliDecisionPort.ask 发起」——若由端口实现写，L1 单测（stub DecisionPort）里 7.1「审计序列依次出现 artifact_proposed / approval_request / …」断言依赖 stub 自己写审计 = 测的是 stub 不是编排；且 Web 写回场景无 ask → 无 request 条目（「请求-响应」配对在 Web 场景断链）。
- 为什么：正本 §5.2「每条裁决落入 append-only 日志」的裁决序列应可断言；S1⑤ 的实现依据就在这组断言。
- 修复：**approval_request 由 gate 编排统一写（ask 前 append）**，端口只返回 Decision；文档明示「approval_request 仅在 ask 路径产生，Web 面板直接写回无问询不产生 request 条目」；7.1 断言按 gate 编排 + stub 记录序列执行。

**P1-4 · 回滚报告「确认过 N 块」无数据源**（详细 §7.3 S3④ + §1.4 banner）
- 问题：报告文案「撤销 5 块、其中确认过 N 块」——「确认过 N 块」= 被撤销版本物化时的 acceptedBlocks 数，只在 artifact_resolved 审计条目或已删除的 pending 文件里；第一期只写不查，「撤销 N 块」可从版本间 diff 重算（v4 vs v2），**「确认过 N 块」无来源**。原型全收场景 N=5 与块数巧合相等掩盖了问题，混合场景（3 收 2 拒）暴露。
- 修复：三选一定案——a) 面板读自家 web-panel.jsonl 审计回放取 acceptedBlocks（第一期 Web server 读自己写的文件，无跨进程问题，推荐）；b) 版本 note 扩展携带 acceptedCount（改旧仓 note 格式，轻微漂移）；c) 改文案不报确认数（与正本 S3④ 文案不符）。落卡时写明数据管线。

**P1-5 · presentation 块 state 缺回滚态，「灰化未生效」无数据表达**（详细 §1.4 DiffBlockPresentation.state）
- 问题：原型实证的 S3④「回滚后正文切换，v4 提案块灰化标『未生效』」（复走二 PASS）在 presentation 数据里无法表达——state 枚举只有 pending/confirmed/rejected，无 rolledback/ineffective；通用渲染器按数据画，画不出灰化。
- 为什么：「presentation 纯数据 + 通用渲染器」是本期承重实证（D8），S3④ 是出口判据覆盖的交互；数据缺态 = 渲染器只能猜（违「零领域判断」）或该交互做不出来。
- 修复：state 枚举加 "rolledback"（回滚报告横幅 diff 块带「未生效」标注），渲染器支持；7.3 S3④ 断言按新枚举写。

**P1-6 · AC-1.2 断言对象漂移且技术不可执行**（详细 §7.2）
- 问题：断言「get_artifact_diff 返回块数与同版本 PendingChange 的 diffBlocks 数一致」——get_artifact_diff 参数是**版本号**（fromVersion/toVersion），提案未物化时没有目标版本号可传，**技术上无法对未物化提案 diff**；正本 AC-1.2 语义是「与 UI 块数一致」（UI 渲染提案块 v3→v4），工具 diff 的是版本间（v2→v3），对象不同。
- 修复：断言重写为有判别力形式——「get_artifact_diff(v2,v3) 的块按全收应用后重建 = v3 内容」（与 applyResolvedBlocks 同不变量），或「get_artifact_diff(v4,v5) 与 S3 回滚报告『查看差异』面板渲染块数一致」（双路径同 fixture）；7.2 覆盖标注同步修正。

**P1-7 · 拒绝采纳的 L1 覆盖语义未定义**（详细 §6 external/reject + §8 H3 联动）
- 问题：「重物化当前版内容覆盖」是旧仓没有的领域动作；若照抄 submitVersion 路径，`assertNotExternallyModified`（artifact-service.ts:130-144）会把覆盖动作自己挡死（EXTERNAL_MODIFIED）——拒绝采纳是用户明示要覆盖，不能走同一检测。覆盖的原子性、pending 存在时的组合语义均未定义。
- 修复：新增 L1 函数（覆盖式物化，明示绕过外部检测的用户指令路径）语义细化 + 单测「拒绝采纳后物化文件 = 当前版内容、版本链不变」；与 H3 第六类条目同卡。

### P2（建议，不进拆卡不阻塞）

- **P2-1（A2 联动）**：web-panel.jsonl 对正本 §5.2「fork 分支」字面的偏离登记为决策记录；跨文件审计合并显式推迟第三期；7.3 不承诺。
- **P2-2（B8）**：`GET /api/sessions` 无 S1–S5 消费场景——删，或明确场景（面板操作记录视图）并补断言。
- **P2-3**：CLI→Web 方向（CLI propose 落盘 → 面板显示待确认态）无直接 E2E 断言，靠「写路径单测 + 读路径 fixture」组合论证——设计明示该覆盖论证。
- **P2-4（H6 联动）**：blockAnchor 行区间基线未定义——del/mod 块锚 oldContent 有行号，add 块无 old 行；建议「块锚 = 块前最近 equal 行 + 块内偏移」或「del/mod 锚 old、add 锚前文」，sourceRef 落盘格式冻结前定死。
- **P2-5**：Web 面板交互模型未明确（逐块点击 = 前端本地状态、写回一次性提交 [对齐原型]；还是每点即调 resolveBlock [CLI 读 pending 见中间态]）——影响写回幂等与通道①中间态语义，明示。
- **P2-6**：spawnSubagent「本期实现 + 单测不接线」但 7.2 无 spawnSubagent 断言——补断言或改口径（与动作 6 统一）。
- **P2-7**：getContextUsage 无消费点（无阈值/触发/动作）——明确「实现 + 单测不接线、第三期消费」或删。
- **P2-8**：`POST /rollback/undo { version }` 参数语义未定（= 恢复目标版 v4 还是回滚版 v5）；建议 = 恢复目标版（撤销对 v2 的回滚 → 内容回到 fromVersion=v4），端点契约写清。
- **P2-9**：get_artifact_diff 缺省 fromVersion 在 currentVersion=1 时无「相邻上一版」——定义边界返回（空 blocks + note）。
- **P2-10**：7.3 一致性断言跨 L2 集成测试进程与 Web E2E 进程，共享同一临时 fixture 目录的机制未说明——分阶段执行脚本写明。
- **P2-11**：原型实证的剧本外功能「TOC 滚动链」第一期是否入面板未定——presentation DiffRef 注释已暗示顺序一致性，留卡（壳渲染自由裁量，零领域判断可承载）。

### P3（备忘）

- 正本 §10 第一期「不做什么」残留「Web」字样与 Web 轨矛盾（v3.1 修订残留），下次正本修订删。
- 回滚 author=user、版本 note 格式（`apply pending <id>` / `rollback to v<n>`）保持旧仓语义（list_my_artifacts 依赖）。
- EXTERNAL_MODIFIED「文件不存在放行」语义保持（外部删文件不警告、写回时重建）。
- 双 Web server 实例（多标签页/多进程）同写 web-panel.jsonl 违单 writer——第一期单进程假设。
- 连续回滚后撤销回滚的边界语义（v6 后再回滚 v3，此时「撤销」指什么）第三期再定。
- get_artifact_diff 行区间从 LCS ops 直接可推（equal/del 有 old 行号），无需新算法，实现说明写进卡。
- S5③「唯一真相 JSONL」措辞校准：版本链真相在领域存储、审计真相在会话 JSONL，两处职责不同，卡里写清。
- Web resolve 端点不经 DecisionPort 一句话明示（§6 注释层）。
- 真机 S5 冒烟依赖人手，双层验收时由 verifier 执行，卡里注明。

---

## Findings 汇总

| 级别 | 计数 | 编号 | 一句话 |
|---|---|---|---|
| **P0** | **0** | — | 无（硬约束 B 全部满足，无「不修不能进拆卡」级缺口） |
| **P1** | **7** | P1-1 | CliDecisionPort 阻塞确认的取消/超时/fork 语义未定义 + execute 内 ctx.ui 实证场景混用（permission-gate 是拦截器场景）；补 H7 假设 + Decision 取消分支 + D6 保底路径 |
| | | P1-2 | BASE_VERSION_CONFLICT 恢复路径死锁（无 discard、重新提案被查未决挡）+ 原型实证「有 pending 回滚禁用」守卫丢失；补守卫 + discard 端点 + 闭环断言 |
| | | P1-3 | approval_request 写入责任未定（§3 流程 vs §1.3 表不一致），7.1 审计序列断言不可执行；改由 gate 编排统一写 |
| | | P1-4 | 回滚报告「确认过 N 块」无数据源（只写不查矛盾）；定数据管线（建议面板读自家审计文件） |
| | | P1-5 | presentation 块 state 缺回滚态，「灰化未生效」无数据表达；state 加 rolledback 枚举 |
| | | P1-6 | AC-1.2 断言对象漂移且技术不可执行（工具无法对未物化提案 diff）；重写为有判别力断言 |
| | | P1-7 | 拒绝采纳的覆盖式物化语义未定义（照抄 submitVersion 会被 EXTERNAL_MODIFIED 挡死）+ H3 定案第六类条目 |
| **P2** | **11** | P2-1~P2-11 | 见 D 节：fork 裁量登记 / GET /api/sessions 回潮 / 跨进程覆盖论证 / blockAnchor 基线 / 面板交互模型 / spawnSubagent 断言 / getContextUsage 消费点 / undo 参数语义 / diff v1 边界 / E2E 共享目录 / TOC 范围 |
| **P3** | **9** | — | 见 D 节备忘（正本 §10 残留、旧仓语义保持、单 writer 假设、连续回滚边界等） |

## A/B/C/D 四节结论

- **A**：A1 成立（需补失败路径，P1-1）；A2 成立（需登记裁量，P2-1）；**A3 不成立**（死锁 + 守卫丢失，P1-2）。
- **B**：硬约束全部满足，无 P0；两处断言可执行性问题（P1-3/P1-6）与一处轻微回潮（P2-2）。
- **C**：H1/H2/H4/H5/H6 采纳；**H3 定案新增第六类 `artifact_external_resolved`**（条目族 v1 冻结）；H1 落卡路径常量单点。
- **D**：15 项盲区（5 项 P1），覆盖 schema 漏字段（approval_request 责任、回滚态枚举、blockAnchor 基线）、端点漏操作（discard）、断言不可执行（AC-1.2、审计序列、回滚报告数据源）、S 场景与设计脱节（S3④ 数据管线、守卫丢失）、原型实证交互与设计不一致（回滚守卫、灰化未生效、TOC）。

---

STATUS: PASS —— 可进阶段二拆卡（P0=0，P1 共 7 条均有落卡方案，见各条修复建议；H3 已定案）
