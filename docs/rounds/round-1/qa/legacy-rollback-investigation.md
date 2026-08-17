# 旧仓回滚实现机制调查（代码考古）

调查对象：`/home/pgoone/GitHubproject/Next-Step/next-step-V1.2/`
调查时间：2026-08-17

## 0. 总览：回滚 = 「复制旧版成新版」的追加式版本模型

旧仓对受管文档（artifact）采用**追加式版本快照**模型：每个 artifact 有独立的版本号文件，回滚/提交新版本都是「写一个更高版本号的新快照 + 更新元数据 + 物化真实 .md 文件」，**永不覆盖或删除旧版快照**。全部数据随项目落盘在 `<projectRoot>/.pi/artifacts/managed/<id>/`，无数据库。

---

## 1. 回滚（rollback）的实现

**函数签名**：`rollback(projectId: string, id: string, input: { version: number; ifMatch?: number }): Artifact`
`lib/domain/artifact-service.ts:324`

**执行步骤**（`lib/domain/artifact-service.ts:324-365`）：

1. 读元数据 + 乐观锁校验 `assertVersionMatch`（If-Match 不等 → VERSION_CONFLICT 409）— :326
2. 校验目标版本号为整数（否则 INVALID 422）— :328-330
3. 目标版本文件存在性检查（不存在 → NOT_FOUND 404）— :331-334
4. **读目标版本快照的 content** — :335
5. 外部编辑保护 `assertNotExternallyModified`（见第 5 题）— :337-339
6. **复制目标版 content 写成新版本**：`versions/<currentVersion+1>.json`，`note: "rollback to v{n}"`，author 固定 "user" — :341-354
7. 元数据更新：`currentVersion+1`、`version+1` 原子写回 artifact.json — :356-361
8. **物化真实文件**：把回退到的 content 覆盖写到磁盘真实 .md — :363

**关键语义**（注释原文 :322）：「不删除任何旧版（回滚 = 追加新版）」。注释 :320-321 明示「**复制目标版 content 成新版**（currentVersion+1，note=`rollback to v{n}`）」。

**物化文件的改写方式**：**直接覆盖物化路径**（`materialize` → `atomicWrite` = 「临时文件 + rename」原子写，非原地改写）：`lib/domain/artifact-service.ts:115-119`、`:424-428`。物化路径 = `projectRoot 拼 artifact.filePath`，见第 3 题。

---

## 2. 版本快照存储

**目录布局**（注释 :73-82）：

```
<projectRoot>/.pi/artifacts/managed/<id>/
  artifact.json        — Artifact 元数据（含 currentVersion + version 乐观锁计数）
  versions/<n>.json    — 第 n 版 ArtifactVersion；写新版 = 写新文件名、永不覆盖旧版
```

- **元数据文件**：`artifact.json`，含 `id/projectId/kind/title/currentVersion/version/status/filePath` — `lib/domain/artifact-service.ts:20-35`
- **版本文件**：`versions/<version号>.json`，内容为 `ArtifactVersion`（`id/artifactId/version/content/author/note?/createdAt`）— `:38-46`
- **版本链数据结构**：没有链表/指针结构。`unique(artifactId, version)` 由「版本号即文件名」天然保证（:37 注释）；当前版本 = `currentVersion`，读 `versions/<currentVersion>.json`（:79）。列版本 = 扫目录按 version 升序（`listVersions` :257-268）。
- **写入方式**：「临时文件 + rename」原子写，单进程单用户无 DB（:81-82、:424-428）。

---

## 3. 物化文件的真实路径规则

**物化绝对路径** = `join(projectRoot, artifact.filePath)` — `lib/domain/artifact-service.ts:109-112`（`materializedPath`）。

`filePath` 在 **create 时一次性生成**并落进 artifact.json，此后 submit/rollback 均以此为准（不随 title 改而漂移）— 注释 :29-32。

**生成规则**（`buildArtifactFileName`，`lib/domain/file-name.ts:47-59`）：

1. `sanitizeFileName(title)`：仅把文件系统非法字符 `/ \ : * ? " < > |` 与控制字符替换为 `_`，**保留中文/Unicode** — `:21-26`
2. 截断到 80 字符（UTF-8 中文 3 字节上限兜底）— `:33`、`:48`
3. 拼 `.md` 后缀；若 `<base>.md` 在目标目录已存在，依次试 `<base>-2.md`、`<base>-3.md`… 直到避让成功 — `:52-58`

即：**受管文档物化到项目根目录**（V2-1 取舍：物化到项目根，`artifact-service.ts:157` 注释），文件名由 title 清洗生成并避让同名。

---

## 4. Web 侧 / CLI 侧触发链路

**Web 侧（前端 → 路由 → 服务）**：

- 前端 store：`lib/stores/useArtifactStore.ts:255-284` — `rollback(toVersion)` fetch `POST /api/artifacts/[id]/rollback`，Header 带 `If-Match: String(artifact.version)`（乐观锁），body `{ version: toVersion }`；成功后自行 `refresh()` 重拉。
- 路由：`app/api/artifacts/[id]/rollback/route.ts:9-25` — 解析 If-Match + 校验 version 整数 → `findArtifact(id)` 跨项目定位 → `service.rollback(projectId, id, { version, ifMatch })`（:19-20）。

**CLI 侧**：**不存在独立 CLI 命令**。`bin/` 下唯一入口 `bin/pi-web.js` 只是一个启动器（spawn `next start` 并开浏览器，见 `bin/pi-web.js:1-60` 结构）。回滚、提交、pending 确认均**只能经 Web 页面触发**，服务端 App Router 路由层是唯一入口。

