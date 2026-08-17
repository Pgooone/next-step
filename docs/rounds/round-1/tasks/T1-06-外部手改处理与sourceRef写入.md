# T1-06 · 外部手改处理（check / reject 覆盖式物化 / merge 转提案）（L1）

> 柱子：**可控**（EXTERNAL_MODIFIED 保护 = D10 红线 + S4 场景；覆盖动作的用户指令路径明示）
> 让哪条变绿：S4（外部手改三动作）、AC 通行项「EXTERNAL_MODIFIED 保护实测有效」；P1-7、H3/H4 落点
> 层：L1｜ **新写**（`packages/core/src/domain/external-modification-service.ts`）+ 既有比对逻辑**抽取**

## 依赖
- 前置卡：T1-04（`artifact_external_resolved` 条目 + AuditPort）、T1-05（merge 走 proposeWithGate）

## 实现要点
- **`checkExternalModification(projectId, artifactId): { modified: boolean; onDiskExcerpt?: string }`**：把旧仓 `assertNotExternallyModified`（artifact-service.ts:130-144）的比对逻辑抽成公共纯函数（读真实文件 vs 当前版快照 content 逐字节比对；文件不存在 → 未修改），供断言与面板检测共用。
- **`rejectExternalModification(deps, projectId, artifactId, { via })`（P1-7 核心）**：**覆盖式物化**——把当前版 content 原子写回物化文件（atomicWrite，tmp+rename）。**明示语义：这是用户指令路径，绕过 `assertNotExternallyModified` 的检测**（旧仓该检测挡的是「AI 静默覆盖」；此处覆盖是用户显式选择「拒绝采纳，恢复系统版本」）。**不生成新版本（H4 定案：内容未变，生成 v{n+1}=v{n} 是幽灵版本污染 get_artifact_history）**。写审计 `artifact_external_resolved` {action:"reject"}。**有 pending 时语义**：拒绝采纳恢复系统版本不影响未决 pending（pending 针对的基底内容仍是当前版，baseVersion 校验继续兜底）。
- **`mergeExternalAsProposal(deps, projectId, artifactId, { via })`**：读外部内容 → 以外部内容为 newContent 调 `proposeWithGate`（走同一条逐块确认通道，原型 extMerge 语义）——复用 T1-05，**本卡只做接线**。
- sourceRef 的写入侧已在 T1-05 的 artifact_resolved 完成（T1-04 buildSourceRefs）——本卡不做重复实现。

## 验收断言（可执行）
- [ ] `checkExternalModification`：外部改文件 → modified:true；未改/文件不存在 → false（旧仓 :136 「文件不存在放行」语义保持）
- [ ] **拒绝采纳（P1-7 单测）**：外部手改后 `rejectExternalModification` → 物化文件 = 当前版内容、**版本链不变（版本数不变、无新版本文件）**、出现 `artifact_external_resolved` {action:"reject"} 审计
- [ ] 拒绝采纳不经过 `assertNotExternallyModified`（不抛 EXTERNAL_MODIFIED——测试先改文件再 reject，断言成功而非被挡）
- [ ] merge：外部内容 → 产生 PendingChange（baseVersion = 当前版）、走逐块确认全流程
- [ ] 原有 `assertNotExternallyModified` 行为不回归（T1-02 平移测试保持绿——抽取后共用同一实现）

## 完成判据
单测全绿（含上述 5 组）+ 逐卡 commit。
