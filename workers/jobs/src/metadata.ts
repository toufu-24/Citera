import { createId, normalizeComparableText, nowUtcIso } from "@citera/domain";
import {
  mergeMetadata,
  type BibliographicMetadata,
  type MetadataCandidate,
} from "@citera/metadata";
import { all, first, type Row } from "./db";
import type { Env, JobMessage, JobResult } from "./types";
import { JobError } from "./types";

interface IdentifierRow extends Row {
  identifier_type: string;
  normalized_value: string;
}

interface CacheRow extends Row {
  response_json: string;
  expires_at: string;
}

interface LocalCandidateRow extends Row {
  field_name: string;
  value_json: string;
  source_type: "webpage" | "pdf" | "import";
  source_reference: string | null;
  confidence: number;
  updated_at: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(value: unknown): string | undefined {
  if (Array.isArray(value)) return text(value[0]);
  return text(value);
}

function yearFromParts(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const firstPart: unknown = value[0];
  if (!Array.isArray(firstPart)) return undefined;
  const year: unknown = firstPart[0];
  return typeof year === "number" ? year : undefined;
}

function dateFromParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const firstPart: unknown = value[0];
  if (!Array.isArray(firstPart)) return undefined;
  const year: unknown = firstPart[0];
  const month: unknown = firstPart[1] ?? 1;
  const day: unknown = firstPart[2] ?? 1;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number")
    return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function crossrefCandidate(raw: unknown, doi: string): MetadataCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = (raw as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  const title = firstText(record.title);
  if (!title) return null;
  const authors = Array.isArray(record.author)
    ? record.author.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const author = item as Record<string, unknown>;
        const givenName = text(author.given);
        const familyName = text(author.family);
        const displayName = [givenName, familyName].filter(Boolean).join(" ") || text(author.name);
        if (!displayName) return [];
        const orcid = text(author.ORCID)?.replace(/^https?:\/\/orcid\.org\//u, "");
        return [
          {
            displayName,
            ...(givenName ? { givenName } : {}),
            ...(familyName ? { familyName } : {}),
            ...(orcid ? { orcid } : {}),
          },
        ];
      })
    : [];
  const dateParts = (record.published as { "date-parts"?: unknown } | undefined)?.["date-parts"];
  const abstract = text(record.abstract)
    ?.replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const publicationDate = dateFromParts(dateParts);
  const publicationYear = yearFromParts(dateParts);
  const venue = firstText(record["container-title"]);
  const volume = text(record.volume);
  const issue = text(record.issue);
  const pages = text(record.page);
  const publisher = text(record.publisher);
  const language = text(record.language);
  const url = text(record.URL);
  const metadata: BibliographicMetadata = {
    title,
    doi,
    ...(abstract ? { abstract } : {}),
    ...(authors.length ? { authors } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(publicationYear ? { publicationYear } : {}),
    ...(venue ? { venue } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(publisher ? { publisher } : {}),
    ...(language ? { language } : {}),
    ...(url ? { url } : {}),
    paperType:
      record.type === "proceedings-article"
        ? "paper-conference"
        : record.type === "book"
          ? "book"
          : "article-journal",
  };
  return {
    metadata,
    source: "crossref",
    matchType: "exact-identifier",
    confidence: 0.99,
    retrievedAt: nowUtcIso(),
    reference: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu").exec(xml);
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function arxivCandidate(xml: string, arxivId: string): MetadataCandidate | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/iu.exec(xml)?.[1];
  if (!entry) return null;
  const title = xmlTag(entry, "title");
  if (!title) return null;
  const authors = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/giu)].flatMap((match) => {
    const displayName = xmlTag(match[1] ?? "", "name");
    return displayName ? [{ displayName }] : [];
  });
  const published = xmlTag(entry, "published");
  const journal = xmlTag(entry, "arxiv:journal_ref");
  const doi = xmlTag(entry, "arxiv:doi");
  const abstract = xmlTag(entry, "summary");
  return {
    metadata: {
      title,
      arxivId,
      paperType: "preprint",
      ...(abstract ? { abstract } : {}),
      ...(authors.length ? { authors } : {}),
      ...(published
        ? {
            publicationDate: published.slice(0, 10),
            publicationYear: Number(published.slice(0, 4)),
          }
        : {}),
      ...(journal ? { venue: journal } : {}),
      ...(doi ? { doi } : {}),
      url: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
    },
    source: "arxiv",
    matchType: "exact-identifier",
    confidence: 0.99,
    retrievedAt: nowUtcIso(),
    reference: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
  };
}

async function cachedCandidate(
  env: Env,
  key: string,
  provider: string,
  loader: () => Promise<MetadataCandidate | null>,
): Promise<MetadataCandidate | null> {
  const cached = await first<CacheRow>(
    env.DB,
    "SELECT response_json,expires_at FROM metadata_cache WHERE cache_key=?",
    key,
  );
  if (cached && cached.expires_at > nowUtcIso()) {
    try {
      return JSON.parse(cached.response_json) as MetadataCandidate;
    } catch {
      // Replace a corrupt cache record below.
    }
  }
  const candidate = await loader();
  if (candidate) {
    const now = nowUtcIso();
    const ttl = Math.min(Math.max(Number(env.METADATA_CACHE_SECONDS) || 604_800, 300), 2_592_000);
    await env.DB.prepare(
      `INSERT INTO metadata_cache (cache_key,provider,response_json,etag,fetched_at,expires_at)
       VALUES (?,?,?,NULL,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json,
         fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`,
    )
      .bind(
        key,
        provider,
        JSON.stringify(candidate),
        now,
        new Date(Date.now() + ttl * 1000).toISOString(),
      )
      .run();
  }
  return candidate;
}

async function loadCrossref(env: Env, doi: string): Promise<MetadataCandidate | null> {
  return cachedCandidate(env, `crossref:doi:${doi}`, "crossref", async () => {
    const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    if (env.CROSSREF_MAILTO) url.searchParams.set("mailto", env.CROSSREF_MAILTO);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": `Citera/0.1${env.CROSSREF_MAILTO ? ` (mailto:${env.CROSSREF_MAILTO})` : ""}`,
        },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new JobError(
        "METADATA_NETWORK_ERROR",
        error instanceof Error ? error.message : "Crossref request failed",
        true,
      );
    }
    if (response.status === 404) return null;
    if (response.status === 429 || response.status >= 500)
      throw new JobError("METADATA_TEMPORARY_ERROR", `Crossref returned ${response.status}`, true);
    if (!response.ok)
      throw new JobError(
        "METADATA_PROVIDER_REJECTED",
        `Crossref returned ${response.status}`,
        false,
      );
    return crossrefCandidate(await response.json(), doi);
  });
}

