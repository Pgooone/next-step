# e2e · T1-13 端到端体系（真浏览器 + 通道①一致性）

一期收官验收层：**真浏览器 E2E（Playwright + 系统 Chrome）** 覆盖 S1–S4 全场景 +
BASE_VERSION_CONFLICT 异常闭环 + 通道①双端一致；**S5 真机冒烟**（真模型 + tmux）覆盖
纯 CLI 端到端。出口判据逐条证据见 `docs/rounds/round-1/qa/T1-13-exit-report.md`。

## 文件

| 文件 | 职责 |
|---|---|
| `run-e2e.sh` | 一键编排（可重复）：build → 薄 server（独立 HOME 数据目录）→ 共享 fixture 种子 → 真浏览器驱动 → 收尾。`npm run e2e`（apps/web） |
| `drive-e2e.mjs` | 真浏览器主驱动：S1 混合裁决 / S2 批量+翻转 / S3 版本链回滚+撤销 / S4 外部手改三动作 / E5 冲突闭环 / C6 通道① CLI→Web，逐断言含物化文件级 + 审计文件级断言，并产出截图组 |
| `fixture-seed.mjs` | 共享 fixture 种子（幂等）：demo 项目 + 设计文档 v1–v3 + v4 提案（5 块 deferred）；`--audit-only` 清审计基线 |
| `fixture-content.mjs` | 文档正文/提案/外部手改行的**单一来源**（种子模板注入 + 驱动断言同源） |
| `cli-ops.mjs` | CLI 侧操作（L2 集成进程复用六工具注册表）：create / propose / materialize / read / submit-version，审计落 `cli-session.jsonl` |
| `cli-smoke.sh` + `smoke-probe.ts` | S5 真机冒烟（真模型 + tmux 全链，可重复）；verifier 双层验收时执行 |

## 共享 fixture 目录机制（P2-10）

`NS_E2E_DATA` 指向同一领域存储目录，由 `run-e2e.sh` 统一导出，三方共用：

1. **fixture-seed.mjs**（种子）——重建 demo 项目 + 提案
2. **cli-ops.mjs**（CLI 读侧）——对同一目录执行工具操作，审计落 `cli-session.jsonl`
3. **薄 server**（Web 读侧）——`HOME=$RUN_DIR` 使 `~/.nextstep` 指向同一目录，审计落 `web-panel.jsonl`

「种子 → 场景序列」在同一目录上可反复执行（种子幂等：同名 demo 项目删除重建）。

## 覆盖论证（P2-3）

**CLI→Web 方向**（CLI 写 → Web 读）无直接真模型 E2E 的场景，用两段组合论证：

- **写路径**：T1-10 单测 + verifier 独立驱动覆盖（propose_edit 全链、物化重建不变量、
  AC-1.4 零副作用逐 byte）；本卡 `cli-ops.mjs` 复用**同一 doc-tools.ts 实现**（只换
  decisionPort stub），写路径语义一致。
- **读路径**：本卡 C6 场景——CLI 物化 v5 → Web 面板重载显示同版本 + Web API 版本链
  含 CLI 物化版；E5 场景——CLI 提案 → Web 裁决；双端逐字段断言（C6-⑤/⑥、E5-⑪~⑬）。

**Web→CLI 方向**（Web 写 → CLI 读）：C6/E5 同一 fixture 目录上，CLI 读侧
`get_artifact_history`/`get_artifact_diff`/`list_artifacts` 与 Web API 返回逐字段比对。

## 审计轻量断言（P2-1）

- CLI 条目（`artifact_proposed`/`approval_request`）与 Web 条目
  （`approval_response`/`artifact_resolved`）**各自文件内完整**（ns/ts/kind/artifactId
  必备字段遍历，E5-⑭）；
- 同一 `changeId` 在两文件成对出现（E5-⑩）；
- **跨文件按 ts 排序合并显式推迟第三期**（本卡不承诺跨文件排序；P2-1 原文：第三期才做
  合并，本期只断言各自文件内完整性 + 关联）。

## S5 真机冒烟（cli-smoke.sh）

真模型 + tmux 全链：create → 只读三工具 → propose → 汇总卡逐键确认 → 物化 v2 →
领域目录断言 → 临时 Web server 读同一数据目录断言版本链（S5 期望③唯一真相）。
证据：`/tmp/t1-13-smoke/smoke.pane`（逐帧）+ `probe.log`（装配/调用留痕）+
`web-read.log`（Web API 返回）。DeepSeek key 从仓库根 `.env.pi-test` 读取，仅注入
进程环境，不进入代码/日志/报告。

## 已知断言适配（schema 差异）

- CLI `get_artifact_diff` 块（`lineStart`/`lineEnd` 行区间）与 Web presentation 块
  （`anchor` 标题锚）表示不同：双端一致断言按可比字段（kind/lines/oldLines + 含标题块
  的锚推导）比对（E5-⑫/⑫b），不伪造不存在的字段。
- 物化/回滚版本 `author=user`（旧仓语义）：`list_my_artifacts`「名下」只命中
  create_artifact 建版（C6-⑦ 先建归属前提再断言）。
- 面板错误横幅为人话文案（不暴露错误码）：错误码由 API 级断言兜底（E5-②b 409
  BASE_VERSION_CONFLICT）。