（附：pending 确认链路 = 前端 `hooks/useResolveBlock.ts` → `POST /api/artifacts/[id]/pending/[changeId]/resolve` → `PendingChangeStore.resolveAndMaterialize`，见 `app/api/artifacts/[id]/pending/[changeId]/resolve/route.ts:15-36`。）

---

## 5. EXTERNAL_MODIFIED 检测

**检测时机**：**只在写盘前**（提交新版本、回滚时各一次），**读取时不做检测**。调用点仅两处：
- `submitVersion`：`lib/domain/artifact-service.ts:291`
- `rollback`：`lib/domain/artifact-service.ts:339`

**比对方式**：**内容全文字符串比对**，不是哈希也不是 mtime — `assertNotExternallyModified`（`lib/domain/artifact-service.ts:130-144`）：
- 读真实文件现状 `readFileSync(abs, "utf-8")`（:137）
- 与「上一当前版」快照的 content（= 我们上次物化写下的内容）逐字节比较（:138）
- **不一致 → 抛 `ArtifactError("EXTERNAL_MODIFIED")`** → API 层映射 409（:53-61、:139-143）
- **真实文件不存在**（被外部删/尚未物化）→ 视为无外部改动，放行（:136）
- 无 filePath 的旧 artifact → 放行（:136）

**时序保证**（注释 :127-129）：刻意与 materialize 分离、在写任何新版本/元数据**之前**调用；一旦判定外部改动，整次 submit/rollback **干净失败**，不留「版本已加但真实文件没更新」的半截状态。

---

## 6. Web 操作后通知 CLI 的机制

**没有**。全仓 grep 无 SSE / WebSocket / EventSource / broadcast / fs.watch / chokidar 等任何推送机制（仅 mastermind 面板有前端自轮询 `setInterval`，与 artifact 无关）。

- `lib/stores/useArtifactStore.ts:24-25` 注释**明示设计取舍**：「无 SSE（D-D5-2 选 A：自己触发的操作后直接 refresh），不动 useAgentSession 的 SSE switch」。
- 前端每次写操作成功后自行 `refresh()` 重拉（`:273`、useResolveBlock.ts:39）。
- **写盘只发生在服务端** `resolveAndMaterialize`（`lib/domain/pending-change-service.ts:360-382`），路由层是薄调用（`app/api/artifacts/[id]/pending/[changeId]/resolve/route.ts:11-13`）。

即：**Web 与 CLI（若有）不是通过事件同步，而是共享同一套随项目落盘的文件存储**；状态一致靠「同一进程内的 service 读同一个文件目录」+ 前端主动重拉实现。

---

## 7. 写回 / 确认（pending approve）的落盘

**落盘链路**（`resolveAndMaterialize`，`lib/domain/pending-change-service.ts:360-382`）：

1. `resolveBlock`：把指定块（或全部 pending 块）state 置为 confirmed/rejected，原子写回 pending JSON — `:316-342`
2. 若该条 PendingChange **全部块非 pending**：`applyResolvedBlocks` 按块 state 从原文重建新内容（纯函数，`:165-198`）→ **`ArtifactService.submitVersion`** 出新版（If-Match = 当前 version 乐观锁，note = `apply pending ${id}`）→ **`remove` 删除该 pending 文件**（pending 目录只放未决）— `:368-381`
3. **写盘红线**：「写盘只在此处发生」（注释 :355-356），前端绝不直接改 content（useResolveBlock.ts:47-48 注释红线②）。

**审计/会话日志**：**没有独立的会话日志或审计记录**。全仓 grep `audit / session-log / 会话日志 / activity` 无命中。唯一的可追溯载体是：
- 版本快照自身的 `author / note / createdAt` 字段（`lib/domain/artifact-service.ts:38-46`），确认写入时的 note 为 `apply pending <id>`、回滚时 note 为 `rollback to v<n>`；
- pending 文件在物化后删除（`pending-change-service.ts:380`），回溯只能靠版本 note。

---

## 关键结论速查

| 问题 | 答案 | 关键证据 |
| --- | --- | --- |
| 1. 回滚怎么做 | 复制目标版 content 追加为新版本（currentVersion+1），不删旧版，然后物化覆盖真实文件 | artifact-service.ts:324-365 |
| 2. 版本存哪 | `<projectRoot>/.pi/artifacts/managed/<id>/versions/<n>.json` + `artifact.json`；版本号即文件名 | artifact-service.ts:73-106 |
| 3. 物化路径 | `projectRoot` 拼 create 时由 title 清洗生成的 `filePath`（避让同名、80 字符截断、保留中文） | file-name.ts:21-59；artifact-service.ts:109-112 |
| 4. 触发链 | 仅 Web：useArtifactStore.rollback → POST /api/artifacts/[id]/rollback → service.rollback；CLI 无独立入口 | useArtifactStore.ts:255；route.ts:9-25 |
| 5. EXTERNAL_MODIFIED | 仅写盘前（submit/rollback），内容全文比对（非哈希非 mtime），不一致抛 409；文件不存在放行 | artifact-service.ts:130-144, 291, 339 |
| 6. Web→CLI 通知 | 无任何事件/广播/watch 机制；共享文件存储 + 前端自 refresh（D-D5-2 选 A 明确无 SSE） | useArtifactStore.ts:24-25 |
| 7. 确认落盘 | resolveAndMaterialize 全决后 submitVersion 出新版并删 pending；无独立审计日志，靠版本 note 追溯 | pending-change-service.ts:360-382 |
