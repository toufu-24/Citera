import type { CollectionChoice, LibraryChoices, SavePaperInput, TagChoice } from "../types";
import { getAccessToken, refreshAccessToken } from "./auth";
import { readSettings } from "./settings";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

interface IngestionResponse {
  ingestionId: string;
  paperId: string;
  duplicate?: {
    paperId?: string;
    title?: string;
    reason: string;
  };
}

interface UploadTicket {
  fileId: string;
  ingestionId: string;
  uploadUrl: string | null;
  method: "PUT";
  headers: Record<string, string>;
  duplicate: boolean;
}

interface UploadDescriptor {
  sizeBytes: number;
  mediaType: string;
  sha256: string;
  originalName: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key] !== "") return record[key];
  }
  return undefined;
}

function arrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return Array.isArray(record.items) ? record.items : [];
}

async function parseApiError(response: Response): Promise<ApiRequestError> {
  const body = asRecord(await response.json().catch(() => null));
  const error = asRecord(body.error);
  return new ApiRequestError(
    stringValue(error, "message") ?? `Citera API request failed (${response.status})`,
    response.status,
    stringValue(error, "code") ?? "REQUEST_FAILED",
    error.details,
  );
}

async function authorizedFetch(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<Response> {
  const [settings, accessToken] = await Promise.all([readSettings(), getAccessToken()]);
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body != null && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const requestUrl = /^https?:\/\//iu.test(path) ? path : `${settings.apiBaseUrl}${path}`;
  const response = await fetch(requestUrl, { ...init, headers });
  if (response.status === 401 && !retried) {
    await refreshAccessToken();
    return authorizedFetch(path, init, true);
  }
  return response;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authorizedFetch(path, init);
  if (!response.ok) throw await parseApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function parseTag(value: unknown): TagChoice | null {
  const record = asRecord(value);
  const id = stringValue(record, "id");
  const name = stringValue(record, "name");
  const color = record.color;
  if (id == null || name == null) return null;
  return { id, name, color: typeof color === "string" ? color : null };
}

function parseCollection(value: unknown): CollectionChoice | null {
  const record = asRecord(value);
  const id = stringValue(record, "id");
  const name = stringValue(record, "name");
  return id == null || name == null ? null : { id, name };
}

function parsePreferences(value: unknown): LibraryChoices["preferences"] {
  const record = asRecord(value);
  const statuses = new Set(["inbox", "reading", "read", "archived"]);
  const defaultStatus = stringValue(record, "defaultStatus");
  const defaultTagIds = Array.isArray(record.defaultTagIds)
    ? record.defaultTagIds.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
  return {
    defaultStatus: statuses.has(defaultStatus ?? "")
      ? (defaultStatus as LibraryChoices["preferences"]["defaultStatus"])
      : "inbox",
    defaultTagIds,
    defaultCollectionId:
      typeof record.defaultCollectionId === "string" ? record.defaultCollectionId : null,
  };
}

function parseDuplicate(value: unknown): NonNullable<IngestionResponse["duplicate"]> {
  const record = asRecord(value);
  const reason = stringValue(record, "reason") ?? "この論文はすでにライブラリに登録されています。";
  const paperId = stringValue(record, "paperId", "paper_id", "id");
  const title = stringValue(record, "title");
  return {
    reason,
    ...(paperId == null ? {} : { paperId }),
    ...(title == null ? {} : { title }),
  };
}

export async function getLibraryChoices(): Promise<LibraryChoices> {
  const [rawTags, rawCollections, rawPreferences] = await Promise.all([
    request<unknown>("/v1/tags"),
    request<unknown>("/v1/collections"),
    request<unknown>("/v1/preferences"),
  ]);
  return {
    tags: arrayPayload(rawTags)
      .map(parseTag)
      .filter((item): item is TagChoice => item != null),
    collections: arrayPayload(rawCollections)
      .map(parseCollection)
      .filter((item): item is CollectionChoice => item != null),
    preferences: parsePreferences(rawPreferences),
  };
}

export function buildIngestionPayload(input: SavePaperInput): Record<string, unknown> {
  const identifiers = [
    ...(input.metadata.doi == null
      ? []
      : [{ identifierType: "doi", originalValue: input.metadata.doi }]),
    ...(input.metadata.arxivId == null
      ? []
      : [{ identifierType: "arxiv", originalValue: input.metadata.arxivId }]),
    { identifierType: "url", originalValue: input.metadata.pageUrl },
  ];
  return {
    clientMutationId: crypto.randomUUID(),
    sourceType: "extension",
    sourceUrl: input.metadata.pageUrl,
    paper: {
      title: input.metadata.title,
      authors: input.metadata.authors.map((author) => ({
        displayName: author.displayName,
        ...(author.givenName == null ? {} : { givenName: author.givenName }),
        ...(author.familyName == null ? {} : { familyName: author.familyName }),
        ...(author.orcid == null ? {} : { orcid: author.orcid }),
      })),
      publicationYear: input.metadata.publicationYear,
      venue: input.metadata.venue,
      abstract: input.metadata.abstract,
      status: input.status,
      sourceUrl: input.metadata.pageUrl,
      tagIds: input.tagIds,
      collectionIds: input.collectionIds,
      identifiers,
      observedMetadata: {
        publicationDate: input.metadata.publicationDate,
        pdfUrl: input.metadata.pdfUrl,
        keywords: input.metadata.keywords,
        detectedSources: input.metadata.detectedSources,
      },
    },
    includePdf: input.includePdf,
  };
}

export async function createIngestion(input: SavePaperInput): Promise<IngestionResponse> {
  const body = buildIngestionPayload(input);

  let raw: unknown;
  try {
    raw = await request<unknown>("/v1/ingestions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 409) {
      const details = asRecord(error.details);
      return {
        ingestionId: "duplicate",
        paperId: stringValue(details, "paperId", "paper_id", "id") ?? "duplicate",
        duplicate: parseDuplicate(error.details),
      };
    }
    throw error;
  }

  const record = asRecord(raw);
  const ingestion = asRecord(record.ingestion);
  const paper = asRecord(record.paper);
  const duplicateValue = record.duplicate ?? (record.outcome === "duplicate" ? record : undefined);
  const duplicate = duplicateValue == null ? undefined : parseDuplicate(duplicateValue);
  const ingestionId =
    stringValue(record, "ingestionId", "ingestion_id", "id") ?? stringValue(ingestion, "id");
  const paperId =
    stringValue(record, "paperId", "paper_id") ?? stringValue(paper, "id") ?? duplicate?.paperId;
  if (duplicate != null) {
    return {
      ingestionId: ingestionId ?? "duplicate",
      paperId: paperId ?? "duplicate",
      duplicate,
    };
  }
  if (ingestionId == null || paperId == null) {
    throw new Error("保存APIの応答にingestionIdまたはpaperIdがありません。");
  }
  return { ingestionId, paperId };
}

export async function createUploadTicket(
  paperId: string,
  ingestionId: string,
  descriptor: UploadDescriptor,
): Promise<UploadTicket> {
  const raw = await request<unknown>(`/v1/papers/${encodeURIComponent(paperId)}/files/upload-url`, {
    method: "POST",
    body: JSON.stringify({ ...descriptor, ingestionId }),
  });
  const record = asRecord(raw);
  const file = asRecord(record.file);
  const upload = asRecord(record.upload);
  const fileId = stringValue(record, "fileId", "file_id") ?? stringValue(file, "id");
  const responseIngestionId =
    stringValue(record, "ingestionId", "ingestion_id") ??
    stringValue(file, "ingestionId", "ingestion_id") ??
    ingestionId;
  const uploadUrl =
    stringValue(record, "uploadUrl", "upload_url") ?? stringValue(upload, "url", "uploadUrl");
  const rawHeaders = asRecord(record.headers ?? upload.headers);
  const duplicate = record.duplicate === true;
  if (fileId == null || (!duplicate && uploadUrl == null)) {
    throw new Error("署名付きアップロードURLの応答が不正です。");
  }
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    fileId,
    ingestionId: responseIngestionId,
    uploadUrl: uploadUrl ?? null,
    method: "PUT",
    headers,
    duplicate,
  };
}

export async function uploadToSignedUrl(
  ticket: UploadTicket,
  pdf: Uint8Array,
): Promise<string | null> {
  if (ticket.duplicate || ticket.uploadUrl == null) return null;
  const settings = await readSettings();
  const uploadUrl = new URL(ticket.uploadUrl);
  const apiUrl = new URL(settings.apiBaseUrl);
  const uploadBody = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(uploadBody).set(pdf);
  const init: RequestInit = {
    method: ticket.method,
    headers: ticket.headers,
    body: uploadBody,
  };
  const response =
    uploadUrl.origin === apiUrl.origin
      ? await authorizedFetch(ticket.uploadUrl, init)
      : await fetch(ticket.uploadUrl, init);
  if (!response.ok) throw new Error(`PDFのアップロードに失敗しました (${response.status})。`);
  return response.headers.get("etag");
}

export async function completeFileUpload(ticket: UploadTicket, etag: string | null): Promise<void> {
  if (ticket.duplicate) return;
  await request(`/v1/files/${encodeURIComponent(ticket.fileId)}/complete`, {
    method: "POST",
    body: JSON.stringify({
      ingestionId: ticket.ingestionId,
      ...(etag == null ? {} : { etag }),
    }),
  });
}

export async function discardFile(fileId: string): Promise<void> {
  await request(`/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}

export async function completeIngestion(ingestionId: string, fileId?: string): Promise<void> {
  await request(`/v1/ingestions/${encodeURIComponent(ingestionId)}/complete`, {
    method: "POST",
    body: JSON.stringify(fileId == null ? {} : { fileId }),
  });
}
