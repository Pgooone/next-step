import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { NEXTSTEP_DIR_NAME } from "../config/paths";
import { buildArtifactFileName } from "./file-name";
import { ProjectRegistry } from "./project-registry";

/**
 * 一份受管 artifact 的元数据。权威类型见 docs/03。
 * currentVersion = 最高版号（= 当前内容所在版本）；version = 乐观锁计数。
 * 两者每次新版同步 +1，但语义不同：前者标识内容版本、后者只用于 If-Match 冲突检测。
 */
export type Artifact = {
  id: string; // uuid
  projectId: string;
  kind: string;
  title: string;
  currentVersion: number; // 最高版号
  version: number; // 乐观锁计数
  status: "draft" | "finalized";
  /**
   * 物化真实文件相对 projectRoot 的路径（如 `需求规格.md`，V2-1）。create 时由 title 清洗生成、
   * 落进 artifact.json，submitVersion/rollback 以此为准物化（不随 title 改而漂移）。
   * 可选：兼容 V2 之前未物化的旧 artifact.json（无该字段时按「不物化」处理）。
   */
  filePath?: string;
  extra?: Record<string, unknown>;
};

/** 一个 artifact 版本快照。unique(artifactId, version) 由「版本号即文件名」天然保证。 */
export type ArtifactVersion = {
  id: string; // uuid
  artifactId: string;
  version: number;
  content: string;
  author: string;
  note?: string;
  createdAt: string; // ISO-8601
};

/**
 * 领域错误：code 由 API 层映射为 HTTP 状态
 * （NOT_FOUND→404 / INVALID→422 / VERSION_CONFLICT→409 / EXTERNAL_MODIFIED→409）。
 * EXTERNAL_MODIFIED（D-V2-06）：物化前发现真实文件已被外部手改，拒绝静默覆盖。
 */
export class ArtifactError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID" | "VERSION_CONFLICT" | "EXTERNAL_MODIFIED",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

/** createArtifact 的可写入参（白名单；id/version/status 等由存储填）。 */
type CreateArtifactInput = {
  kind: string;
  title: string;
  content: string;
  author?: string;
  extra?: Record<string, unknown>;
};

/**
 * 受管 artifact 存储：随项目落盘到 `<projectRoot>/.nextstep/artifacts/managed/<id>/`，与 Iter C 的
 * 派发产物（`<projectRoot>/.nextstep/artifacts/<dispatchId>/<seq>.md`）在同根下物理隔离（D-D1-1 选 B）。
 *
 * 目录布局：
 *   managed/<id>/artifact.json        — Artifact 元数据（含 currentVersion + version）
 *   managed/<id>/versions/<n>.json    — 第 n 版 ArtifactVersion；写新版 = 写新文件名、永不覆盖旧版
 * 当前内容 = 读 versions/<currentVersion>.json；unique(artifactId,version) 由文件名天然保证。
 *
 * 仿 dispatch-store / agent-profile-store 的「临时文件 + rename」原子写，单进程单用户、无 DB。
 * projectRoot 经注入的 ProjectRegistry 反查（project 不存在时 registry 抛 ProjectError NOT_FOUND）。
 */
export class ArtifactService {
  constructor(private readonly registry: ProjectRegistry = new ProjectRegistry()) {}

  /** `<projectRoot>/.nextstep/artifacts/managed`；registry.get 在 project 不存在时抛 ProjectError NOT_FOUND。 */
  private managedDir(projectId: string): string {
    return join(this.registry.get(projectId).root, NEXTSTEP_DIR_NAME, "artifacts", "managed");
  }

  private artifactDir(projectId: string, id: string): string {
    return join(this.managedDir(projectId), id);
  }

  private metaPath(projectId: string, id: string): string {
    return join(this.artifactDir(projectId, id), "artifact.json");
  }

  private versionsDir(projectId: string, id: string): string {
    return join(this.artifactDir(projectId, id), "versions");
  }

  private versionPath(projectId: string, id: string, version: number): string {
    return join(this.versionsDir(projectId, id), `${version}.json`);
  }

  /** 物化真实文件的绝对路径（= projectRoot 拼 artifact.filePath）。无 filePath 返回 undefined。 */
  private materializedPath(projectId: string, artifact: Artifact): string | undefined {
    if (!artifact.filePath) return undefined;
    return join(this.registry.get(projectId).root, artifact.filePath);
  }

  /** 把 content 物化到 artifact 的真实文件（原子写，仿 atomicWrite）。无 filePath（旧 artifact）→ 跳过。 */
  private materialize(projectId: string, artifact: Artifact, content: string): void {
    const abs = this.materializedPath(projectId, artifact);
    if (!abs) return;
    this.atomicWrite(abs, content);
  }

