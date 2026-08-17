# T1-04 验收报告 · 审计条目族 v1 + presentation + DecisionPort/AuditPort + sourceRef（verifier 独立复核）

> 复核人：verifier（round-1，2026-08-17）
> 对象：git 未提交的 3 个 untracked 目录（`packages/core/src/audit/`、`src/gate/`、`src/presentation/`，共 5 生产文件 + 4 测试文件）
> 方法：干净态复跑门禁 + 自写临时驱动 19 条断言（全部自造内容，不采信实现者测试，跑完即删）+ 编译层窄化双向验证 + 纯函数 grep 审计

---

## 一、干净态门禁复跑

`rm -rf node_modules`（根 + packages/core）→ `npm install` → `npm run typecheck` → `npm test`，原文数字：

| 步骤 | 结果 |
|---|---|
| `npm install` | exit 0（esbuild postinstall 有 allow-scripts 警告，环境策略提示非错误） |
| `npm run typecheck` | 3 workspaces（core / pi / web）全过，零错误 |
| `npm test` | **Test Files 10 passed (10)，Tests 155 passed (155)**，Duration 585ms |

零回归对账：155 = 既有 **106**（pending-change 46 + artifact-service 42 + project-registry 15 + paths 1 + pi 1 + web 1）+ 本卡新增 **49**（ports 8 + source-refs 11 + entries 13 + builders 17）。与实现者声明「155/155（106 零回归 + 49 新增）」一致。驱动删除后复跑仍 155/155。

---

## 二、独立驱动断言（verifier 自写 19 条临时测试，`src/verify-t104.test.ts`，用后已删）

全部内容为 verifier 自造（B'：8 行 old → 6 行 new，2 del 块 + 尾部 add；A'/C'/D'/E' 另造），期望行区间手算。**19 passed (19)**：

| # | 断言 | 结果 |
|---|---|---|
| V1-B' | del[3,3]（heading 向上命中「§A 总则」）+ **del 整段[5,7]**（锚首行自身即被删节标题「§B 细则」）+ **尾部 add[9,9]**（old 末行 8 + 1；heading 从第 8 行向上「§C 附则」） | ✓ |
| V1-A' | mod[3,3] + mod[5,5]（mod 锚 = 连续 del 段 old 行区间）+ 尾部 add[8,8]（前文 last equal=7 → +1；heading「§2 模块」隔两行命中） | ✓ |
| V1-C' | **文首插入**（前面无 equal）→ lineStart=1、lineEnd=1；old 无标题 → heading 省略（键不出现） | ✓ |
| V1-D' | **中部 add**（前后都有 equal）→ [2,2] = 前文 last equal + 1（P2-4 定案规则独立复现） | ✓ |
| V1-E' | mod 多行区间（2 删 2 增连续）→ [2,3] | ✓ |
| V1-S | buildSourceRefs：2 收 1 拒 → 恰 2 条；lineStart=[5,9]；version/artifactId 透传 | ✓ |
| V2 | 六类构建函数 **Object.keys 精确集合**逐一比对（见第三节对照表），无缺字段/多字段/字段名漂移；`presentation` 未传时键不出现、传入时挂顶层壳；ts 注入确定、缺省 ISO 可解析 | ✓ |
| V3 | `switch(entry.kind)` 六分支消费：各分支取专属字段编译过（窄化失败即 tsc 报错）；`@ts-expect-error` 反向验证——proposed 分支取 `entry.action` 被 TS 拒绝（实测报 TS2339 于 `ArtifactProposedEntry`，证明窄化后类型正确；若 payload 退化 any 则 directive 变 unused 同样报错），双向保险 | ✓ |
| V4 | Decision 三分支可构造且经 stub DecisionPort 返回；**编译层完备性**：resolved 缺 decisions、cancelled 携带 decisions 均被 TS 拒绝（`@ts-expect-error` 吸收后 tsc 全绿） | ✓ |
| V5-a | **非拟合验证**：B' 内容（del-del-add 序、v7→v8、标题全不同）跑 builders → tag=`["➖ 删除 1/3","➖ 删除 2/3","➕ 新增 3/3"]`、badge「待确认 · 3 块」、anchor 按就近规则推导——序号/类型词/锚全部由内容推出，非对原型样例硬编码 | ✓ |
| V5-b | 文首插入 add 块：**显示锚 = 新内容自带标题「新篇首」**，与 sourceRef 硬锚（[1,1]、heading 省略）分离——双锚各自可复现 | ✓ |
| V5-c | resolved 面板：状态色按块 state 映射（rejected/confirmed/confirmed 三色序列）、confirmed 块 note「sourceRef 已记」、rejected 无 note；badge「已确认 · v8 已物化」（非原型 v4 硬编码） | ✓ |
| V5-d | rolledback 盖章：fromVersion=9 → 全块 state="rolledback"、note「未生效（v9 提案）」；回滚报告横幅含「v9 的 3 块改动不在当前版本」「确认过的 2 块一并撤销」（块数/确认数由参数注入） | ✓ |

