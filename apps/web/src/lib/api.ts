export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
}

export interface SessionResponse {
  user: SessionUser;
  session?: { id: string; authenticationMethod?: "access" | "cookie" | "bearer" };
  expiresAt?: string;
}

export interface PaperTag {
  id: string;
  name: string;
  color: string | null;
  paperCount?: number;
}

export interface CollectionRecord {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  paperCount?: number;
}

export interface PaperIdentifier {
  id: string;
  type?: "doi" | "arxiv" | "pmid" | "openalex" | "isbn" | "url";
  identifierType?: "doi" | "arxiv" | "pmid" | "openalex" | "isbn" | "url";
  normalizedValue: string;
  originalValue?: string;
}

export interface PaperFile {
  id: string;
  originalName: string;
  sizeBytes: number;
  mediaType: string;
  kind: "original_pdf" | "supplement";
  fileKind?: "fulltext" | "translation" | "bilingual" | "supplement" | "other";
  label?: string | null;
  languageCode?: string | null;
  isDefault?: boolean;
  sortOrder?: number;
  uploadState: "pending" | "uploaded" | "verified" | "failed";
  sha256?: string;
}

export interface PaperListItem {
  id: string;
  title: string;
  summary: string | null;
  authors: Array<{ id?: string; displayName: string }>;
  publicationYear: number | null;
  publicationDate: string | null;
  venue: string | null;
  status: "inbox" | "reading" | "read" | "archived";
  rating: number | null;
  tags: PaperTag[];
  collections?: Array<{ id: string; name: string }>;
  hasPdf: boolean;
  hasNotes: boolean;
  metadataState: "pending" | "complete" | "needs_review" | "failed";
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  lastOpenedAt?: string | null;
}

export interface PaperDetail extends PaperListItem {
  abstract: string | null;
  sourceUrl: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  language: string | null;
  paperType: string;
  priority: number;
  readProgress: number;
  identifiers: PaperIdentifier[];
  collections: Array<{ id: string; name: string }>;
  notes: NoteRecord[];
  files: PaperFile[];
  noteMarkdown?: string | null;
}

export type PaperMutationResult = Omit<PaperDetail, "notes"> & { notes?: NoteRecord[] };