  /**
   * 外部编辑保护（D-V2-06）：物化覆盖前，断言真实文件未被外部手改。
   * `expectedPriorContent` = 本次覆盖前「上一当前版」的 content（= 我们上次物化写下的内容）；
   * 读真实文件现状与之比对，**不一致说明被外部改过** → 抛 EXTERNAL_MODIFIED 拒绝（防 AI 确认静默覆盖丢失）。
   * 真实文件不存在（被外部删/尚未物化）视为「无外部改动」，放行。无 filePath 的旧 artifact 也放行。
   *
   * 刻意与 {@link materialize} 分离、在写任何新版本/元数据**之前**调用：一旦判定外部改动则整次
   * submit/rollback 干净失败，不留「版本已加但真实文件没更新」的半截状态。
   */
  private assertNotExternallyModified(
    projectId: string,
    artifact: Artifact,
    expectedPriorContent: string,
  ): void {
    const abs = this.materializedPath(projectId, artifact);
    if (!abs || !existsSync(abs)) return;
    const onDisk = readFileSync(abs, "utf-8");
    if (onDisk !== expectedPriorContent) {
      throw new ArtifactError(
        "EXTERNAL_MODIFIED",
        `真实文件已被外部修改，拒绝覆盖以防丢失：${artifact.filePath}（请先同步）`,
      );
    }
  }

  /**
   * 建 artifact：校验 kind/title 非空，写 `managed/<uuid>/artifact.json`
   * （currentVersion=1, version=1, status='draft'）+ `versions/1.json`。返回新建 Artifact。
   */
  createArtifact(projectId: string, input: CreateArtifactInput): Artifact {
    const kind = (input.kind ?? "").trim();
    if (!kind) throw new ArtifactError("INVALID", "kind 不能为空");
    const title = (input.title ?? "").trim();
    if (!title) throw new ArtifactError("INVALID", "title 不能为空");

    const id = randomUUID();
    // 物化文件名由 title 清洗生成、与项目根已有 .md 避让（V2-1 取舍2：物化到项目根）。
    const projectRoot = this.registry.get(projectId).root;
    const filePath = buildArtifactFileName(title, projectRoot);
    const artifact: Artifact = {
      id,
      projectId,
      kind,
      title,
      currentVersion: 1,
      version: 1,
      status: "draft",
      filePath,
      ...(input.extra !== undefined ? { extra: input.extra } : {}),
    };

    const content = input.content ?? "";
    const version: ArtifactVersion = {
      id: randomUUID(),
      artifactId: id,
      version: 1,
      content,
      author: input.author ?? "user",
      createdAt: new Date().toISOString(),
    };

    mkdirSync(this.versionsDir(projectId, id), { recursive: true });
    this.atomicWrite(this.versionPath(projectId, id, 1), `${JSON.stringify(version, null, 2)}\n`);
    this.atomicWrite(this.metaPath(projectId, id), `${JSON.stringify(artifact, null, 2)}\n`);
    // 首版无上一版 → 不比对、直接物化真实文件（V2-1）。
    this.materialize(projectId, artifact, content);
    return artifact;
  }

  /**
   * 彻底删除受管 artifact：删侧车目录（meta + versions + pending）+ 物化 .md（容错）。
   * 不存在 → NOT_FOUND；ifMatch 不符 → VERSION_CONFLICT(409)。
   * 结构操作、与 createArtifact 对称、不走 propose→按块确认（D-V4-02）。
   */
  deleteArtifact(projectId: string, id: string, input?: { ifMatch?: number }): void {
    const artifact = this.readMeta(projectId, id); // NOT_FOUND
    this.assertVersionMatch(artifact.version, input?.ifMatch); // VERSION_CONFLICT
    const matPath = this.materializedPath(projectId, artifact);
    if (matPath) {
      // best-effort：.md 缺失 / 被外部删 → 静默跳过，不阻断侧车删除（D-V4-03）
      try { rmSync(matPath, { force: true }); } catch { /* ignore */ }
    }
    rmSync(this.artifactDir(projectId, id), { recursive: true, force: true });
  }

