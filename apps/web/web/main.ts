/**
 * 面板入口（T1-12）：项目/文档选择（H5 ProjectRegistry.list 下拉）→ 装配 DocPanel。
 * 静态页面 + fetch 直连 server，无 SSR 需求。
 */
import { api } from "./api";
import { DocPanel } from "./panel";

async function boot(): Promise<void> {
  const list = await api.listArtifacts();
  const project = list.projects[0];
  if (!project) {
    document.body.textContent = "暂无项目——请先经 CLI 创建项目与文档（seed: scripts/seed-demo.mjs）。";
    return;
  }
  const artifacts = await api.listArtifacts(project.id);
  if (artifacts.artifacts.length === 0) {
    document.body.textContent = "项目下暂无受管文档。";
    return;
  }
  // 首个文档直开（演示路径）；URL ?artifact= 可指定
  const wanted = new URLSearchParams(location.search).get("artifact");
  const artifact = artifacts.artifacts.find((a) => a.id === wanted) ?? artifacts.artifacts[0];

  const root = document.getElementById("panel")!;
  const panel = new DocPanel(root, artifact.id);
  await panel.load();
}

boot().catch((e) => {
  document.body.textContent = `面板启动失败：${String(e)}`;
});
