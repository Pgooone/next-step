import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEXTSTEP_DIR_NAME } from "../config/paths";
import { ProjectError, ProjectRegistry, defaultRegistryPath } from "./project-registry";

let dir: string;
let registry: ProjectRegistry;
let registryPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ns-proj-"));
  registryPath = join(dir, "projects.json");
  registry = new ProjectRegistry(registryPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** try 调用、catch 断言抛出的是 ProjectError 且 code 匹配；未抛出则 fail。 */
function expectCode(fn: () => unknown, code: "NOT_FOUND" | "INVALID"): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe(code);
    return;
  }
  expect.fail(`期望抛出 ProjectError(${code})，但没有抛出异常`);
}

describe("ProjectRegistry（旧仓行为回归）", () => {
  it("文件不存在时 list() 返回 [] 且不创建文件", () => {
    expect(registry.list()).toEqual([]);
    expect(existsSync(registryPath)).toBe(false);
  });

  it("create() 返回合法项目并落盘", () => {
    const project = registry.create({ name: "demo", root: dir });
    expect(project.id).toHaveLength(36);
    expect(project.name).toBe("demo");
    expect(project.root).toBe(dir);
    expect(Number.isNaN(Date.parse(project.createdAt))).toBe(false);
    expect(new Date(project.createdAt).toISOString()).toBe(project.createdAt);

    expect(existsSync(registryPath)).toBe(true);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(project);
  });

  it("create() 空/空白 name 抛 INVALID", () => {
    expectCode(() => registry.create({ name: "", root: dir }), "INVALID");
    expectCode(() => registry.create({ name: "   ", root: dir }), "INVALID");
  });

  it("create() root 不存在抛 INVALID", () => {
    expectCode(() => registry.create({ name: "demo", root: join(dir, "nope") }), "INVALID");
  });

  it("create() 不存在路径 + createIfMissing:true 自动建目录并放行", () => {
    const newRoot = join(dir, "auto", "created");
    const project = registry.create({ name: "demo", root: newRoot, createIfMissing: true });
    expect(existsSync(newRoot)).toBe(true);
    expect(project.root).toBe(newRoot);
  });

  it("create() 不存在路径 + 不传 createIfMissing 维持 INVALID（不触盘）", () => {
    const newRoot = join(dir, "still-nope");
    expectCode(() => registry.create({ name: "demo", root: newRoot }), "INVALID");
    expect(existsSync(newRoot)).toBe(false);
  });

  it("update({root:不存在, createIfMissing:true}) 建目录并改 root", () => {
    const a = registry.create({ name: "demo", root: dir });
    const newRoot = join(dir, "moved", "here");
    const updated = registry.update(a.id, { root: newRoot, createIfMissing: true });
    expect(existsSync(newRoot)).toBe(true);
    expect(updated.root).toBe(newRoot);
    expect(registry.get(a.id).root).toBe(newRoot);
  });

  it("createIfMissing 遇 ENOTDIR（父级是文件）转 422 友好报错而非裸 fs error", () => {
    // 父级路径段是一个文件 → mkdir 子目录会抛 ENOTDIR
    const fileParent = join(dir, "a-file");
    writeFileSync(fileParent, "x", "utf-8");
    const badRoot = join(fileParent, "child");
    expectCode(() => registry.create({ name: "demo", root: badRoot, createIfMissing: true }), "INVALID");
  });

  // POSIX-only:chmod 0o500 在 Windows/NTFS 上不等于 POSIX 权限位(目录无写位概念),
  // mkdir 子目录不触发 EACCES → 本用例在 win32 跳过(Linux/CI 仍覆盖)。
  it.skipIf(process.platform === "win32")(
    "createIfMissing 遇 EACCES（父目录无写权限）转 422 友好报错而非裸 fs error",
    () => {
      // chmod 0500 父目录后 mkdir 子目录 → uid 非 root 触发 EACCES
      const ro = join(dir, "readonly");
      mkdirSync(ro);
      chmodSync(ro, 0o500);
      try {
        const badRoot = join(ro, "child");
        expectCode(() => registry.create({ name: "demo", root: badRoot, createIfMissing: true }), "INVALID");
      } finally {
        // 复原权限，否则 afterEach rmSync 清理失败污染后续用例
        chmodSync(ro, 0o700);
      }
    },
  );

  it("create() 重名抛 INVALID", () => {
    registry.create({ name: "demo", root: dir });
    expectCode(() => registry.create({ name: "demo", root: dir }), "INVALID");
  });

  it("get() 命中返回；未知 id 抛 NOT_FOUND", () => {
    const project = registry.create({ name: "demo", root: dir });
    expect(registry.get(project.id)).toEqual(project);
    expectCode(() => registry.get("unknown-id"), "NOT_FOUND");
  });

  it("update() 改名生效并持久化；未知 id 抛 NOT_FOUND；改成已存在的名字抛 INVALID", () => {
    const a = registry.create({ name: "alpha", root: dir });
    registry.create({ name: "beta", root: dir });

    const updated = registry.update(a.id, { name: "alpha2" });
    expect(updated.name).toBe("alpha2");
    expect(registry.get(a.id).name).toBe("alpha2");

    expectCode(() => registry.update("unknown-id", { name: "x" }), "NOT_FOUND");
    expectCode(() => registry.update(a.id, { name: "beta" }), "INVALID");
  });

  it("remove() 后 list() 为空，但磁盘 root 目录仍存在；再次 remove 抛 NOT_FOUND", () => {
    const project = registry.create({ name: "demo", root: dir });
    registry.remove(project.id);

    expect(registry.list()).toEqual([]);
    // 关键 AC：删项目只移注册项，绝不删磁盘目录
    expect(existsSync(dir)).toBe(true);

    expectCode(() => registry.remove(project.id), "NOT_FOUND");
  });

  it("list() 遇损坏内容抛 INVALID", () => {
    writeFileSync(registryPath, "{ bad json", "utf-8");
    expectCode(() => registry.list(), "INVALID");
  });
});

describe("ProjectRegistry（旧仓目录名适配）", () => {
  it("defaultRegistryPath() 随用户级目录常量（~/.nextstep/projects.json）", () => {
    expect(defaultRegistryPath()).toBe(join(homedir(), NEXTSTEP_DIR_NAME, "projects.json"));
  });
});