  /**
   * 列该项目下所有受管 artifact 的元数据（扫 `managed/<id>/artifact.json`，不含 content）。
   * 供极简打开入口列出可渲染的 artifact。managed 目录不存在（项目尚无 artifact）→ 空数组。
   * 解析失败的条目跳过（不因单个坏文件让整列表失败）。按 title 升序便于稳定展示。
   */
  listArtifacts(projectId: string): Artifact[] {
    const dir = this.managedDir(projectId); // registry.get 在 project 不存在时抛 NOT_FOUND
    if (!existsSync(dir)) return [];
    const artifacts: Artifact[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(dir, entry.name, "artifact.json");
      if (!existsSync(metaPath)) continue;
      try {
        artifacts.push(JSON.parse(readFileSync(metaPath, "utf-8")) as Artifact);
      } catch {
        // 跳过坏掉的 artifact.json，不让单个解析失败拖垮整列表
      }
    }
    artifacts.sort((a, b) => a.title.localeCompare(b.title));
    return artifacts;
  }

  /** 读 artifact.json + 当前版本内容合并返回；artifact 不存在抛 NOT_FOUND。 */
  getArtifact(projectId: string, id: string): Artifact & { content: string } {
    const artifact = this.readMeta(projectId, id);
    const content = this.readVersionContent(projectId, id, artifact.currentVersion);
    return { ...artifact, content };
  }

  /** 取当前版内容（= versions/<currentVersion>.json 的 content）。 */
  readCurrentContent(projectId: string, id: string): string {
    const artifact = this.readMeta(projectId, id);
    return this.readVersionContent(projectId, id, artifact.currentVersion);
  }

  /**
   * 取某个版本的完整快照（content + version + meta）。供版本下拉「查看任意历史版本」（D5 §5.6 AC③）。
   * artifact 不存在抛 NOT_FOUND；目标版本文件不存在抛 NOT_FOUND（公开方法故按「资源不存在」语义，
   * 区别于 readVersionContent 的 INVALID——后者是「当前版文件缺失」的内部一致性错误）。
   */
  getVersion(projectId: string, id: string, version: number): ArtifactVersion {
    this.readMeta(projectId, id); // artifact 不存在则抛 NOT_FOUND
    const path = this.versionPath(projectId, id, version);
    if (!existsSync(path)) {
      throw new ArtifactError("NOT_FOUND", `版本不存在: v${version}`);
    }
    return this.readVersion(path);
  }

  /** 列 versions/*.json，按 version 升序。artifact 不存在抛 NOT_FOUND。 */
  listVersions(projectId: string, id: string): ArtifactVersion[] {
    this.readMeta(projectId, id); // 不存在则抛 NOT_FOUND
    const dir = this.versionsDir(projectId, id);
    if (!existsSync(dir)) return [];
    const versions: ArtifactVersion[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      versions.push(this.readVersion(join(dir, entry.name)));
    }
    versions.sort((a, b) => a.version - b.version);
    return versions;
  }

  /**
   * 提交新版：乐观锁校验（assertVersionMatch）→ 写 `versions/<currentVersion+1>.json`
   * → currentVersion+1、version+1 落盘。返回更新后 Artifact。
   *
   * 乐观锁原子写（D-D1-3）：read-modify-write——先读 version、写盘前 assertVersionMatch、
   * 再写新版（新文件名永不撞旧版）+ tmp/rename 覆写 artifact.json。
   * 单进程单用户不加文件锁；「读 version → 写盘」间有 TOCTOU 窗口，串行单用户可容忍（同 D-C1-1）。
   */
  submitVersion(
    projectId: string,
    id: string,
    input: { content: string; author?: string; note?: string; ifMatch?: number },
  ): Artifact {
    const current = this.readMeta(projectId, id);
    this.assertVersionMatch(current.version, input.ifMatch);
    if (input.content === undefined || input.content === null) {
      throw new ArtifactError("INVALID", "content 不能为空");
    }

    // 外部编辑保护（D-V2-06）：写新版前先确认真实文件未被外部改（与「上一当前版」content 比对）。
    const priorContent = this.readVersionContent(projectId, id, current.currentVersion);
    this.assertNotExternallyModified(projectId, current, priorContent);

    const nextVersion = current.currentVersion + 1;
    const version: ArtifactVersion = {
      id: randomUUID(),
      artifactId: id,
      version: nextVersion,
      content: input.content,
      author: input.author ?? "user",
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: new Date().toISOString(),
    };
    this.atomicWrite(
      this.versionPath(projectId, id, nextVersion),
      `${JSON.stringify(version, null, 2)}\n`,
    );

    const next: Artifact = {
      ...current,
      currentVersion: nextVersion,
      version: current.version + 1,
    };
    this.atomicWrite(this.metaPath(projectId, id), `${JSON.stringify(next, null, 2)}\n`);
    // 新版落盘后物化真实文件（= 当前版）。
    this.materialize(projectId, next, input.content);
    return next;
  }

