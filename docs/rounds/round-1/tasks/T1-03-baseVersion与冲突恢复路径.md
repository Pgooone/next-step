# T1-03 · PendingChange.baseVersion 与冲突校验（L1 领域层）

> 柱子：**可追溯返工**（挂起提案撞上回滚 = 返工正确性问题；调查缺口②的直接落点）+ **可控**（守卫冲突现场）
> 让哪条变绿：支撑 S3（回滚安全）；P1-2 的 L1 领域层部分（校验与恢复基础，守卫/discard 编排见 T1-05）
> 层：L1｜ **改签名**：`pending-change-service.ts`（旧仓 :39-49, :205-223, :360-382）、`artifact-service.ts`（:53-61 错误码）

## 依赖
- 前置卡：T1-02（三服务原样搬）

## 实现要点
- `PendingChange` 类型（旧仓 :39-49）加字段：`baseVersion: number`——提案创建时 `artifact.currentVersion` 的显式快照（详细设计 §1.1）。
- `buildReplacePendingChange`（旧仓 :205-223）入参加 `baseVersion`；`buildPatchPendingChange`（:226-243）同步加（本期 patch 路径不接线，类型一致）。
- `ArtifactError`（旧仓 :53-61）错误码联合加 `"BASE_VERSION_CONFLICT"`（409 语义，文案「上游版本已变更（当前 vX ≠ 提案基底 vY），请重新提案」）。
- `resolveAndMaterialize`（旧仓 :360-382）在 `submitVersion` **之前**校验 `artifact.currentVersion === change.baseVersion`；不符 → 抛 `BASE_VERSION_CONFLICT`，**pending 文件不删**（保留现场供 discard/重新提案）。
- 兼容语义（详细设计 §1.1）：旧 pending 文件无 baseVersion 字段 → 读取后校验直接失败并提示重新提案（不留歧义）。
- **本卡不做**：discard 服务函数与守卫（T1-05，需 AuditPort）；审计条目（T1-04）。

## 验收断言（可执行）
- [ ] `baseVersion 匹配 → resolveAndMaterialize 物化成功`：baseVersion=3、当前 v3 → 物化 v4，pending 删除
- [ ] `baseVersion 失配 → 抛 BASE_VERSION_CONFLICT`：提案时 v3（baseVersion=3）→ 上游先 rollback 到 v2（当前 v4）→ resolve → 抛 `BASE_VERSION_CONFLICT`、pending 文件**仍在**、版本链不变
- [ ] `旧 pending 无 baseVersion → 校验失败并提示重新提案`（构造无该字段的 fixture）
- [ ] 错误码映射：`BASE_VERSION_CONFLICT` 属 409 语义（L1 断言 code 字段）
- [ ] 既有平移测试不回归（T1-02 全绿保持）

## 完成判据
新增/修改单测全绿 + 平移回归不破 + 逐卡 commit。
