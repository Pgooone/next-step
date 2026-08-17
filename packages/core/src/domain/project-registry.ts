import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NEXTSTEP_DIR_NAME } from "../config/paths";

/** 一个项目 = 一个工作区 = 一个 cwd。权威类型见 docs/03-data-model。 */
export type Project = {
  id: string; // uuid
  name: string;
  root: string; // 绝对路径，= cwd
  createdAt: string; // ISO-8601
};

/** 领域错误：code 由 API 层映射为 HTTP 状态（NOT_FOUND→404 / INVALID→422）。 */
export class ProjectError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

/** 默认注册表位置：~/.nextstep/projects.json（随用户级目录常量，脱离旧仓数据目录）。 */
export function defaultRegistryPath(): string {
  return join(homedir(), NEXTSTEP_DIR_NAME, "projects.json");
}

/** 把用户输入的 root 归一化为绝对路径（展开 ~，相对路径按 cwd resolve）。 */
export function normalizeRoot(input: string): string {
  const s = input.trim();
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return resolve(homedir(), s.slice(2));
  return isAbsolute(s) ? s : resolve(s);
}

/**
 * 项目注册表：纯文件存储（JSON 数组），单进程单用户。
 * 所有写操作走「临时文件 + rename」原子落盘，避免崩溃时损坏注册表。
 */
export class ProjectRegistry {
  constructor(private readonly filePath: string = defaultRegistryPath()) {}

  list(): Project[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8").trim();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProjectError("INVALID", `projects.json 解析失败: ${this.filePath}`);
    }
    if (!Array.isArray(parsed)) {
      throw new ProjectError("INVALID", "projects.json 顶层应为数组");
    }
    return parsed as Project[];
  }

  get(id: string): Project {
    const found = this.list().find((p) => p.id === id);
    if (!found) throw new ProjectError("NOT_FOUND", `项目不存在: ${id}`);
    return found;
  }

  create(input: { name: string; root: string; createIfMissing?: boolean }): Project {
    const name = (input.name ?? "").trim();
    if (!name) throw new ProjectError("INVALID", "name 不能为空");

    const root = this.validateRoot(input.root, input.createIfMissing);

    const projects = this.list();
    if (projects.some((p) => p.name === name)) {
      throw new ProjectError("INVALID", `项目重名: ${name}`);
    }

    const project: Project = {
      id: randomUUID(),
      name,
      root,
      createdAt: new Date().toISOString(),
    };
    this.writeAll([...projects, project]);
    return project;
  }

  update(id: string, patch: { name?: string; root?: string; createIfMissing?: boolean }): Project {
    const projects = this.list();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) throw new ProjectError("NOT_FOUND", `项目不存在: ${id}`);

    const next: Project = { ...projects[idx] };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProjectError("INVALID", "name 不能为空");
      if (projects.some((p) => p.id !== id && p.name === name)) {
        throw new ProjectError("INVALID", `项目重名: ${name}`);
      }
      next.name = name;
    }
    if (patch.root !== undefined) {
      next.root = this.validateRoot(patch.root, patch.createIfMissing);
    }

    projects[idx] = next;
    this.writeAll(projects);
    return next;
  }

  /** 仅移除注册项，绝不删除磁盘上的项目文件（AC：删除项目仅移除注册项）。 */
  remove(id: string): void {
    const projects = this.list();
    if (!projects.some((p) => p.id === id)) {
      throw new ProjectError("NOT_FOUND", `项目不存在: ${id}`);
    }
    this.writeAll(projects.filter((p) => p.id !== id));
  }

  private validateRoot(rootRaw: string, createIfMissing = false): string {
    const trimmed = (rootRaw ?? "").trim();
    if (!trimmed) throw new ProjectError("INVALID", "root 不能为空");
    const root = normalizeRoot(trimmed);
    let stat;
    try {
      stat = statSync(root);
    } catch {
      // 仅当用户显式勾选「不存在则自动创建」时才建目录（默认不触盘，守「删项目不删盘」契约）。
      if (!createIfMissing) {
        throw new ProjectError("INVALID", `root 路径不存在: ${root}`);
      }
      // mkdir 的 fs error（ENOTDIR/EACCES/ENOENT 等）必须转 ProjectError → 422，
      // 否则裸 ErrnoException 经 errors.ts 的 STATUS_BY_CODE 映射会落 500、泄 raw 路径/errno。
      try {
        mkdirSync(root, { recursive: true });
      } catch (e) {
        throw new ProjectError("INVALID", `无法创建目录: ${root}（${(e as NodeJS.ErrnoException).code}）`);
      }
      // 建好后再 statSync 复查 isDirectory()，防 TOCTOU（建成功但被替换/竞态变成非目录）。
      try {
        stat = statSync(root);
      } catch {
        throw new ProjectError("INVALID", `root 路径不存在: ${root}`);
      }
    }
    if (!stat.isDirectory()) {
      throw new ProjectError("INVALID", `root 不是目录: ${root}`);
    }
    return root;
  }

  private writeAll(projects: Project[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(projects, null, 2)}\n`, "utf-8");
    renameSync(tmp, this.filePath);
  }
}
