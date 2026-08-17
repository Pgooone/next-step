# next-step-web · 薄 server（T1-11，L3 Web 壳后端）

Node 原生 `node:http`，零运行时依赖（`@pgoone/next-step-pi` 为 workspace 依赖）。
每个端点 = 参数解析 → 直调 L1 领域服务 → 序列化返回，**壳零领域判断**（详细设计 §6）。

## 端点（详细设计 §6 最小接口表，P2-2 修订无 GET /api/sessions）

| 方法 & 路径 | 直调 L1 | 审计条目 |
|---|---|---|
| `GET /api/artifacts?projectId=` | `ProjectRegistry.list` + `ArtifactService.listArtifacts` | — |
| `GET /api/artifacts/:id` | `findArtifact` + `getArtifact` + `listVersions` + `checkExternalModification` | — |
| `GET /api/artifacts/:id/pending` | `listPendingChanges` + presentation 构建 | — |
| `POST /api/artifacts/:id/pending/:changeId/resolve` `{ blockId?, action }` | `resolveAndMaterialize`（L1 baseVersion 校验） | `approval_response`（via: web-panel）+ `artifact_resolved` |
| `POST /api/artifacts/:id/pending/:changeId/discard` `{ reason? }` | `discardWithAudit`（无 pending 守卫在 L1） | `approval_response`（status: discarded） |
| `POST /api/artifacts/:id/rollback` `{ version }` | `rollbackWithAudit`（有 pending 守卫在 L1 → 409） | `artifact_rollback`（undoing: false） |
| `POST /api/artifacts/:id/rollback/undo` `{ version }` | `rollbackUndoWithAudit`（P2-8：version = 恢复目标版） | `artifact_rollback`（undoing: true） |
| `GET /api/artifacts/:id/external/diff` | `checkExternalModification` + 块级差异快照 | — |
| `POST /api/artifacts/:id/external/merge` | `mergeExternalAsProposal`（entry 端口语义，落盘待确认） | `artifact_external_resolved`（action: merge，L1 内写） |
| `POST /api/artifacts/:id/external/reject` | `rejectExternalModification`（H4：不生成新版本） | `artifact_external_resolved`（action: reject，L1 内写） |
| `GET /api/audit/replay?artifactId=` | T1-12 审计回放：读 web-panel.jsonl 返回条目 data 数组（按 artifactId 过滤，纯读取） | — |

错误映射：`NOT_FOUND`→404 / `INVALID`→422 / `VERSION_CONFLICT` / `EXTERNAL_MODIFIED` /
`BASE_VERSION_CONFLICT` / `PENDING_EXISTS`→409（BASE_VERSION_CONFLICT 附引导文案
「请放弃当前提案（discard）后重新提案」）。

## 审计通道与裁量登记（P2-1）

审计条目经 L2 工厂 `createEntryAuditPort` 写入**独立固定会话文件 `web-panel.jsonl`**
（默认 `~/.nextstep/web-panel.jsonl`；Web server 唯一 writer，单 writer 自守）。

**对正本 §5.2「Web 想写就 fork(entryId) 分支」字面的实现裁量**：第一期无 entry 级操作
需求，固定文件替代真 fork。代价：无 parentId 血缘（恒 null）、跨文件审计合并推迟第三期
（第一期不承诺）。

**落盘实现说明（前置事实驱动）**：pi 的 `SessionManager._persist` 在首条 assistant 消息
到场前不落盘任何 custom 条目——Web server 的会话文件永远不会有 assistant 消息，经
SessionManager 写审计会滞留内存；且构造 SessionManager 需直接 import pi，违反「只有 L2
import pi」红线。故实现 `WebPanelSessionManager`（`apps/web/server/web-panel-audit.ts`）
**直写 JSONL**：行格式与 pi `appendCustomEntry` 产物同构
（`{ type:"custom", customType, data, id, parentId, timestamp }`），第三期合并无需格式
迁移，仅缺血缘。审计文件写入后**即刻可见**（不依赖任何 flush 事件）。

## 运行

```bash
PORT=8787 npm run server --workspace @pgoone/next-step-web   # 默认端口 8787
```

`server` = esbuild bundle（`build:server`，产物 `dist-server/index.js`，Node >=20 直接
跑）。为什么 bundle 而非 Node 原生直跑 TS：L1 领域包内部全部是无扩展相对 import +
TS 参数属性，Node 原生执行需改 pi 包源码（越界），bundle 单文件无运行时解析问题。

- 单进程假设（P3）：启动时对 `~/.nextstep/web-panel.lock` 做 `wx` 原子独占检查，已有
  实例在跑则拒绝启动。
- 领域存储默认 `~/.nextstep/projects.json`（与 CLI 共用同一 ProjectRegistry，H5）。
- 静态资源（T1-12）：`server` 脚本先 esbuild 打包前端（`build:web`，产物 `dist-web/`），
  GET 未命中 API 路由时从 `dist-web/` 取文件（`/` → index.html；路径穿越已做防护）。
  前端零框架原生 ES 模块（`web/` 源码），只 fetch 本 server 端点 + 画 presentation（零
  pi import、零领域判断，见 web/renderer.test.ts 静态审查断言）。

## 演示数据与视觉核验截图

```bash
node scripts/seed-demo.mjs   # 造「设计文档.md」v1–v3 + v4 提案（5 块，幂等重建 demo 项目）
node scripts/web-shot.mjs    # headless-shell + CDP 驱动真实交互截图（初始/混合/写回/回滚 5 张）
```