export interface NoteRecord {
  id: string;
  paperId: string;
  noteType: "general" | "page" | "highlight" | "summary" | "todo";
  pageNumber: number | null;
  contentMarkdown: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaperPage {
  items: PaperListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ExportJob {
  id: string;
  state: "pending" | "complete" | "failed";
  downloadUrl?: string;
  errorMessage?: string | null;
}

export interface UserPreferences {
  defaultCollectionId: string | null;
  defaultTagIds: string[];
  defaultStatus: "inbox" | "reading" | "read" | "archived";
  defaultExportFormat: "bibtex" | "csl-json" | "ris" | "csv" | "json";
  updatedAt: string | null;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  headers.set("accept", "application/json");

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    throw new ApiRequestError(
      payload?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      payload?.error?.code,
      payload?.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { accept: "text/plain", ...(init.headers ?? {}) },
    credentials: "include",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    throw new ApiRequestError(
      payload?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      payload?.error?.code,
      payload?.error?.details,
    );
  }
  return response.text();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function createAndWaitForExport(body: Record<string, unknown>): Promise<ExportJob> {
  let job = await request<ExportJob>("/v1/exports", { method: "POST", body: JSON.stringify(body) });
  for (let attempt = 0; job.state === "pending" && attempt < 120; attempt += 1) {
    await delay(1_000);
    job = await request<ExportJob>(`/v1/exports/${encodeURIComponent(job.id)}`);
  }
  if (job.state !== "complete") {
    throw new ApiRequestError(
      job.errorMessage ?? "エクスポートを完了できませんでした。",
      409,
      "EXPORT_NOT_READY",
    );
  }
  const download = await request<{ url: string }>(
    `/v1/exports/${encodeURIComponent(job.id)}/download-url`,
  );
  return { ...job, downloadUrl: download.url };
}

/** Citera API proxy URLs need the session cookie; presigned R2 URLs must stay credential-free. */
export function shouldSendCredentials(url: string): boolean {
  const fallbackBase = globalThis.location?.href ?? "http://localhost/";
  const parsed = new URL(url, fallbackBase);
  return parsed.pathname.startsWith("/v1/files/");
}

interface UploadTicketResponse {
  file: PaperFile & { ingestionId?: string | null };
  upload: { url: string; headers: Record<string, string>; expiresIn: number } | null;
  duplicate: boolean;
}

export const api = {
  session: () => request<SessionResponse>("/v1/auth/session"),
  logout: () => request<void>("/v1/auth/logout", { method: "POST" }),
  devLogin: () => request<SessionResponse>("/v1/auth/dev-login", { method: "POST" }),
  papers: (search: URLSearchParams) => request<PaperPage>(`/v1/papers?${search.toString()}`),
  paper: async (id: string): Promise<PaperDetail> => {
    const detail = await request<PaperMutationResult>(`/v1/papers/${encodeURIComponent(id)}`);
    if (detail.notes) return { ...detail, notes: detail.notes };
    const notes = await request<{ items: NoteRecord[] }>(
      `/v1/papers/${encodeURIComponent(id)}/notes`,
    );
    return { ...detail, notes: notes.items };
  },
  createPaper: (body: Record<string, unknown>) =>
    request<PaperMutationResult>("/v1/papers", { method: "POST", body: JSON.stringify(body) }),
  updatePaper: (id: string, version: number, body: Record<string, unknown>) =>
    request<PaperMutationResult>(`/v1/papers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "if-match": String(version) },
      body: JSON.stringify(body),
    }),
  removePaper: (id: string, version: number) =>
    request<void>(`/v1/papers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "if-match": String(version) },
    }),
  restorePaper: (id: string, version: number) =>
    request<PaperMutationResult>(`/v1/papers/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      headers: { "if-match": String(version) },
    }),
  addNote: (paperId: string, body: Record<string, unknown>) =>
    request<NoteRecord>(`/v1/papers/${encodeURIComponent(paperId)}/notes`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateNote: (id: string, version: number, body: Record<string, unknown>) =>
    request<NoteRecord>(`/v1/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "if-match": String(version) },
      body: JSON.stringify(body),
    }),
  removeNote: (id: string, version: number) =>
    request<void>(`/v1/notes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "if-match": String(version) },
    }),
  tags: async () => (await request<{ items: PaperTag[] }>("/v1/tags")).items,
  createTag: (body: { name: string; color?: string | null }) =>
    request<PaperTag>("/v1/tags", { method: "POST", body: JSON.stringify(body) }),
  updateTag: (tagId: string, body: { name?: string; color?: string | null }) =>
    request<PaperTag>(`/v1/tags/${encodeURIComponent(tagId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeTag: (tagId: string) =>
    request<void>(`/v1/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" }),
  addPaperTag: (paperId: string, tagId: string) =>
    request<void>(`/v1/papers/${encodeURIComponent(paperId)}/tags/${encodeURIComponent(tagId)}`, {
      method: "PUT",
    }),
  removePaperTag: (paperId: string, tagId: string) =>
    request<void>(`/v1/papers/${encodeURIComponent(paperId)}/tags/${encodeURIComponent(tagId)}`, {
      method: "DELETE",
    }),
  collections: async () => (await request<{ items: CollectionRecord[] }>("/v1/collections")).items,
  createCollection: (body: {
    name: string;
    description?: string | null;
    parentId?: string | null;
  }) =>
    request<CollectionRecord>("/v1/collections", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateCollection: (
    collectionId: string,
    body: { name?: string; description?: string | null; parentId?: string | null },
  ) =>
    request<CollectionRecord>(`/v1/collections/${encodeURIComponent(collectionId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeCollection: (collectionId: string) =>
    request<void>(`/v1/collections/${encodeURIComponent(collectionId)}`, { method: "DELETE" }),
  addPaperToCollection: (paperId: string, collectionId: string) =>
    request<void>(
      `/v1/collections/${encodeURIComponent(collectionId)}/papers/${encodeURIComponent(paperId)}`,
      { method: "PUT" },
    ),
  removePaperFromCollection: (paperId: string, collectionId: string) =>
    request<void>(
      `/v1/collections/${encodeURIComponent(collectionId)}/papers/${encodeURIComponent(paperId)}`,
      { method: "DELETE" },
    ),
  devices: async () =>
    (
      await request<{
        devices: Array<{ id: string; deviceName: string; lastUsedAt: string; current: boolean }>;
      }>("/v1/auth/devices")
    ).devices,
  revokeDevice: (id: string) =>
    request<void>(`/v1/auth/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  usage: () =>
    request<{
      papers: number;
      notes: number;
      tags: number;
      collections: number;
      files: number;
      storageBytes: number;
    }>("/v1/usage"),
  preferences: () => request<UserPreferences>("/v1/preferences"),
  updatePreferences: (body: Partial<Omit<UserPreferences, "updatedAt">>) =>
    request<UserPreferences>("/v1/preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAccount: (confirmation: string) =>
    request<{ state: "queued"; jobId: string }>("/v1/account", {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    }),
  downloadUrl: (fileId: string) =>
    request<{
      url: string;
      headers: Record<string, string>;
      expiresIn: number;
      fileName: string;
      mediaType: string;
    }>(`/v1/files/${encodeURIComponent(fileId)}/download-url`),
  uploadUrl: async (
    paperId: string,
    body: {
      sizeBytes: number;
      mediaType: string;
      sha256: string;
      originalName: string;
      fileKind?: PaperFile["fileKind"];
      label?: string | null;
      languageCode?: string | null;
      isDefault?: boolean;
      sortOrder?: number;
    },
  ) => {
    const ticket = await request<UploadTicketResponse>(
      `/v1/papers/${encodeURIComponent(paperId)}/files/upload-url`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return {
      fileId: ticket.file.id,
      ingestionId: ticket.file.ingestionId ?? null,
      uploadUrl: ticket.upload?.url ?? null,
      headers: ticket.upload?.headers ?? {},
      expiresIn: ticket.upload?.expiresIn ?? 0,
      duplicate: ticket.duplicate,
      uploadState: ticket.file.uploadState,
    };
  },
  completeUpload: (fileId: string) =>
    request<PaperFile>(`/v1/files/${encodeURIComponent(fileId)}/complete`, { method: "POST" }),
  retryUpload: (fileId: string) =>
    request<{
      file: PaperFile;
      upload: { url: string; headers: Record<string, string>; expiresIn: number };
    }>(`/v1/files/${encodeURIComponent(fileId)}/retry`, { method: "POST" }),
  updateFile: (fileId: string, body: Record<string, unknown>) =>
    request<PaperFile>(`/v1/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  removeFile: (fileId: string) =>
    request<void>(`/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }),
  restoreFile: (fileId: string) =>
    request<PaperFile>(`/v1/files/${encodeURIComponent(fileId)}/restore`, { method: "POST" }),
  bibtex: (itemId: string) => requestText(`/v1/papers/${encodeURIComponent(itemId)}/bibtex`),
  resolveDoi: (doi: string) =>
    request<{ doi: string; metadata: Record<string, unknown> }>("/v1/metadata/resolve-doi", {
      method: "POST",
      body: JSON.stringify({ doi }),
    }),
  refreshMetadata: (paperId: string) =>
    request<{ jobId: string; state: string }>(
      `/v1/papers/${encodeURIComponent(paperId)}/refresh-metadata`,
      { method: "POST" },
    ),
  fetchPdf: (paperId: string) =>
    request<{ jobId?: string; state: string; fileId?: string }>(
      `/v1/papers/${encodeURIComponent(paperId)}/fetch-pdf`,
      { method: "POST" },
    ),
  fetchPdfStatus: (paperId: string, jobId: string) =>
    request<{
      state: "queued" | "running" | "retrying" | "complete" | "failed";
      errorCode?: string | null;
      errorMessage?: string | null;
    }>(`/v1/papers/${encodeURIComponent(paperId)}/fetch-pdf/${encodeURIComponent(jobId)}`),
  duplicateCandidates: async (paperId: string) =>
    (
      await request<{
        candidates: Array<{ paper: PaperListItem; reasons: string[] }>;
      }>(`/v1/papers/${encodeURIComponent(paperId)}/duplicate-candidates`)
    ).candidates,
  exportPapers: createAndWaitForExport,
  sync: (cursor: number) =>
    request<{ changes: SyncChange[]; nextCursor: number; hasMore: boolean }>(
      `/v1/sync?cursor=${cursor}&limit=500`,
    ),
  mutate: (mutations: OutboxMutation[]) =>
    request<{ results: MutationResult[] }>("/v1/sync/mutations", {
      method: "POST",
      body: JSON.stringify({ mutations }),
    }),
};

export interface SyncChange {
  sequence: number;
  entityType: string;
  entityId: string;
  operation: "create" | "update" | "delete";
  version: number;
  data: Record<string, unknown> | null;
}

export interface OutboxMutation {
  clientMutationId: string;
  entityType: string;
  entityId: string;
  operation: string;
  baseVersion: number | null;
  payload: Record<string, unknown>;
}

export interface MutationResult {
  clientMutationId: string;
  status: "applied" | "duplicate" | "conflict" | "rejected";
  details?: unknown;
}
