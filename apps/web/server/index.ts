import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { NEXTSTEP_DIR_NAME } from "@pgoone/next-step-pi/src/domain/config/paths.ts";
import { ProjectRegistry } from "@pgoone/next-step-pi/src/domain/domain/project-registry.ts";
import { ArtifactService } from "@pgoone/next-step-pi/src/domain/domain/artifact-service.ts";
import { PendingChangeStore } from "@pgoone/next-step-pi/src/domain/domain/pending-change-service.ts";
import { acquireWebPanelLock, WebPanelSessionManager } from "./web-panel-audit";
import { createWebServer } from "./create-server";

/**
 * L3 薄 server 生产入口（T1-11）：默认装配 + 监听。
 *
 * - 审计文件：`~/.nextstep/web-panel.jsonl`（P2-1 固定会话文件，唯一 writer = 本进程；
 *   启动时经 acquireWebPanelLock 做单 writer 独占检查，P3 单进程假设）。
 * - 端口：环境变量 PORT 覆盖，默认 8787（README 注记；前端面板 T1-12 接入时同端口）。
 * - 领域存储：默认 ProjectRegistry = `~/.nextstep/projects.json`（与 CLI 共用同一注册表，
 *   H5：面板项目下拉 = ProjectRegistry.list）。
 */
const dataDir = join(homedir(), NEXTSTEP_DIR_NAME);
const releaseLock = acquireWebPanelLock(dataDir);
process.on("exit", releaseLock);
// 信号退出不触发 exit 事件 → 显式转正常退出，保证锁释放（否则残留锁挡下次启动）
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

const registry = new ProjectRegistry();
const server = createWebServer({
  registry,
  artifactService: new ArtifactService(registry),
  pendingStore: new PendingChangeStore(registry),
  auditSessionManager: new WebPanelSessionManager(join(dataDir, "web-panel.jsonl")),
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  const actual = (server.address() as AddressInfo).port; // PORT=0（随机端口）时打实际值
  console.log(`[next-step-web] 薄 server 已启动: http://localhost:${actual}`);
  console.log(`[next-step-web] 审计文件: ${join(dataDir, "web-panel.jsonl")}（单 writer：仅本进程）`);
});
