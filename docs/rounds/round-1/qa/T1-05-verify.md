# T1-05 验收报告 · pending-gate-service：提案→确认→物化编排 + 守卫 + discard（verifier 独立复核）

> 复核人：verifier（round-1，2026-08-17）
> 对象：git 未提交的 2 个 untracked 文件（`packages/core/src/gate/pending-gate-service.ts` + 同名 `.test.ts`）
> 方法：干净态复跑门禁 + verifier 自写 7 组临时驱动（fixture/断言全部自造，不采信实现者测试，跑完即删）+ 红线 grep + 三自报点裁决

---

## 一、干净态门禁复跑

`rm -rf node_modules`（根 + core + pi-ext + web 全清）→ `npm install` → `npm run typecheck` → `npm test`，原文数字：

| 步骤 | 结果 |
|---|---|
| `npm install` | exit 0，found 0 vulnerabilities（esbuild postinstall 有 allow-scripts 警告，环境策略提示非错误） |
| `npm run typecheck` | 3 workspaces（core / pi / web）全过，零错误，EXIT=0 |
| `npm test` | **Test Files 11 passed (11)，Tests 167 passed (167)**，Duration 637ms |

零回归对账：167 = T1-04 验收基线 **155**（106 既有 + 49 前卡新增，见 T1-04-verify.md 对账）+ 本卡新增 **12**（pending-gate-service.test.ts）。与实现者声明「167/167（155 零回归 + 12）」一致。驱动删除后复跑仍 **167/167**。

---

## 二、独立驱动断言（verifier 自写 7 组，`src/gate/t105-verifier.tmp.test.ts`，用后已删）

fixture 全部自造（3 块场景「验证笔记」、5 块场景「移植手册」，行内容与实现者测试完全不同）；**stub DecisionPort 为纯对象字面量闭包，只捕获 decide 函数，结构上无 auditLog / auditPort 任何可达路径**——审计断言对象只能是 verifier 自己注入 gate 的收集器（P1-3 断言纪律）。物化内容全部**直读磁盘文件**（registry root 拼 artifact.filePath，不经 artifactService 读版本快照的路径）。**7 passed (7)**：

| # | 断言 | 结果 |
|---|---|---|
| A 全链时序 | 3 块全收 → 四条目恰按 `artifact_proposed → approval_request → approval_response → artifact_resolved` 落入；**ask 被调用的瞬间对 auditLog 做快照 = `[artifact_proposed, approval_request]`**——request 先于 ask 写入是时序铁证（非事后数组序推断）；磁盘物化文件逐行 = 提案全文；pending 删（listPendingChanges = []）；版本链 [1,2,3,4]；条目字段 requester:"cli"/via:"cli-keyboard"/newVersion:4 | ✓ |
| B 混合档 | 5 块 2 收 3 拒 → 磁盘内容 **11 行逐行 = 手写字面量**（行 3、5 取新 C1/C2，行 7、9、11 留旧 B3/B4/B5——期望独立手算，非 applyResolvedBlocks 回算，无循环论证）；accepted/rejected **逐 blockId 对**（按问询顺序切片）；sourceRefs 恰 2 条、blockAnchor 区间 `["3-3","5-5"]` 正是被收块行号、version 全 =4 | ✓ |
| C 取消（P1-1①） | cancelled → pending 在（1 条）、审计恰两条 [proposed, request]、返回文案含「已提案未确认」与 changeId、磁盘内容不动 | ✓ |
| D 守卫双向（P1-2①） | 有 pending 时 `rollbackWithAudit` 与 `rollbackUndoWithAudit` **各自**抛 `GateError("PENDING_EXISTS")`、文案逐字 =「有待确认提案未处理，暂不可回滚」；**审计零新增**（两次拒绝后 kinds 仍 = leavePending 遗留的两条，连一条都不多）；版本链与磁盘逐字节不动 | ✓ |
| E discard 闭环（P1-2③） | 提案 baseVersion=3 → 上游回滚 v2（当前变 v4）→ resolveAndMaterialize 抛 `BASE_VERSION_CONFLICT` 且 **pending 保留** → `discardWithAudit` → pending 空 + `approval_response{status:"discarded", decisions:[], note, via}` → **重新 proposeWithGate 全链成功**（新基底 v4 → 物化 v5，磁盘直读验证）；全程 7 条审计序列逐条与手推吻合（含 discard 走 approval_response 类） | ✓ |
| F 协议违约 | resolved 但 decisions 只给 2/5 块 → 抛 `PendingChangeError("INVALID")`；**无半截状态**：pending 不删（仍 1 条）、审计停在 [proposed, request]、currentVersion 仍 3、磁盘仍 v3 全文 | ✓ |
| G 撤销回滚（P2-8） | rollback(v2) → `{fromVersion:4, toVersion:2, newVersion:5}`、磁盘 = v2 内容；undo(4) → `{fromVersion:5, toVersion:4, newVersion:6}`、**磁盘 = v4 内容**、v6 快照 = v4 快照、版本链完整 [1..6]；两条 artifact_rollback 逐字段对（undoing false/true、note "rollback to v2" / "undo rollback to v4"） | ✓ |

**stub 纯洁性（P1-3 结构检查）**：双证据——① verifier 的 stub 闭包无审计可达路径（如上）；② gate 源码 `pending-gate-service.ts:191` 的 `approval_request` append 位于 `:212` 的 `decisionPort.ask(req)` 之前，写入者只能是 gate 编排。与 A 的时序快照互为印证。

