# T1-03 验收报告 · PendingChange.baseVersion 与冲突校验（verifier 独立复核）

> 复核人：verifier（round-1，2026-08-17）
> 对象：git 未提交的 3 个修改文件（`artifact-service.ts` / `pending-change-service.ts` / `pending-change-service.test.ts`）
> 方法：干净态复跑门禁 + 自写临时驱动脚本（不采信实现者测试，跑完即删）+ diff/红线审计

---

## 一、干净态门禁复跑

`rm -rf node_modules`（根 + packages/core）→ `npm install` → `npm run typecheck` → `npm test`，全部原文数字：

| 步骤 | 结果 |
|---|---|
| `npm install` | exit 0，`found 0 vulnerabilities`（esbuild postinstall 有 allow-scripts 警告，属环境策略提示非错误） |
| `npm run typecheck` | 3 workspaces（core / pi / web）全过，零错误输出 |
| `npm test` | **Test Files 6 passed (6)，Tests 106 passed (106)**，Duration 498ms |

用例分布：pending-change-service.test.ts **46 条**（原 42 + 新 4），artifact-service.test.ts 42，project-registry 15，paths 1，pi 1，web 1。域断言合计 88（84 既有 + 4 新增）。

---

## 二、独立驱动断言（verifier 自写 7 条临时测试）

在 `packages/core/src/domain/t1-03-verify.tmp.test.ts` 自写驱动（用后已删，工作区回到恰 3 文件改动），**7 passed (7)**：

| # | 断言 | 结果 |
|---|---|---|
| V1 | 基底匹配：v3 基底 → confirm → 物化 v4、`artifact.json` currentVersion=4、pending 删除（get 抛 NOT_FOUND） | ✓ |
| V2 | 基底失配（提案 v3 → rollback v2 追加 v4 → confirm）：抛 `BASE_VERSION_CONFLICT`、pending 文件仍在、版本链 4 份（readdir 实数）、**物化 .md 内容 = 回滚后内容 `"line-2"`（无半截状态）**、乐观锁计数 version 4→4 未消耗 | ✓ |
| V3 | 旧 pending 无 baseVersion（手写落盘 fixture：save 后读出 JSON、删字段、写回）：抛 `BASE_VERSION_CONFLICT` 且文案含「请重新提案」、pending 仍在 | ✓ |
| V4a | 两道防线互不吞错：baseVersion 匹配但物化 .md 被外部手改 → 抛 `EXTERNAL_MODIFIED`（**非** BASE_VERSION_CONFLICT），pending 仍在 | ✓ |
| V4b | baseVersion 大于真实（提案基底 v5，实际 v4）→ 抛 `BASE_VERSION_CONFLICT`，文案含 `v5`，pending 仍在 | ✓ |
| V5 | 校验时序：确认失败时 `artifact.json` 乐观锁计数未被消耗（4→4），pending 文件在盘上存在 | ✓ |
| V6 | 负面对照：冲突错误是 `ArtifactError` 而非 `PendingChangeError`（未偷用旧错误类型） | ✓ |

补充源码级确认（`pending-change-service.ts:386-398`）：baseVersion 校验位于 `getArtifact` 之后、`applyResolvedBlocks` 与 `submitVersion` 之前，与详设 §1.1「校验先于 applyResolvedBlocks」一致；`remove` 在 `submitVersion` 成功返回后才可达，冲突路径必然保留 pending。

---

## 三、与设计（详设 §1.1）对照

| 设计要求 | 实现 | 一致 |
|---|---|---|
| `PendingChange` 加 `baseVersion: number` 字段（JSDoc 同文案） | `pending-change-service.ts:50-51` | ✓ |
| `buildReplacePendingChange` / `buildPatchPendingChange` 入参加 `baseVersion`（必填） | 两处 args 类型 + 返回对象均接线 | ✓ |
| `ArtifactError` code 联合加 `"BASE_VERSION_CONFLICT"`，文案「上游版本已变更（当前 vX ≠ 提案基底 vY），请重新提案」 | `artifact-service.ts:56-66` + `pending-change-service.ts:391-396`，文案逐字一致 | ✓ |
| 校验在 `submitVersion` 之前；不符抛错、pending 不删 | 见二、补充源码确认 | ✓ |
| 兼容：旧 pending 无字段 → 校验直接失败提示重新提案，不留歧义 | `undefined !== 任何版号` 落入同分支，`base` 显示为「缺失」 | ✓ |

