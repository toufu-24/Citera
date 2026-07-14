import { normalizeDoi } from "@citera/domain";
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../errors";
import type { AppBindings } from "../types";
import { nowUtcIso } from "../utils";

export interface ResolvedDoiMetadata {
  doi: string;
  title: string;
  authors: Array<{ displayName: string; givenName?: string; familyName?: string }>;
  publicationDate: string | null;
  publicationYear: number | null;
  venue: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  language: string | null;
  url: string | null;
  paperType: "article-journal" | "paper-conference" | "book";
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function firstText(value: unknown): string | null {
  return Array.isArray(value) ? text(value[0]) : text(value);
}

function dateParts(value: unknown): [number, number?, number?] | null {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null;
  const parts = value[0] as unknown[];
  const year = typeof parts[0] === "number" ? parts[0] : null;
  if (!year) return null;
  const result: [number, number?, number?] = [year];
  if (typeof parts[1] === "number") result[1] = parts[1];
  if (typeof parts[2] === "number") result[2] = parts[2];
  return result;
}

function publishedDate(record: Record<string, unknown>): [number, number?, number?] | null {
  for (const key of ["published", "published-print", "published-online", "issued", "created"]) {
    const candidate = record[key];
    const parts = dateParts(
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as { "date-parts"?: unknown })["date-parts"]
        : null,
    );
    if (parts) return parts;
  }
  return null;
}

function parseCrossref(raw: unknown, doi: string): ResolvedDoiMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = (raw as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  const title = firstText(record.title);
  if (!title) return null;
  const authors = Array.isArray(record.author)
    ? record.author.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const author = entry as Record<string, unknown>;
        const givenName = text(author.given);
        const familyName = text(author.family);
        const displayName = [givenName, familyName].filter(Boolean).join(" ") || text(author.name);
        return displayName
          ? [{
              displayName,
              ...(givenName ? { givenName } : {}),
              ...(familyName ? { familyName } : {}),
            }]
          : [];
      })
    : [];
  const published = publishedDate(record);
  const publicationDate = published?.[1] != null && published?.[2] != null
    ? `${published[0]}-${String(published[1]).padStart(2, "0")}-${String(published[2]).padStart(2, "0")}`
    : null;
  const type = record.type === "proceedings-article" ? "paper-conference" : record.type === "book" ? "book" : "article-journal";
  return {
    doi,
    title,
    authors,
    publicationDate,
    publicationYear: published?.[0] ?? null,
    venue: firstText(record["container-title"]),
    volume: text(record.volume),
    issue: text(record.issue),
    pages: text(record.page),
    publisher: text(record.publisher),
    language: text(record.language),
    url: text(record.URL) ?? `https://doi.org/${doi}`,
    paperType: type,
  };
}

export async function resolveDoiMetadata(
  env: AppBindings["Bindings"],
  rawDoi: string,
): Promise<ResolvedDoiMetadata> {
  const doi = normalizeDoi(rawDoi);
  if (!doi) throw new ApiError(422, "DOI_INVALID", "The DOI is invalid.");
  let response: Response;
  try {
    response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { Accept: "application/json", "User-Agent": "Citera/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApiError(502, "METADATA_FETCH_FAILED", "Bibliographic metadata could not be fetched.");
  }
  if (response.status === 404) throw new ApiError(404, "DOI_NOT_FOUND", "The DOI was not found.");
  if (!response.ok) throw new ApiError(502, "METADATA_FETCH_FAILED", "Bibliographic metadata could not be fetched.");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiError(502, "METADATA_FETCH_FAILED", "The metadata provider returned invalid data.");
  }
  const metadata = parseCrossref(raw, doi);
  if (!metadata) throw new ApiError(502, "METADATA_FETCH_FAILED", "The metadata provider returned incomplete data.");
  return metadata;
}

const resolveSchema = z.object({ doi: z.string().trim().min(1).max(2_048) }).strict();

export const metadataRoutes = new Hono<AppBindings>();

metadataRoutes.post("/metadata/resolve-doi", async (c) => {
  const input = resolveSchema.parse(await c.req.json());
  const metadata = await resolveDoiMetadata(c.env, input.doi);
  return c.json({ doi: metadata.doi, metadata, resolvedAt: nowUtcIso() });
});