**十步流程映射复核**：详设 §3 步骤 7-8 写「逐块 resolveBlock → 最后 resolveAndMaterialize」，实现为循环逐块调 `resolveAndMaterialize`——读域服务源码（`pending-change-service.ts:376-405`）确认该方法 = resolveBlock + 全决检查（未全决直接返回 materialized:false，不物化）+ baseVersion 校验 + 物化 + 删 pending，**逐块调用与详设两步语义严格等价**，且与 Web 面板 resolve 端点（详设 §6）同一入口，非漂移。

---

## 三、红线与未抢跑

| 项 | 证据 | 结果 |
|---|---|---|
| 155 零回归 | `git status --porcelain` 恰 2 个 untracked（本卡实现 + 测试）、**零 M 文件**；门禁 167 全绿且 155/12 对账吻合 | ✓ |
| gate 零 ctx.ui | grep `ctx\.ui` 于 `src/gate/` 仅命中测试文件里的断言字符串本身，两个源文件零命中 | ✓ |
| gate 零 pi import | grep `@earendil-works` 同上零命中（源文件）；core 无 pi 依赖（T1-04 已有 package.json 断言保持） | ✓ |
| 未抢跑 CLI 端口 | `CliDecisionPort` 仅出现在 T1-04 已提交的 ports.ts **注释**（「由 L2 的 T1-09 提供」），无实现文件 | ✓ |
| 未抢跑外部手改 | `checkExternalModification` / `diffBetweenVersions` 全 core 零命中；`buildArtifactExternalResolved` 构建器**零消费** | ✓ |
| 未抢跑端点 | gate 目录仅 4 文件（本卡 2 + T1-04 ports 2）；apps/web 未动（untracked 仅 2 个 core 文件） | ✓ |

---

## 四、三个自报决策点裁决

### ① rollbackWithAudit 的 via 收下但条目不落 —— **成立**

任务卡与详设 §3 的签名本就写 `{ version, via }`——收下 = 对齐两份上游文档；而 `artifact_rollback` 条目 schema 是 T1-04 **v1 冻结**（无 via 字段），落条目必须跨卡改冻结文件，违反「后续加字段走扩展流程」。S1⑤「按来源可检视」针对的是**裁决**（approval_response.via 已落），回滚不是裁决。不改冻结 schema 的前提下无更优解。备注：via 在 rollbackInternal 中当前实际未消费，属签名占位（JSDoc 已注明缘由）——P3 级，若 T1-10+ 确认回滚永远无需 via 可再收紧。

### ② resolved 但 decisions 未覆盖全块 → 抛 INVALID —— **成立，优于备选**

- 静默返回 unconfirmed/deferred：把**端口协议违约**伪装成正常用户行为，L2 工具层无法区分「用户没答完」与「端口坏了」，违反「不猜不静默」；
- 部分物化：违反 applyResolvedBlocks 不变量（物化要求全块落定），产出语义未定义的版本；
- **抛 INVALID（实现选择）**：fail fast；pending 保留现场——部分块 state 更新是**可恢复的正常中间态**（Web 面板路径本就逐块 resolveAndMaterialize），并非污染；版本链与审计不动是关键不变量，F 驱动已实证。code 复用本域 PendingChangeError（INVALID→422 语义吻合），不引入新错误类型。
- 附带验证：重复 blockId 场景（如 5 块 decisions 全给 b1）同样落入 INVALID 网（其余块仍 pending → last.materialized=false）。

### ③ artifact_rollback 条目不挂 presentation —— **成立**

P1-4 评审定案**方案 a（推荐项）**=「面板读自家审计回放取 acceptedBlocks」——「确认过 N 块」的数据源是 artifact_resolved.acceptedBlocks，不该由 rollback 条目携带；且 gate 的 AuditPort 接口（T1-04 ports.ts）**只有 append 无读取**，回放读取属 T1-10+ 渲染侧。挂 presentation 反而制造第二数据源。与定案一致。

---

## 五、分级

- **P0/P1/P2：无。**
- P3（提示，不阻塞，供后续卡留意）：
  1. rollback 的 via 参数为未消费的签名占位（自报①备注）——后续若确认无用可收紧签名；
  2. decisions 含重复 blockId 且恰好覆盖全块时，物化正确但 approval_response.decisions 会重复记账——自家 DecisionPort（T1-09）可在协议层保证唯一性，gate 不做去重符合「不猜」；
  3. discard 传播的 NOT_FOUND（changeId 不存在不写假审计，JSDoc 声明）未单独配断言——Web 面板卡接 discard 端点时补一条即可。

---

## 六、结论

干净态门禁全绿（install exit 0 / 3 workspaces tsc 零错误 / **167/167 = 155 零回归 + 12 新增**，git 零 M）；verifier 自写 7 组驱动全过——**request 先于 ask 的时序铁证**（ask 瞬间审计快照）、混合档磁盘内容逐行手算命中 + sourceRefs 锚区间逐块对、取消/守卫双向（零审计写入）/discard 闭环全链复跑/协议违约无半截状态/撤销回滚 v6=v4 与 [1..6] 完整链，全部实证；stub 纯洁性双证据（闭包不可达 + 源码顺序）；红线六项全过、未抢跑 T1-07/09/10/11+；三个自报决策点（via 签名占位 / INVALID 抛出 / rollback 条目不挂 presentation）逐一裁决成立，无更优解遗漏。

STATUS: PASS —— 干净态 167/167（155 零回归 + 12 对账吻合，git 零 M），独立驱动 7/7（含 request 先于 ask 时序铁证、混合档逐行手算、守卫零审计、discard 闭环复跑、违约无半截状态、undo v6=v4），stub 纯洁性双证据，红线六项全过未抢跑，三自报点裁决成立