原型佐证（直接查 `prototype/managed-doc-panel.html`）：原型 block-tag 实文即 `✏️ 修改 1/5` … `✏️ 修改 5/5`（165-226 行），`block-tag::after{content:" · 未生效（v4 提案）"}`（71 行）——实现的 tag 编号规则与 note 文案与原型逐字同构，` · ` 连接符留在渲染器侧（数据/呈现分离正确）。

---

## 三、与设计逐字段对照（详设 §1.2/§1.3/§1.4/§2 + 任务卡 H3/P1-2/P1-3/P1-5/P1-1① 修订）

| 设计要求 | 实现位置 | 一致 |
|---|---|---|
| §1.2 `SourceRef { artifactId, version, blockAnchor{lineStart,lineEnd,heading?} }` | `source-refs.ts:10-21`，逐字段一致 | ✓ |
| §1.2 写入路径：confirmed 块各一条、随 artifact_resolved 落盘、模型不产出 | `buildSourceRefs` 只取 confirmed；由 `buildArtifactResolved` 内嵌 | ✓ |
| §1.3 `AuditKind` 五类 + H3 第六类 `artifact_external_resolved`（action: merge\|reject） | `entries.ts:15-21`，六类 | ✓ |
| ArtifactProposed：changeId/artifactId/baseVersion/diffBlockCount/sourceActor/diffSummary | 键集合精确比对通过 | ✓ |
| ArtifactResolved：changeId/artifactId/newVersion/acceptedBlocks/rejectedBlocks/sourceRefs | 通过；accepted/rejected 与块 state 对账、sourceRefs 与 confirmed 对齐 | ✓ |
| ArtifactRollback：artifactId/fromVersion/toVersion/newVersion(=from+1)/undoing/note 两态文案 | `newVersion=fromVersion+1`、`rollback to v{n}`/`undo rollback to v{n}` 实测 | ✓ |
| ApprovalRequest：status 恒 "pending"/mode/requester；P1-3 写入责任归 gate 的注释 | 键集合通过；`entries.ts:58-62` 注释写明「仅在 ask 路径由 gate 写入；Web 面板直接写回不产生 request 条目」 | ✓ |
| ApprovalResponse：status/decisions/via + **P1-2 扩展 "discarded"**（decisions=[]、note 说明原因） | 两构建函数分立；discarded 时 decisions=[]、note 必填 | ✓ |
| 顶层壳 ns:"next-step"/kind/ts/presentation? | 分配式（见第四节①） | ✓ |
| §1.4 Presentation/PresentationBadge/PresentationBlock(diff/rows/banner/text)/DiffRef/Row 逐字段 | `presentation/types.ts` 与详设逐字段一致 | ✓ |
| DiffBlockPresentation：blockId/kind/tag/anchor/lines/oldLines?/state/note? + **P1-5 加 "rolledback"** | 一致；state 四枚举 | ✓ |
| §2.1 DecisionRequest 六字段（kind/changeId/artifactId/title/blocks/mode） | `ports.ts:12-20` 一字不差 | ✓ |
| §2.1 Decision + **P1-1① cancelled 分支**（pending 保留语义注释） | 三分支；cancelled 注释含「pending 保留、工具返回 changeId 文案、出口是 discard」 | ✓ |
| §2.3 AuditPort.append(entry): Promise\<void\> | `ports.ts:44-46` | ✓ |

任务卡验收断言 5 条全部独立复现：六类可构建+两态（V2）、buildSourceRefs 三不变量（V1-S/V1-B'~E'）、presentation 与原型结构一致且非拟合（V5-a~d + 原型文件佐证）、cancelled 可构造+grep ctx.ui 零命中（V4 + 第五节）、无 @earendil-works 依赖（第五节）。

---

## 四、三个自报处理点裁决

**① AuditEntryPayload 交叉类型改「壳字段分配进成员」（entries.ts:117-127）——成立。**
详设原文为 `{壳} & (A|B|…)` 交叉联合，TS 对该形态的判别窄化不可靠；实现改为六个 `Shell & Member` 具名类型再取联合，kind 成为判别字段。V3 双向验证：switch 各分支取专属字段 tsc 全过；proposed 分支误取 `entry.action` 实测报 `TS2339: Property 'action' does not exist on type 'ArtifactProposedEntry'`（窄化目标类型正确）。等价改写，消费方（T1-05 gate、T1-07 pi 落盘）可直接判别。