任务卡验收断言 5 条全部独立复现（前 4 条 = V1/V2/V3/V6+code 字段断言；第 5 条平移回归 = 门禁 106 全绿）。

---

## 四、测试文件 diff 审计（防断言偷改）

`git show HEAD:…test.ts` 与工作区逐行对比，**旧文件被删改的行共 24 行，全部是 `buildReplacePendingChange` / `buildPatchPendingChange` 调用行本身**（改动仅为追加 `baseVersion: 1`，另 2 处以独立新行插入）；**零条断言（expect/throw/toEqual 类）出现在删改行中**——既有 42 条用例的断言全部原样保留。抽查对照（art-9 原子写、art-1/art-B 隔离、applyResolvedBlocks 全 confirmed/rejected、resolveBlock 幂等、ghost NOT_FOUND）：每处仅构造行差一个字段，断言与上下文无任何变化。

适配处数实测：全文件 32 处 `baseVersion: <数字>`，其中新 describe 4 用例占 6 处，**既有适配 26 处**（实现者声明 27——差 1 属计数口径误差；typecheck 将 `baseVersion` 设为必填，漏一处即编译不过，故无遗漏可能）。

新 describe 4 条用例逐条审阅：断言对象、期望值与任务卡/详设对应正确，无自证循环（seedAtVersion 经真实 `submitVersion` 推版本链，非 mock）。

---

## 五、红线审计

| 红线 | 命令/方法 | 结果 |
|---|---|---|
| 格式脏残留（实现者自述曾有脚本事故） | grep 行尾空白 / `;;` / awk ≥3 连续空行，三文件 | 零命中 ✓ |
| 未抢跑 T1-04（审计条目） | grep `appendEntry\|audit` 于两源文件 | 零命中（仅 JSDoc 提及设计出处）✓ |
| 未抢跑 T1-05（discard/守卫） | grep `discard` | 仅 `pending-change-service.ts:367` JSDoc「保留现场供 discard…（T1-05）」方向性注释，无函数实现 ✓ |
| 改动恰 3 文件 | `git status --porcelain` | 恰 3 个 M，无 untracked、无删除 ✓ |
| 校验先于写盘 | 源码阅读 | 校验在 `applyResolvedBlocks`/`submitVersion` 之前；写盘仍仅发生在 submitVersion ✓ |

---

## 六、问题分级

| 级别 | 问题 | 说明 |
|---|---|---|
| P3-1 | 适配处数声明 27 与实测 26 差 1 | 计数口径误差（32 全文件 - 6 新用例 = 26 既有）。必填字段 + tsc 全绿保证无遗漏，实质无影响 |
| INFO-1 | 冲突失败时 pending 的块状态已被翻成 confirmed 并落盘（resolveBlock 先于校验执行） | 符合详设「保留现场供 discard / 重新提案比对」意图——现场即含块的决议记录；恢复路径是**重新提案**而非原条重试（currentVersion 只增，原条永远失配），与 T1-05 discard 编排衔接。设计选择，非缺陷 |

**P0/P1/P2：无。**

---

## 七、结论

干净态门禁全绿（install exit 0 / 3 workspaces tsc 零错误 / **106/106 tests passed**）；verifier 自写 7 条驱动断言全过（含失配无半截状态、两道防线互不吞错、乐观锁计数不消耗、旧数据兼容）；测试 diff 审计零断言偷改；红线五项全过，未抢跑 T1-04/05。仅 P3 计数口径与 INFO 设计观察各一项。

STATUS: PASS —— 干净态门禁 106/106 全绿，独立驱动 7/7 通过，零断言偷改，红线无违反