async function loadArxiv(env: Env, arxivId: string): Promise<MetadataCandidate | null> {
  return cachedCandidate(env, `arxiv:id:${arxivId}`, "arxiv", async () => {
    let response: Response;
    try {
      response = await fetch(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
        {
          headers: {
            "User-Agent": `Citera/0.1${env.CROSSREF_MAILTO ? ` (${env.CROSSREF_MAILTO})` : ""}`,
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
    } catch (error) {
      throw new JobError(
        "METADATA_NETWORK_ERROR",
        error instanceof Error ? error.message : "arXiv request failed",
        true,
      );
    }
    if (response.status === 429 || response.status >= 500)
      throw new JobError("METADATA_TEMPORARY_ERROR", `arXiv returned ${response.status}`, true);
    if (!response.ok)
      throw new JobError("METADATA_PROVIDER_REJECTED", `arXiv returned ${response.status}`, false);
    return arxivCandidate(await response.text(), arxivId);
  });
}

const paperColumns: Partial<Record<keyof BibliographicMetadata, string>> = {
  title: "title",
  abstract: "abstract",
  publicationYear: "publication_year",
  publicationDate: "publication_date",
  venue: "venue",
  volume: "volume",
  issue: "issue",
  pages: "pages",
  publisher: "publisher",
  language: "language",
  paperType: "paper_type",
  url: "source_url",
};

export async function enrichPaper(env: Env, job: JobMessage): Promise<JobResult> {
  if (!job.paperId) throw new JobError("PAPER_ID_REQUIRED", "Metadata jobs require paperId", false);
  const paper = await first<Row>(
    env.DB,
    "SELECT * FROM papers WHERE id=? AND user_id=? AND deleted_at IS NULL",
    job.paperId,
    job.userId,
  );
  if (!paper) throw new JobError("PAPER_NOT_FOUND", "Paper was not found", false);
  if (Number(paper.version) !== job.sourceVersion) {
    await rebuildSearchIndex(env, { ...job, sourceVersion: Number(paper.version) });
    return {
      skipped: true,
      reason: "stale_source_version",
      sourceVersion: job.sourceVersion,
      currentVersion: Number(paper.version),
    };
  }
  const identifiers = await all<IdentifierRow>(
    env.DB,
    "SELECT identifier_type,normalized_value FROM paper_identifiers WHERE user_id=? AND paper_id=?",
    job.userId,
    job.paperId,
  );
  const candidates: MetadataCandidate[] = [];
  const doi = identifiers.find(
    (identifier) => identifier.identifier_type === "doi",
  )?.normalized_value;
  const arxivId = identifiers.find(
    (identifier) => identifier.identifier_type === "arxiv",
  )?.normalized_value;
  if (doi) {
    const crossref = await loadCrossref(env, doi);
    if (crossref) candidates.push(crossref);
  }
  if (arxivId) {
    const arxiv = await loadArxiv(env, arxivId);
    if (arxiv) candidates.push(arxiv);
  }
  const userRows = await all<Row>(
    env.DB,
    `SELECT field_name,value_json FROM metadata_values
     WHERE user_id=? AND paper_id=? AND source_type='user' AND selected=1 ORDER BY updated_at`,
    job.userId,
    job.paperId,
  );
  const userMetadata: BibliographicMetadata = {};
  for (const row of userRows) {
    try {
      (userMetadata as Record<string, unknown>)[String(row.field_name)] = JSON.parse(
        String(row.value_json),
      );
    } catch {
      // Ignore only the malformed historical candidate.
    }
  }
  if (Object.keys(userMetadata).length > 0) {
    candidates.push({
      metadata: userMetadata,
      source: "user",
      matchType: "user",
      confidence: 1,
      retrievedAt: nowUtcIso(),
    });
  }
  const localRows = await all<LocalCandidateRow>(
    env.DB,
    `SELECT field_name,value_json,source_type,source_reference,confidence,updated_at
     FROM metadata_values
     WHERE user_id=? AND paper_id=? AND source_type IN ('webpage','pdf','import')
     ORDER BY updated_at`,
    job.userId,
    job.paperId,
  );
  const localCandidates = new Map<string, MetadataCandidate>();
  for (const row of localRows) {
    try {
      const key = `${row.source_type}:${row.source_reference ?? ""}`;
      const candidate =
        localCandidates.get(key) ??
        ({
          metadata: {},
          source: row.source_type,
          matchType:
            row.source_type === "import"
              ? "import"
              : row.source_type === "pdf"
                ? "embedded"
                : "structured",
          confidence: Number(row.confidence),
          retrievedAt: row.updated_at,
          ...(row.source_reference ? { reference: row.source_reference } : {}),
        } satisfies MetadataCandidate);
      (candidate.metadata as Record<string, unknown>)[row.field_name] = JSON.parse(row.value_json);
      candidate.confidence = Math.max(candidate.confidence, Number(row.confidence));
      candidate.retrievedAt = row.updated_at;
      localCandidates.set(key, candidate);
    } catch {
      // Ignore only malformed historical provenance values.
    }
  }
  candidates.push(...localCandidates.values());
  const merged = candidates.length
    ? mergeMetadata(candidates)
    : { metadata: {} as BibliographicMetadata, metadataState: "needs_review" as const };
  const protectedFields = new Set(userRows.map((row) => String(row.field_name)));
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(paperColumns)) {
    const value = merged.metadata[field as keyof BibliographicMetadata];
    if (column && value !== undefined && !protectedFields.has(field)) {
      assignments.push(`${column}=?`);
      values.push(value);
    }
  }
  const now = nowUtcIso();
  const nextVersion = Number(paper.version) + 1;
  assignments.push("metadata_state=?", "updated_at=?", "version=?");
  values.push(merged.metadataState, now, nextVersion);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE papers SET ${assignments.join(",")} WHERE id=? AND user_id=? AND version=?`,
    ).bind(...values, job.paperId, job.userId, job.sourceVersion),
  ];
  for (const candidate of candidates.filter(
    (candidate) => candidate.source === "crossref" || candidate.source === "arxiv",
  )) {
    for (const [field, value] of Object.entries(candidate.metadata)) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO metadata_values
            (id,user_id,paper_id,field_name,value_json,source_type,source_reference,confidence,selected,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          createId("mdv"),
          job.userId,
          job.paperId,
          field,
          JSON.stringify(value),
          candidate.source,
          candidate.reference ?? null,
          candidate.fieldConfidences?.[field as keyof BibliographicMetadata] ??
            candidate.confidence,
          protectedFields.has(field) ? 0 : 1,
          now,
          now,
        ),
      );
    }
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO changes (user_id,entity_type,entity_id,operation,version,data_json,changed_at)
       VALUES (?,'paper',?,'update',?,?,?)`,
    ).bind(
      job.userId,
      job.paperId,
      nextVersion,
      JSON.stringify({
        id: job.paperId,
        ...merged.metadata,
        metadataState: merged.metadataState,
        version: nextVersion,
        updatedAt: now,
      }),
      now,
    ),
  );
  try {
    const results = await env.DB.batch(statements);
    if (results[0]?.meta.changes !== 1) {
      throw new JobError(
        "PAPER_VERSION_CONFLICT",
        "The paper changed while metadata was being fetched",
        true,
      );
    }
  } catch (error) {
    const current = await first<Row>(
      env.DB,
      "SELECT version FROM papers WHERE id=? AND user_id=?",
      job.paperId,
      job.userId,
    );
    if (current && Number(current.version) !== job.sourceVersion) {
      await rebuildSearchIndex(env, { ...job, sourceVersion: Number(current.version) });
      return {
        skipped: true,
        reason: "stale_source_version",
        sourceVersion: job.sourceVersion,
        currentVersion: Number(current.version),
      };
    }
    throw error;
  }
  await rebuildSearchIndex(env, { ...job, sourceVersion: nextVersion });
  return {
    metadataState: merged.metadataState,
    providers: candidates
      .filter((candidate) => candidate.source === "crossref" || candidate.source === "arxiv")
      .map((candidate) => candidate.source),
    version: nextVersion,
  };
}

