# T1-13 · Web E2E + 出口判据收官（真浏览器 + 通道①一致性）

> 柱子：**三柱全收**（第一期出口判据逐项跑绿 = 本轮交付句号）
> 让哪条变绿：**AC-1.1~1.4 端到端全绿、F1 纯 CLI 端到端成立、EXTERNAL_MODIFIED 保护实测有效、presentation 承重实证通过**（PRD 出口判据四项全项）；S1–S5 收官
> 层：L3（验收）｜ **新写**（`apps/web/e2e/`，Playwright；browser-e2e skill 环境）

## 依赖
- 前置卡：T1-10（工具全齐）、T1-11（server 全齐）、T1-12（面板全齐）；**本卡是最后一张**

## 实现要点
- **真浏览器 E2E（browser-e2e skill 走查）**，Playwright + fixture 领域存储（预置 v1–v3 版本链 + 5 块提案 fixture，与原型走查同构）：
  - S1 全流程：5 块内联高亮、逐块三色、有待定写回禁用、写回后 v4 物化（**读物化文件断言 v4 = v3 + 被收块、被拒块不进**）、web-panel.jsonl 有 approval_response（via: web-panel）
  - S2：全部接受 → 无待定 → v4 = 提案全文；批量后单块翻转（混合档）
  - S3：版本链完整/归属正确；回滚 v2 → v5 正文切换 + 回滚报告横幅（撤销 5 块、**确认过 N 块 = 3（3 收 2 拒 fixture，验证 P1-4 管线非巧合相等）**）+ 撤销回滚 → v6 = v4 内容、回滚版保留在链上
  - S4：外部手改（测试改写物化文件）→ 警告横幅 + 版本操作冻结 + 三动作（查看 diff / 合并 / 拒绝采纳后物化文件 = 系统版本）
- **通道①一致性（唯一真相断言，S5③ 措辞校准——P3：版本链真相在领域存储、审计真相在会话 JSONL，两处职责不同）**：
  - CLI 侧物化（L2 集成进程或真机跑出）→ Web 面板重载显示同版本（读路径共享 fixture）
  - Web 面板写回 → CLI 侧 `list_artifacts` / `get_artifact_history` 读到新版本
  - **共享 fixture 目录机制（P2-10）**：e2e 脚本分阶段执行（先 CLI 后 Web 或反之），同一临时项目目录 + 文档写明共享路径约定
  - **P2-3 覆盖论证**：CLI→Web 方向无直接 E2E 的场景，用「写路径单测（T1-10）+ 读路径 fixture（本卡）」组合论证，本卡文档明示
  - **P2-1 轻量审计断言**：同一 artifact 的 CLI 条目（artifact_proposed/approval_request）与 Web 条目（approval_response/artifact_resolved）按 ts 合并后可构成完整操作史（**只断言各自文件内完整性 + 共享 artifactId/changeId 关联，不承诺跨文件排序合并——显式推迟第三期**）
- **真机 S5 冒烟（P3 注记）**：纯 CLI 端到端（create → propose → 汇总卡 → 逐块/全收 → 物化留版）依赖人手，由 verifier 在双层验收时执行（人工清单：六工具可调、无 write/edit、受管路径直写被硬挡）。
- 出口判据映射表（PRD）逐项打勾入本卡报告。

## 验收断言（可执行）
- [ ] S1–S4 四组 E2E 断言全过（含物化文件级断言与审计文件级断言）
- [ ] 通道①一致性两组断言过（双向）
- [ ] 审计完整性轻量断言过（CLI/Web 条目各自完整 + artifactId/changeId 关联成立）
- [ ] 出口判据映射表四项全绿（AC-1.1~1.4 / F1 纯 CLI / EXTERNAL_MODIFIED 实测 / presentation 承重）——真机 S5 冒烟由 verifier 执行并留痕
- [ ] 真浏览器内无 hydration/集成类 bug（browser-e2e skill 关注点：刷新后状态不丢、写回按钮不卡死禁用）

## 完成判据
E2E 全绿 + 出口判据映射表四项打勾 + 验收报告落盘 + 逐卡 commit。**本卡完成 = 第一期（round-1）实现收官，等待双层验收。**
