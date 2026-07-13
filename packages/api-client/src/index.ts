import {
  ApiErrorResponseSchema,
  CursorPageSchema,
  FileSummarySchema,
  PaperDetailSchema,
  PaperSummarySchema,
  type CursorPage,
  type PaperDetail,
  type PaperSummary,
} from "@citera/domain";
import { z } from "zod";

export class CiteraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "CiteraApiError";
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  getAccessToken?: () => string | null | Promise<string | null>;
}

export interface ListPapersQuery {
  q?: string;
  tags?: string[];
  collection?: string;
  author?: string;
  venue?: string;
  status?: string;
  paperType?: string;
  yearFrom?: number;
  yearTo?: number;
  rating?: number;
  hasPdf?: boolean;
  hasNotes?: boolean;
  deleted?: "exclude" | "only" | "include";
  sort?: string;
  cursor?: string;
  limit?: number;
}

const UploadTicketSchema = z.object({
  file: FileSummarySchema,
  upload: z
    .object({
      url: z.string().url(),
      headers: z.record(z.string(), z.string()),
      expiresIn: z.number().int().positive(),
    })
    .nullable(),
  duplicate: z.boolean(),
});
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

const PaperMutationSchema = PaperDetailSchema.partial({ notes: true });
export type PaperMutationResult = z.infer<typeof PaperMutationSchema>;

function queryString(query: ListPapersQuery) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    result.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return result.toString();
}

export function createCiteraApiClient(options: ApiClientOptions = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/u, "");

  async function request<Output>(path: string, schema: z.ZodType<Output>, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body && !(init.body instanceof FormData))
      headers.set("content-type", "application/json");
    const token = await options.getAccessToken?.();
    if (token) headers.set("authorization", `Bearer ${token}`);

    const response = await fetchImplementation(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: token ? "omit" : "include",
    });
    const payload: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => null);
    if (!response.ok) {
      const error = ApiErrorResponseSchema.safeParse(payload);
      if (error.success) {
        throw new CiteraApiError(
          response.status,
          error.data.error.code,
          error.data.error.message,
          error.data.error.details,
          error.data.requestId,
        );
      }
      throw new CiteraApiError(
        response.status,
        "INVALID_ERROR_RESPONSE",
        `Request failed (${response.status})`,
      );
    }
    return schema.parse(payload);
  }

  return {
    listPapers(query: ListPapersQuery = {}): Promise<CursorPage<PaperSummary>> {
      const suffix = queryString(query);
      return request(
        `/v1/papers${suffix ? `?${suffix}` : ""}`,
        CursorPageSchema(PaperSummarySchema),
      );
    },
    getPaper(paperId: string): Promise<PaperDetail> {
      return request(`/v1/papers/${encodeURIComponent(paperId)}`, PaperDetailSchema);
    },
    createPaper(input: unknown): Promise<PaperMutationResult> {
      return request("/v1/papers", PaperMutationSchema, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    updatePaper(paperId: string, version: number, input: unknown): Promise<PaperMutationResult> {
      return request(`/v1/papers/${encodeURIComponent(paperId)}`, PaperMutationSchema, {
        method: "PATCH",
        headers: { "if-match": String(version) },
        body: JSON.stringify(input),
      });
    },
    createUploadTicket(
      paperId: string,
      input: {
        sizeBytes: number;
        mediaType: string;
        sha256: string;
        originalName: string;
        kind?: "original_pdf" | "supplement";
        ingestionId?: string;
      },
    ): Promise<UploadTicket> {
      return request(
        `/v1/papers/${encodeURIComponent(paperId)}/files/upload-url`,
        UploadTicketSchema,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
    },
    sync(cursor: number, limit = 500) {
      return request(
        `/v1/sync?cursor=${cursor}&limit=${limit}`,
        z.object({
          changes: z.array(
            z.object({
              sequence: z.number().int(),
              entityType: z.string(),
              entityId: z.string(),
              operation: z.enum(["create", "update", "delete"]),
              version: z.number().int(),
              data: z.record(z.string(), z.unknown()).nullable(),
            }),
          ),
          nextCursor: z.number().int(),
          hasMore: z.boolean(),
        }),
      );
    },
    request,
  };
}

export type CiteraApiClient = ReturnType<typeof createCiteraApiClient>;
