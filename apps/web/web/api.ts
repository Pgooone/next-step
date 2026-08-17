/**
 * server 端点封装（T1-12）：面板只通过本模块 fetch T1-11 薄 server——组件树零 L1 调用。
 * 错误映射（404/409/422）透传 code + message，由面板呈现。
 */
import type {
  ArtifactDetail,
  AuditReplayResp,
  ExternalDiffResp,
  PendingResp,
  ResolveResp,
  RollbackResp,
} from "./types";

export type ArtifactsResp = {
  projects: { id: string; name: string; root: string }[];
  artifacts: { id: string; title: string; currentVersion: number }[];
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? "INTERNAL", data.message ?? `请求失败 ${res.status}`);
  }
  return data;
}

export const api = {
  listArtifacts: (projectId?: string) =>
    request<ArtifactsResp>("GET", `/api/artifacts${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),

  getArtifact: (artifactId: string) => request<ArtifactDetail>("GET", `/api/artifacts/${artifactId}`),

  getPending: (artifactId: string) => request<PendingResp>("GET", `/api/artifacts/${artifactId}/pending`),

  resolve: (artifactId: string, changeId: string, body: { blockId?: string; action: "accept" | "reject" }) =>
    request<ResolveResp>("POST", `/api/artifacts/${artifactId}/pending/${changeId}/resolve`, body),

  discard: (artifactId: string, changeId: string, reason?: string) =>
    request<{ discarded: boolean }>("POST", `/api/artifacts/${artifactId}/pending/${changeId}/discard`, { reason }),

  rollback: (artifactId: string, version: number) =>
    request<RollbackResp>("POST", `/api/artifacts/${artifactId}/rollback`, { version }),

  undoRollback: (artifactId: string, version: number) =>
    request<RollbackResp>("POST", `/api/artifacts/${artifactId}/rollback/undo`, { version }),

  externalDiff: (artifactId: string) => request<ExternalDiffResp>("GET", `/api/artifacts/${artifactId}/external/diff`),

  externalMerge: (artifactId: string) =>
    request<{ status: string }>("POST", `/api/artifacts/${artifactId}/external/merge`),

  externalReject: (artifactId: string) =>
    request<{ artifact: unknown }>("POST", `/api/artifacts/${artifactId}/external/reject`),

  auditReplay: (artifactId?: string) =>
    request<AuditReplayResp>("GET", `/api/audit/replay${artifactId ? `?artifactId=${encodeURIComponent(artifactId)}` : ""}`),
};