  /**
   * 回滚到目标版：乐观锁校验 → 校验目标版存在 → **复制目标版 content 成新版**
   * （currentVersion+1，note=`rollback to v{n}`），两计数同步 +1。返回更新后 Artifact。
   * 不删除任何旧版（回滚 = 追加新版）。目标版不存在抛 NOT_FOUND。
   */
  rollback(projectId: string, id: string, input: { version: number; ifMatch?: number }): Artifact {
    const current = this.readMeta(projectId, id);
    this.assertVersionMatch(current.version, input.ifMatch);

    if (typeof input.version !== "number" || !Number.isInteger(input.version)) {
      throw new ArtifactError("INVALID", `回滚目标版本号非法: ${input.version}`);
    }
    const targetPath = this.versionPath(projectId, id, input.version);
    if (!existsSync(targetPath)) {
      throw new ArtifactError("NOT_FOUND", `回滚目标版本不存在: v${input.version}`);
    }
    const target = this.readVersion(targetPath);

    // 外部编辑保护（D-V2-06）：写回退版前先确认真实文件未被外部改（与「上一当前版」content 比对）。
    const priorContent = this.readVersionContent(projectId, id, current.currentVersion);
    this.assertNotExternallyModified(projectId, current, priorContent);

    const nextVersion = current.currentVersion + 1;
    const version: ArtifactVersion = {
      id: randomUUID(),
      artifactId: id,
      version: nextVersion,
      content: target.content,
      author: "user",
      note: `rollback to v${input.version}`,
      createdAt: new Date().toISOString(),
    };
    this.atomicWrite(
      this.versionPath(projectId, id, nextVersion),
      `${JSON.stringify(version, null, 2)}\n`,
    );

    const next: Artifact = {
      ...current,
      currentVersion: nextVersion,
      version: current.version + 1,
    };
    this.atomicWrite(this.metaPath(projectId, id), `${JSON.stringify(next, null, 2)}\n`);
    // 回退版落盘后物化真实文件（= 回退到的内容）。
    this.materialize(projectId, next, target.content);
    return next;
  }

  /**
   * 仅凭 artifactId 跨项目定位（契约 `GET /api/artifacts/[id]` 路径无 projectId，
   * 而 artifact 随项目落盘，故扫描 registry 所有项目的 `.nextstep/artifacts/managed/<id>/`）。
   * 仿 dispatch-store.findTask；只扫 `managed/` 子目录，**不会误命中 Iter C 的 `<dispatchId>/`**。
   * 命中即返回，找不到抛 NOT_FOUND。
   */
  findArtifact(id: string): { projectId: string; artifact: Artifact } {
    for (const project of this.registry.list()) {
      const metaPath = join(project.root, NEXTSTEP_DIR_NAME, "artifacts", "managed", id, "artifact.json");
      if (existsSync(metaPath)) {
        return { projectId: project.id, artifact: this.readMeta(project.id, id) };
      }
    }
    throw new ArtifactError("NOT_FOUND", `artifact 不存在: ${id}`);
  }

  private readMeta(projectId: string, id: string): Artifact {
    const path = this.metaPath(projectId, id);
    if (!existsSync(path)) {
      throw new ArtifactError("NOT_FOUND", `artifact 不存在: ${id}`);
    }
    const raw = readFileSync(path, "utf-8");
    try {
      return JSON.parse(raw) as Artifact;
    } catch {
      throw new ArtifactError("INVALID", `artifact.json 解析失败: ${path}`);
    }
  }

  private readVersion(path: string): ArtifactVersion {
    const raw = readFileSync(path, "utf-8");
    try {
      return JSON.parse(raw) as ArtifactVersion;
    } catch {
      throw new ArtifactError("INVALID", `artifact version 解析失败: ${path}`);
    }
  }

  private readVersionContent(projectId: string, id: string, version: number): string {
    const path = this.versionPath(projectId, id, version);
    if (!existsSync(path)) {
      throw new ArtifactError("INVALID", `当前版本文件缺失: v${version}`);
    }
    return this.readVersion(path).content;
  }

  /** 移植 sf-mini check_version（_common.py:28-30）：ifMatch 非空且不等当前 version → 冲突。 */
  private assertVersionMatch(current: number, ifMatch?: number): void {
    if (ifMatch != null && ifMatch !== current) {
      throw new ArtifactError(
        "VERSION_CONFLICT",
        `版本冲突：期望 version=${current}，收到 If-Match=${ifMatch}`,
      );
    }
  }

  /** 「临时文件 + rename」原子落盘（仿 dispatch-store / agent-profile-store.atomicWrite）。 */
  private atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  }
}
