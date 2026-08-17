# T1-05 · pending-gate-service：提案→确认→物化编排 + 守卫 + discard（L1 核心编排）

> 柱子：**可控**（F1 闸门唯一的领域编排；承重墙 2 的 L1 侧）
> 让哪条变绿：F1 纯 CLI 端到端（闸门侧）、S1/S2（确认分档记账）、S3（回滚守卫）；P1-1①、P1-2 全部、P1-3 的编排落点
> 层：L1｜ **新写**（`packages/core/src/gate/pending-gate-service.ts`）

## 依赖
- 前置卡：T1-03（baseVersion 校验）、T1-04（条目类型 + DecisionPort/AuditPort + sourceRef 构建）

## 实现要点
- **`proposeWithGate(deps, projectId, { artifactId, newContent, sourceActor })`**（详细设计 §3 十步流程，P1-3 修订后）：
  1. 查未决：该 artifact 已有 pending → 返回引导先处理（旧仓 doc-tools.ts:178-186 语义保留）
  2. `readCurrentContent` → `computeReplaceDiffBlocks` 切块；空块 → 「内容无变化」
  3. `buildReplacePendingChange({ ..., baseVersion: artifact.currentVersion })` → `pendingStore.save`
  4. auditPort.append(`artifact_proposed`)
  5. **auditPort.append(`approval_request` {status:"pending"}）——P1-3：由 gate 编排统一写，端口只返回 Decision**（「仅在 ask 路径产生；Web 面板直接写回无问询 → 不产生 request 条目」注释于此）
  6. `decisionPort.ask(req)` → 三路分支：
     - `resolved` → 逐块 `resolveBlock`（action 按 decision 映射）→ `resolveAndMaterialize`（baseVersion 校验在内）→ auditPort.append(`approval_response`) → auditPort.append(`artifact_resolved` 含 `buildSourceRefs`（T1-04）) → 返回 `{ changeId, diffBlockCount, materialized, newVersion }`
     - **`cancelled`（P1-1①）→ pending 保留，返回「已提案未确认，changeId=…，可用 Web 面板或重试处理」**（工具结果文本语义由 T1-10 承接）
     - `deferred`（Entry 端口，本期不接线，单测覆盖类型）
- **`rollbackWithAudit(deps, projectId, artifactId, { version, via })`**：**守卫（P1-2①，原型复走二实证丢失项）——`pendingStore.listPendingChanges` 非空 → 拒绝回滚**（文案「有待确认提案未处理，暂不可回滚」，对齐原型）→ 通过后 `ArtifactService.rollback` + auditPort.append(`artifact_rollback` {undoing:false})。
- **`rollbackUndoWithAudit`**：= 以恢复目标版再回滚一次（P2-8 契约：撤销「回滚到 v2」→ 内容回到 fromVersion=v4；端点参数 = 恢复目标版号）→ `artifact_rollback` {undoing:true}。守卫同上（有 pending 拒绝）。
- **`discardWithAudit(deps, projectId, artifactId, changeId, { via, reason })`（P1-2②）**：`pendingStore.remove` + auditPort.append(`approval_response` {status:"discarded", decisions:[]})——**冲突闭环的出口**：BASE_VERSION_CONFLICT → discard → 重新提案不再被「查未决」挡。
- GateDeps 全部可注入（stub DecisionPort / stub AuditPort / 内存临时目录后端）——L1 纯单测可跑通整条确认链，**不碰 pi**。

## 验收断言（可执行）
- [ ] 全流程：stub 返回 5 块全收 → v4 物化、pending 删除、`artifact_proposed → approval_request → approval_response → artifact_resolved` 四条目按序落入 stub AuditPort 记录（**P1-3：断言门控的是 gate 编排，不是 stub**——stub 不写审计）
- [ ] 部分确认：2 收 3 拒 → v4 内容 = v3 + 被收块（applyResolvedBlocks 不变量在编排层复验）；`artifact_resolved.acceptedBlocks/rejectedBlocks` 与决策一致
- [ ] **取消路径（P1-1①）**：stub 返回 cancelled → pending 文件仍在、AuditPort 无 approval_response/artifact_resolved、返回文本含「已提案未确认」与 changeId
- [ ] **守卫（P1-2①）**：存在未决 pending 时 `rollbackWithAudit` 抛拒绝（错误码或返回语义明确）、版本链不变
- [ ] **discard 闭环（P1-2③）**：提案 baseVersion=3 → 上游回滚（当前 v4）→ resolve 抛 BASE_VERSION_CONFLICT → `discardWithAudit` 删 pending + 审计 status:"discarded" → **重新 `proposeWithGate` 成功**（不被查未决挡）
- [ ] 有未决时二次 propose → 返回引导先处理（旧仓语义回归）
- [ ] 撤销回滚：`rollbackUndoWithAudit` 以 fromVersion 内容生成新版本、`undoing:true`

## 完成判据
gate 全路径单测绿（含上述 7 组断言）+ 逐卡 commit。
