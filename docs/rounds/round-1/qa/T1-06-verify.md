# T1-06 验收报告 · external-modification-service：check / reject 覆盖式物化 / merge 转提案（verifier 独立复核）

> 复核人：verifier（round-1，2026-08-17）
> 对象：git 未提交改动——1 个 M（`packages/core/src/domain/artifact-service.ts`，卡内明示的抽取 + 两方法）+ 2 个 untracked（`external-modification-service.ts` + 同名 `.test.ts`）
> 方法：干净态复跑门禁 + verifier 自写 9 条临时驱动（fixture/断言全部自造，不采信实现者测试，跑完即删）+ git 范围审计 + 红线 grep + **merge 缝隙解法专项裁决**（复现缝隙 → 三分支逐条 → 取消路径语义后果）

---

## 一、干净态门禁复跑

`rm -rf node_modules`（根 + core）→ `npm install` → `npm run typecheck` → `npm test`，原文数字：

| 步骤 | 结果 |
|---|---|
| `npm install` | exit 0，found 0 vulnerabilities（esbuild postinstall 的 allow-scripts 警告为环境策略提示，非错误） |
| `npm run typecheck` | 3 workspaces（core / pi / web）`tsc --noEmit` 全过，零错误 |
| `npm test` | **Test Files 12 passed (12)，Tests 177 passed (177)**，Duration 674ms |

零回归对账：177 = T1-05 验收基线 **167**（见 T1-05-verify.md 对账链）+ 本卡新增 **10**（external-modification-service.test.ts）。与实现者声明「177/177（167 零回归 + 10）」一致。驱动删除后复跑仍 **177/177**。

---

## 二、改动范围审计（git）

| 项 | 证据 | 结论 |
|---|---|---|
| artifact-service.ts 的 M diff | diff 恰四点：① `assertNotExternallyModified` 内部比对替换为调 `detectExternalModification`（抛错语义原样）；② 新公开方法 `materializedAbsPath`；③ 新公开方法 `rematerializeCurrentVersion`；④ 文件尾新导出纯函数 `detectExternalModification` + 常量 `EXTERNAL_EXCERPT_MAX_CHARS` | 与卡内明示的「抽取导出 + 两方法」完全一致，无夹带 |
| T1-02 平移测试 | `git status --porcelain` 无 `artifact-service.test.ts`——零改动 | ✓ |
| gate / audit / ports | 同上，`packages/core/src/{gate,audit}` 无任何 M/untracked | 零触碰 ✓ |
| L1 纯度（§2.1 红线） | 新两文件 grep 无 pi/UI import（`@pgoone/next-step-pi`、`apps/` 零命中） | ✓ |
| 无端点/UI 抢跑 | `apps/`、`packages/pi/src/` grep `external` 零命中（无 `external/merge`、`external/reject` 接线——那是 T1-08+ 的活） | ✓ |

---

## 三、独立驱动断言（verifier 自写 9 条，`src/zz-t106-verify.driver.test.ts`，用后已删）

fixture 自造（「验收文档」两版内容、外部内容含独占标记行 `外部独有标记XYZ`）；stub DecisionPort 为可换策略对象；审计断言对象为 verifier 自己注入的收集器；版本链/物化文件直读磁盘（`NEXTSTEP_DIR_NAME` 常量拼路径，见 §六 P3-1 的坑）。**9 passed (9)**：