export async function rebuildSearchIndex(env: Env, job: JobMessage): Promise<JobResult> {
  if (!job.paperId) throw new JobError("PAPER_ID_REQUIRED", "Search jobs require paperId", false);
  const paper = await first<Row>(
    env.DB,
    "SELECT * FROM papers WHERE id=? AND user_id=?",
    job.paperId,
    job.userId,
  );
  if (!paper) throw new JobError("PAPER_NOT_FOUND", "Paper was not found", false);
  const rows = await all<Row>(
    env.DB,
    `SELECT display_name AS value FROM authors a JOIN paper_authors pa ON pa.author_id=a.id AND pa.user_id=a.user_id WHERE pa.user_id=? AND pa.paper_id=?
     UNION ALL SELECT normalized_value FROM paper_identifiers WHERE user_id=? AND paper_id=?
     UNION ALL SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id=t.id AND pt.user_id=t.user_id WHERE pt.user_id=? AND pt.paper_id=?
     UNION ALL SELECT content_markdown FROM notes WHERE user_id=? AND paper_id=? AND deleted_at IS NULL`,
    job.userId,
    job.paperId,
    job.userId,
    job.paperId,
    job.userId,
    job.paperId,
    job.userId,
    job.paperId,
  );
  const searchText = normalizeComparableText(
    [paper.title, paper.abstract, paper.venue, paper.publisher, ...rows.map((row) => row.value)]
      .filter(Boolean)
      .join(" "),
  );
  await env.DB.prepare("UPDATE papers SET search_text=? WHERE id=? AND user_id=?")
    .bind(searchText, job.paperId, job.userId)
    .run();
  return { characters: searchText.length };
}
