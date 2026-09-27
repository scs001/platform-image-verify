// Resource library REST clients (openspec: add-resource-library 6.2).
//
// List / save / rename / delete over the shared transport. Chart payloads ride
// the list response (they are small, and a second request per card would make
// the page chatty), so `chartOption` is a pure parse helper, not a fetch.

import { fileRefPath, type FileRef } from "../lib/file-ref";
import { http } from "./http";

export interface Resource {
  id: string;
  /** "chart" | "file" today; the store is typed and extensible. */
  type: string;
  title: string;
  source: "auto" | "manual";
  /** Soft provenance — the session may be gone; sessionTitle is the snapshot. */
  sessionId: string | null;
  sessionTitle: string | null;
  messageId: number | null;
  /** chart: the normalized ECharts option JSON, as a string. */
  payload: string | null;
  /** file: path relative to the resources root the serving route resolves. */
  filePath: string | null;
  fileSize: number | null;
  fileMime: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  /** 1 when the row came from the one-time history seeding pass. */
  seeded: number;
}

export interface ResourceList {
  items: Resource[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResourceListQuery {
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// A refused library call. `status` is the HTTP status — the mini program uses
// 404 to mean "this cell predates the library" and hides the entry instead of
// showing an error (openspec: resource-library-ui, version skew).
export class ResourceApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ResourceApiError";
    this.status = status;
  }
}

// A refused save. `code` is the stable machine-readable reason
// (invalid_path / file_not_found / file_too_large / db_unavailable /
// store_failed); clients map it to a LOCALIZED message and fall back to
// `message` (the server's own text) for codes they do not know.
export class ResourceSaveError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResourceSaveError";
    this.code = code;
  }
}

async function jsonOrThrow<T>(resPromise: ReturnType<typeof http>): Promise<T> {
  const res = await resPromise;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string } | null;
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ResourceApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export async function listResources(query: ResourceListQuery = {}): Promise<ResourceList> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.q) params.set("q", query.q);
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.offset != null) params.set("offset", String(query.offset));
  const qs = params.toString();
  return jsonOrThrow<ResourceList>(http(`/api/resources${qs ? `?${qs}` : ""}`));
}

// Save a workspace file. `inserted: false` is a success that means "the same
// content is already in the library" — the caller says so rather than showing
// an error. Failures throw a ResourceSaveError carrying the server's `code`.
export async function saveResource(input: {
  path: string;
  sessionId?: string | null;
  messageId?: number | null;
}): Promise<{ inserted: boolean; resource: Resource }> {
  const res = await http("/api/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: input.path,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
    }),
  });
  if (!res.ok) {
    let code = "save_failed";
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; code?: string } | null;
      if (j?.code) code = j.code;
      if (j?.error) message = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ResourceSaveError(code, message);
  }
  return (await res.json()) as { inserted: boolean; resource: Resource };
}

export async function renameResource(id: string, title: string): Promise<Resource> {
  const j = await jsonOrThrow<{ resource: Resource }>(
    http(`/api/resources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
  return j.resource;
}

export async function deleteResource(id: string): Promise<void> {
  const res = await http(`/api/resources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** i18n key suffix for a refused save, or null when the code is unknown. */
export function saveErrorKey(err: unknown): string | null {
  if (!(err instanceof ResourceSaveError)) return null;
  const known = ["invalid_path", "file_not_found", "file_too_large", "db_unavailable", "store_failed"];
  return known.includes(err.code) ? err.code : null;
}

/** The preview/serving reference of a file resource, or null for other types. */
export function resourceFileRef(resource: Resource): FileRef | null {
  if (!resource.filePath) return null;
  return { root: "resources", rel: resource.filePath };
}

/** The route path serving a file resource (`/api/files?...`), or null. */
export function resourceFileUrl(resource: Resource): string | null {
  const ref = resourceFileRef(resource);
  return ref ? fileRefPath(ref) : null;
}

/** The chart option of a chart resource, or null when malformed. */
export function chartOption(resource: Resource): Record<string, unknown> | null {
  if (!resource.payload) return null;
  try {
    const parsed = JSON.parse(resource.payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Human-readable size for file cards. */
export function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}