| # | 断言 | 结果 |
|---|---|---|
| A reject 全链 | 外部改后：**对照**同状态 `submitVersion` 与 `rollback` 各自抛 `EXTERNAL_MODIFIED`（检测活着）→ reject 成功（非被挡）；磁盘**逐行** = 当前版 V2；版本链 `[1,2]` 不变、`currentVersion=2`、乐观锁 `version=2` 不动；真实 versions 目录 `readdir` 恰 `{1.json, 2.json}`、无 `3.json`（H4：无幽灵版本）；`2.json` 快照解析 `content===V2` 未被改写；全日志**恰一条** `artifact_external_resolved{action:"reject"}`；恢复后 `check` modified:false、`submitVersion` 出 v3 畅通（对照收口：非检测失效） | ✓ |
| B① 缝隙独立复现 | **不恢复基底**（用 domain 原语直接 `proposeWithGate` 载外部内容、全收策略）→ `resolveAndMaterialize → submitVersion` 的写盘前断言抛 `EXTERNAL_MODIFIED`；干净失败：版本链未动、磁盘仍外部内容、pending 保留现场、零 external_resolved 审计 | ✓ |
| B② 实现路径全收 | `mergeExternalAsProposal` 全收 → `materialized, newVersion=3`；磁盘 = 外部内容、`readCurrentContent` = 外部内容；`artifact_proposed{baseVersion:2, sourceActor:"external-merge"}`；审计五条恰按 `[proposed, request, response, resolved, external_resolved{merge}]`，merge 殿后；pending 清空、检测 clean | ✓ |
| B③ 取消路径 | stub=cancelled → `unconfirmed`；**磁盘 = 系统版 V2**（外部内容已离开磁盘）；pending 完整保留：`diff.newContent` = 外部内容**全文**（含标记行）、`oldContent=V2`、`baseVersion=2`；版本链不动；`external_resolved{merge}` 已写。随后 `discardWithAudit` → pending 空、磁盘/版本链/pending 三处均无外部内容；append-only 审计仍含外部内容标记（artifact_proposed 的 presentation diffRef 块 `lines` 携带改动行）+ `approval_response{status:"discarded"}` 入账 | ✓ |
| B④ pending_exists 前置 | 已有未决提案 + 外部手改 → 合并返回 `pending_exists`（带 `existingChangeId`）；**磁盘仍 = 外部内容原样**（恢复动作未执行——若误恢复，外部内容将不可逆丢失）；零 merge 审计、无新 pending | ✓ |
| B⑤ no_change 透传 | 外部内容与当前版逐字相同 → `no_change`；零 pending、零审计条目（auditLog 空） | ✓ |
| C 三分支 + 截断 | 改动 → `{modified:true, onDiskExcerpt:全文}`；未改 → `{modified:false}` 无 excerpt；文件被删 → `modified:false`（旧仓 :136 放行语义）；截断边界：200 字符不截、201 字符 → 200+`…` | ✓ |
| C 差分对照（共用实现行为证明） | 六种磁盘状态（逐字相同 / 尾部追加一字节 / LF→CRLF / 单字符差异 / BOM 前缀 / 文件被删）逐一验证 `check.modified` 与「submitVersion 是否被 EXTERNAL_MODIFIED 挡」**全部一致**——两条路径（面板检测 vs 写盘断言）同谓词的实证 | ✓ |
| 共用实现源码核对 | `detectExternalModification` 全仓唯一实现（artifact-service.ts:478）；`assertNotExternallyModified`（:144）与 `checkExternalModification`（external-modification-service.ts:39）均调它，无第二实现 | ✓ |

---

## 四、merge 缝隙解法专项裁决（本卡复核重点）

**缝隙是否真实**：真实。B① 用 domain 原语独立复现——外部内容留在磁盘直接进提案通道，全决物化时 submitVersion 以「磁盘 vs 上一当前版」比对必然抛 EXTERNAL_MODIFIED，合并自锁。这不是实现者为改代码编的理由。

**解法是否成立**：成立，且是对 D10 红线最干净的一种。`mergeExternalAsProposal` 在进提案通道**前**以 `rematerializeCurrentVersion`（用户指令路径：点「合并」即明示）把磁盘恢复系统版，外部内容自此以提案 `newContent` 为唯一载体（diff 里有完整新旧全文）；此后整条 propose→确认→物化走干净基底，**不绕过任何检测**（B② 全链通过即为证）。D10 的 EXTERNAL_MODIFIED 兜底对 AI 静默覆盖依然全时有效（A 对照组 + C 差分对照六态一致）。

**三分支语义自洽**（B②/④/⑤）：
- `no_change`：外部内容==当前版 → 透传零副作用（此时恢复磁盘也无意义，透传更省）；
- `pending_exists`：外部内容**只存在于磁盘**时恢复动作不可逆 → 必须前置拦截且不动磁盘（B④ 实证磁盘原样），引导先处理未决；
- 恢复+进提案：唯一动磁盘的分支，动完外部内容已有 pending 载体，不丢。

**取消/挂起路径的语义后果（B③，裁决）**：merge 后 cancelled/deferred → 磁盘保持系统版（面板无外部污染）、pending 完整保留外部内容全文——处理出口畅通（继续逐块确认，或 discard）。**discard 后外部内容离开一切活数据（磁盘/pending/版本链），仅 append-only 审计可查**（artifact_proposed 的 presentation 块行 + 基底版本链可重建）。裁决：**产品语义可接受**——外部手改本属绕过系统的违规操作，转提案已是宽大处理，discard 是用户在知情通道上的主动放弃；且审计可查非绝对丢失，D10「防 AI 静默丢失」的本意（AI 不得瞒着用户覆盖）未被破坏，丢与不丢的决定权全程在用户。

