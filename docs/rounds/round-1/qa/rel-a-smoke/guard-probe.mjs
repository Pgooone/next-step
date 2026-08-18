/**
 * 发行轨 A 入口装配探针：用 pi 同款 jiti 加载 src/extension-entry.ts（不经 pi CLI），
 * mock ExtensionAPI 收集 registerTool / tool_call 挂载，再走真实存储（FAKE_HOME 注册表 +
 * cwd 项目）验证受管路径守卫行为——「入口装配了六工具 + 守卫」的运行时证据。
 *
 * 跑法：cd /tmp/rel-a-smoke && HOME=/tmp/rel-a-smoke-home node guard-probe.mjs
 * 注意：探针必须先于 tui-smoke.sh 或在其后单独跑（它会在注册表留 cwd 项目——入口装配本就是幂等的按 root 复用）。
 */
import assert from "node:assert";
import { createJiti } from "/home/pgoone/GitHubproject/nextstep重构/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PKG = "/home/pgoone/GitHubproject/nextstep重构/packages/next-step-pi/src";
const jiti = createJiti(import.meta.url);

// ---- 加载入口（jiti 直跑 TS，与 pi 扩展加载器同解析） ----
const { default: factory } = await jiti.import(`${PKG}/extension-entry.ts`);
const registered = [];
let guard = undefined;
const pi = {
  registerTool: (t) => registered.push(t.name),
  on: (event, handler) => {
    if (event === "tool_call") guard = handler;
  },
  appendEntry: () => {},
};
factory(pi);

// ---- 断言 1：六工具注册 + tool_call 守卫挂载 ----
assert.deepStrictEqual(registered, [
  "create_artifact",
  "propose_edit",
  "list_artifacts",
  "get_artifact_diff",
  "list_my_artifacts",
  "get_artifact_history",
]);
assert.ok(typeof guard === "function", "tool_call 守卫应挂载");

// ---- 断言 2：真实存储下守卫行为（入口装配的项目 + 真实物化文件） ----
const { ProjectRegistry } = await jiti.import(`${PKG}/domain/domain/project-registry.ts`);
const { ArtifactService } = await jiti.import(`${PKG}/domain/domain/artifact-service.ts`);
const registry = new ProjectRegistry();
const project = registry.list().find((p) => p.root === process.cwd());
assert.ok(project, "入口装配的 cwd 项目应已注册");
const svc = new ArtifactService(registry);
const artifact = svc.createArtifact(project.id, {
  kind: "design",
  title: "guard探针",
  content: "探针正文",
  author: "guard-probe",
});
const abs = svc.materializedAbsPath(project.id, artifact.id);
assert.ok(abs, "物化文件路径应存在");

assert.deepStrictEqual(guard({ toolName: "write", input: { path: abs } }), {
  block: true,
  reason: "受管文档禁止直写，请用 propose_edit",
});
assert.deepStrictEqual(guard({ toolName: "edit", input: { path: abs } }), {
  block: true,
  reason: "受管文档禁止直写，请用 propose_edit",
});
assert.deepStrictEqual(guard({ toolName: "read", input: { path: abs } }), {}, "读类工具放行");
assert.deepStrictEqual(
  guard({ toolName: "write", input: { path: "/tmp/rel-a-smoke/unmanaged.txt" } }),
  {},
  "非受管路径放行",
);

console.log(`GUARD-PROBE PASS: 六工具=[${registered.join(",")}] 守卫拦截/放行全部符合预期`);