**② add 块双锚——成立，职责注释清楚且各自可复现。**
- **硬锚**（sourceRef.blockAnchor）：`computeBlockAnchors` 只看 oldContent——del/mod 锚连续 del 段 old 行区间；add 锚「块前最近 equal 行 +1、lineEnd 同」（P2-4），文首插入 lineStart=1。纯 LCS 重放，确定性可复现；与 diffBlocks 失配抛 INVALID 不静默错配（`source-refs.ts:107-122`）。块注释（59-72 行）写明全部规则。
- **显示锚**（presentation.anchor）：`resolveBlockAnchor` 对 add 块优先取**新内容自带的首个节标题**（新增节的标题行本就是 add 块内容），找不到回退 old 侧就近标题（`builders.ts:35-48` 注释写明，并解释了原型「§2.3 Web 壳选型」即此形态）。
- 两者分离是必要的：sourceRef 是 M2a 追溯硬数据（锚 old 行号才有第三期归因意义），presentation 是人读显示。V5-b 用文首插入用例实证了分离（硬锚 [1,1] 无 heading；显示锚「新篇首」）。

**③ approval_request presentation 委托提案面板（builders.ts:139-144）——成立。**
依赖图无环：`builders → audit/source-refs → domain`（单向）；`entries → presentation/types` 与 `ports → entries/presentation/types` 均为纯类型导入，不构成循环。时序假设正确：P1-3 定案 ask 前写入 request 条目，此刻面板数据与提案落盘时相同（问询不改变领域状态），委托即同构；函数注释已写明，且有实现者测试断言两者 toEqual（我以 V5-a 独立验证了底层 buildProposalPresentation 的通用性）。

---

## 五、红线审计

| 红线 | 方法 | 结果 |
|---|---|---|
| 既有 106 条零回归 | `git status --porcelain` 恰 3 个 untracked 目录、**零 M 文件**——既有测试文件未被触碰；门禁 155 全绿且 106/49 对账吻合 | ✓ |
| L1 纯函数（零 fs/process/console/网络） | grep 五个生产文件：零命中（测试文件 `ports.test.ts` 用 node:fs 读源码做红线自检断言，属测试正当用途；`source-refs.test.ts` 的 grep 命中系 `sourceRefs.every` 子串误报，已逐条人工核过） | ✓ |
| 端口文件 grep `ctx.ui` 零命中 | 实测零命中；实现者还把该 grep 写成了常驻测试（ports.test.ts:85-90） | ✓ |
| B1：core 无 `@earendil-works/*` 依赖 | package.json 实查（devDeps 仅 typescript/vitest/@types/node）+ node_modules 无该 scope；实现者同样有常驻断言 | ✓ |
| 未抢跑 T1-05（gate 编排） | 无 pending-gate-service/proposeWithGate/rollbackWithAudit；approval_request 的写入仅有构建函数与「gate 编排写入」注释 | ✓ |
| 未抢跑外部手改服务（T1-06+） | 无 checkExternalModification/覆盖式物化；仅 presentation 构建函数（任务卡明列范围） | ✓ |
| 零 pi import | grep `@earendil`/`from "pi"` 于三目录：零命中 | ✓ |

---

## 六、问题分级

| 级别 | 问题 | 说明 |
|---|---|---|
| P3-1 | add 块的 sourceRef.heading 取 **old 侧**就近标题：新增自带节标题的块（如尾部新增 §4 附录节）heading 会指向上一节（§3），而显示锚指向新节 | H6 明示 heading 尽力而为、lineStart/lineEnd 行区间才是硬锚（LCS 可复现），本卡只需「写了、可稳定定位」——属裁量范围。记录供第三期 trace_defect 消费时知晓：add 块 heading 语义 =「插入点所处节」 |
| P3-2 | `buildRollbackReportPresentation` undoing 分支的 diffRef 版本区间为 fromVersion→toVersion（恢复目标），非 undoing 分支为 fromVersion→newVersion（撤销对照），两分支区间方向不同且注释未点明 | 纯呈现数据，消费方（两壳渲染器）未落地，不影响本卡断言；建议 T1-05+/渲染卡消费时留意区间语义 |

**P0/P1/P2：无。**

---

## 七、结论

干净态门禁全绿（install exit 0 / 3 workspaces tsc 零错误 / **155/155**，零回归 106 + 新增 49 对账吻合）；verifier 自写 19 条驱动断言全过——blockAnchor 五组手算行区间（含整段删除、文首插入、中部/尾部 add）逐一命中，六类条目键集合与详设+H3/P1-2 逐字段零漂移，kind 窄化与 Decision 分支在编译层双向验证，builders 用自造内容（不同块序/版本号/标题）证明 tag/序号/锚/状态色为通用规则非原型拟合（原型文件直接佐证）；三个自报处理点（分配式壳、add 双锚、request 委托）全部裁决成立；红线七项全过，未抢跑 T1-05/06+。

STATUS: PASS —— 干净态 155/155（106 零回归对账吻合），独立驱动 19/19，逐字段零漂移，blockAnchor 手算复算命中，presentation 非拟合验证成立，三自报点裁决成立，红线无违反