**T1-12 呈现义务（登记为输入，非本卡缺陷）**：
1. 面板处理 pending 时应按 `sourceActor === "external-merge"` 呈现「外部手改合并」标识——用户需要知道正在确认/放弃的是外部手改内容，而非 agent 提案；
2. discard 该类提案的确认文案宜提示「外部内容将仅存审计日志」；
3. S4 横幅三动作（查看 diff / 合并 / 拒绝）消费 `checkExternalModification` 的 `onDiskExcerpt`（200 字符预览），完整差异走外部 diff 端点。

---

## 五、红线审计

| # | 红线 | 证据 | 结论 |
|---|---|---|---|
| 1 | 167 零回归 | 177 = 167（T1-05 基线）+ 10，对账吻合；T1-02 平移测试 git 零改动 | ✓ |
| 2 | 无端点 / 无 UI | apps/ 与 packages/pi 零 `external` 引用 | ✓ |
| 3 | `rematerializeCurrentVersion` 调用点全仓**恰好两处** | grep 全仓（packages/ + apps/）：真实调用仅 external-modification-service.ts:64（reject）与 :135（merge 前置）；artifact-service.ts:453 为定义；其余命中皆注释/签名 | ✓ 无第三处绕过路径 |
| 4 | gate / audit / ports 零触碰 | git status 仅 3 项（1 M + 2 untracked，全在 domain/） | ✓ |
| 5 | L1 纯度（零 pi / 零 UI import） | grep 新两文件零命中 | ✓ |
| 6 | EXTERNAL_MODIFIED 兜底仍有效（D10） | A 对照组（reject 成功的同时同状态 submit/rollback 被挡）+ C 差分对照六态一致 | ✓ |

---

## 六、Findings 分级

| 级 | 项 | 说明 |
|---|---|---|
| **P3-1** | 实现者测试一处空洞断言 | `external-modification-service.test.ts:147` 硬编码 `join(dir, ".nextstep", …, "3.json")` 查「无新版本文件」，而真实常量 `NEXTSTEP_DIR_NAME === "nextstep"`（**无点**）——该断言查错目录、空洞成立（对不存在的目录断 exists=false 恒真）。H4 结论本身仍被同测 `listVersions` 长度 + `currentVersion`（走服务、走真实目录）权威覆盖，且 verifier 驱动已按真实目录复刻 `readdir 恰 {1.json,2.json}`，故不构成验收障碍。建议后续改为引用常量（或直接依赖 listVersions 断言删掉该行）；若 T1-08/T1-09 把常量终值定为 `.nextstep`，此类硬编码会成批静默失效，宜届时统一清 |
| 观察 | `NEXTSTEP_DIR_NAME` 无点 vs 注释/设计 `.nextstep` 张力 | T1-01 P3-1 / T1-02 INFO-1 已登记，留 T1-08/T1-09 H1 实证裁决。本卡实现侧未新增违规（代码走常量与 `materializedAbsPath`，未散落字面量；违例仅上述测试断言一处，已归 P3-1） |
| 输入 | T1-12 呈现义务 | 见 §四末三条：external-merge 来源标识、discard 提示文案、S4 横幅消费 onDiskExcerpt |

---

## 七、结论

干净态门禁全绿（install exit 0 / 3 workspaces tsc 零错误 / **177/177 = 167 零回归 + 10 对账吻合**）；verifier 自写 9 条驱动全过——reject 全链（逐行恢复、版本链零变化、真实目录无幽灵版本、恰一条审计、双对照组证明检测未失效）、**merge 缝隙独立复现 + 三分支 + 取消路径语义后果**逐一实证；共用实现双证据（源码唯一性 + 六态差分行为对照）；红线六项全过（rematerialize 恰两处调用、无端点/UI、L1 纯度）；改动范围与卡内声明逐字吻合、T1-02 平移零触碰。缝隙解法裁决成立：恢复基底前置 + 外部内容转提案载体，不绕过任何检测，D10 完整；discard 后仅存审计属可接受语义，呈现义务已登记 T1-12。唯一 finding 为 P3 级测试断言空洞（权威覆盖仍在），不阻塞。

STATUS: PASS —— 干净态 177/177（167 零回归 + 10 对账吻合，git 仅 1 M + 2 untracked 与卡声明一致），独立驱动 9/9（reject 全链双对照、缝隙复现、三分支、取消后 discard 语义、六态差分证同一比对实现），rematerialize 全仓恰两处调用，D10 兜底实证有效；P3-1 测试空洞断言不阻塞，T1-12 呈现义务已登记
