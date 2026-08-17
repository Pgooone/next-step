# T1-11 · 薄 server（L3 Web 壳后端：直调 L1 + 审计写回 web-panel.jsonl）

> 柱子：**可控**（Web 写通道 = 第一期最小写入通道，D8 拍板；壳零领域判断红线载体）
> 让哪条变绿：S1 写回、S2 批量、S3 回滚/撤销、S4 外部手改三动作的 server 侧；P1-2②（discard 端点）、H2/H5 落点
> 层：L3｜ **新写**（`apps/web/server/`）

## 依赖
- 前置卡：T1-05（gate 全部编排）、T1-06（external 服务）、T1-07（AuditPort 工厂 `createEntryAuditPort`）

## 实现要点
- **壳零领域判断**：每个端点 = 参数解析（校验用户输入）→ 直调 L1 服务 → 序列化返回；写盘只发生在 L1（resolveAndMaterialize / rollback / reject 覆盖物化，旧仓红线「写盘只在此处发生」语义保持）；**server 层无任何领域逻辑**（代码审查项）。
- **端点表（P2-2 修正：删除无消费场景的 GET /api/sessions，不回潮）**：
  - `GET /api/artifacts` → listArtifacts（H5：顶部项目下拉数据源 = ProjectRegistry.list）
  - `GET /api/artifacts/:id` → getArtifact + listVersions + `checkExternalModification`（面板打开即检测，S4）
  - `GET /api/artifacts/:id/pending` → listPendingChanges + presentation 构建
  - `POST /api/artifacts/:id/pending/:changeId/resolve` `{ blockId?, action }` → `resolveAndMaterialize`（**端点侧不经 DecisionPort——问的对象已是人，详细设计 §6 注释层明示**）；写 `approval_response`（via: web-panel）+ `artifact_resolved`（经 AuditPort，落 **web-panel.jsonl**）
  - `POST /api/artifacts/:id/pending/:changeId/discard`（**P1-2②**）→ `discardWithAudit`（守卫内已含「无 pending 不可 discard」语义）
  - `POST /api/artifacts/:id/rollback` `{ version }` → `rollbackWithAudit`（**有 pending 时拒绝回滚，守卫在 L1**）→ 409 + 文案「有待确认提案未处理，暂不可回滚」
  - `POST /api/artifacts/:id/rollback/undo` `{ version }` → `rollbackUndoWithAudit`（**P2-8 契约：version = 恢复目标版**，撤销「回滚到 v2」→ 内容回到 fromVersion=v4）
  - `GET /api/artifacts/:id/external/diff` → checkExternalModification + 差异快照
  - `POST /api/artifacts/:id/external/merge` → `mergeExternalAsProposal`（落盘待确认，面板继续逐块）
  - `POST /api/artifacts/:id/external/reject` → `rejectExternalModification`（H4：不生成新版本）
- **H2 落地 + P2-1 裁量登记**：审计条目经 `createEntryAuditPort(webPanelSessionManager)` 写**独立固定会话文件 `web-panel.jsonl`**（Web server 唯一 writer，单 writer 自守）；**在 server README 或 ADR 登记**「对正本 §5.2『Web 想写就 fork(entryId) 分支』字面的实现裁量：第一期无 entry 级操作需求，固定文件替代真 fork；代价 = 无 parentId 血缘、跨文件审计合并推迟第三期（第一期不承诺）」。
- 错误映射：BASE_VERSION_CONFLICT → 409 + 引导文案「请放弃当前提案（discard）后重新提案」；NOT_FOUND/INVALID/VERSION_CONFLICT/EXTERNAL_MODIFIED → 对应 4xx。
- 单进程假设（P3）：第一期只允许一个 Web server 实例写 web-panel.jsonl（启动时独占检查或文档注记）。

## 验收断言（可执行）
- [ ] server 集成测试（直调 L1 + 内存 HTTP 或 supertest 等价）：10 端点逐一可调且返回值与 L1 服务一致
- [ ] resolve 写回后：web-panel.jsonl 出现 `approval_response`（via:"web-panel"，decisions 逐块完整）+ `artifact_resolved`（P2-1 审计完整性断言的数据源）
- [ ] discard 端点：冲突后 discard 成功删 pending、写 `approval_response` status:"discarded"
- [ ] rollback 端点：有 pending 时 409 拒绝（守卫透传）；无 pending 时成功且写 `artifact_rollback`
- [ ] undo 端点契约：`POST /rollback/undo { version: 4 }` 后物化文件 = v4 内容（P2-8）
- [ ] reject 端点：物化文件 = 当前版内容、版本链不变、写 `artifact_external_resolved` action:"reject"
- [ ] 代码审查项：server 层无领域判断（grep 无 pendingStore/artifactService 直接实例化之外的逻辑——所有领域调用走 L1 服务函数）

## 完成判据
集成测试全绿 + 裁量登记落档 + 逐卡 commit。
