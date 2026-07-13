import { normalizeArxivId, normalizeDoi, nowUtcIso } from "@citera/domain";

import type { BibliographicMetadata, MetadataAuthor, MetadataCandidate } from "./types";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (entity, code: string) => decodeCodePoint(entity, code, 10))
    .replace(/&#x([\da-f]+);/giu, (entity, code: string) => decodeCodePoint(entity, code, 16))
    .replace(
      /&([a-z]+);/giu,
      (entity, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? entity,
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeCodePoint(entity: string, code: string, radix: number): string {
  const value = Number.parseInt(code, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : entity;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (key != null && value != null) attributes[key] = decodeHtml(value);
  }
  return attributes;
}

function collectMeta(html: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  const pattern = /<meta\b([^>]*?)\/?\s*>/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = parseAttributes(match[1] ?? "");
    const name = (attributes.name ?? attributes.property ?? attributes.itemprop)?.toLowerCase();
    const content = attributes.content;
    if (name == null || content == null || content === "") continue;
    const existing = values.get(name) ?? [];
    existing.push(content);
    values.set(name, existing);
  }
  return values;
}

function first(values: Map<string, string[]>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values.get(key)?.find((candidate) => candidate !== "");
    if (value != null) return value;
  }
  return undefined;
}

function all(values: Map<string, string[]>, ...keys: string[]): string[] {
  return keys.flatMap((key) => values.get(key) ?? []).filter((value) => value !== "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return decodeHtml(value);
  if (typeof value === "number") return String(value);
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") return [decodeHtml(value)];
  if (!Array.isArray(value)) return undefined;
  const strings = value.map(asString).filter((item): item is string => item != null);
  return strings.length > 0 ? strings : undefined;
}

function jsonLdString(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct != null) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = jsonLdString(item);
      if (result != null) return result;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record == null) return undefined;
  return (
    asString(record.value) ??
    asString(record.contentUrl) ??
    asString(record.url) ??
    asString(record["@id"]) ??
    asString(record.name)
  );
}

function isScholarlyArticle(value: Record<string, unknown>): boolean {
  const types = asStringArray(value["@type"]) ?? [];
  return types.some((type) =>
    /^(?:scholarlyarticle|article|medicalscholarlyarticle)$/iu.test(type),
  );
}

function findScholarlyArticle(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findScholarlyArticle(child);
      if (found != null) return found;
    }
    return null;
  }

  const record = asRecord(value);
  if (record == null) return null;
  if (isScholarlyArticle(record)) return record;
  return findScholarlyArticle(record["@graph"]);
}

function extractJsonLd(html: string): Record<string, unknown> | null {
  const pattern = /<script\b([^>]*?)>([\s\S]*?)<\/script\s*>/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = parseAttributes(match[1] ?? "");
    if (attributes.type?.toLowerCase() !== "application/ld+json") continue;
    try {
      const article = findScholarlyArticle(JSON.parse(match[2] ?? "null") as unknown);
      if (article != null) return article;
    } catch {
      // Invalid third-party JSON-LD must not prevent citation-meta extraction.
    }
  }
  return null;
}

function authorFromJsonLd(value: unknown): MetadataAuthor | null {
  if (typeof value === "string" && value.trim() !== "") return { displayName: decodeHtml(value) };
  const record = asRecord(value);
  if (record == null) return null;
  const givenName = asString(record.givenName);
  const familyName = asString(record.familyName);
  const displayName =
    asString(record.name) ??
    [givenName, familyName]
      .filter((part) => part != null)
      .join(" ")
      .trim();
  if (displayName === "") return null;
  const author: MetadataAuthor = { displayName };
  if (givenName != null) author.givenName = givenName;
  if (familyName != null) author.familyName = familyName;
  const orcid = asString(record.identifier);
  if (orcid != null && /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/u.test(orcid)) author.orcid = orcid;
  return author;
}

function jsonLdAuthors(article: Record<string, unknown> | null): MetadataAuthor[] {
  if (article == null) return [];
  const raw = Array.isArray(article.author) ? article.author : [article.author];
  return raw.map(authorFromJsonLd).filter((author): author is MetadataAuthor => author != null);
}

function uniqueAuthors(authors: readonly MetadataAuthor[]): MetadataAuthor[] {
  const seen = new Set<string>();
  return authors.filter((author) => {
    const key = author.displayName.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveUrl(value: string | undefined, pageUrl: string | undefined): string | undefined {
  if (value == null) return undefined;
  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function assignIfDefined<Key extends keyof BibliographicMetadata>(
  target: BibliographicMetadata,
  key: Key,
  value: BibliographicMetadata[Key] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/** Extracts Highwire/Citation, Dublin Core, and ScholarlyArticle JSON-LD without Node APIs. */
export function extractWebpageMetadata(html: string, pageUrl?: string): MetadataCandidate {
  const meta = collectMeta(html);
  const jsonLd = extractJsonLd(html);
  const metadata: BibliographicMetadata = {};

  const metaAuthors = all(meta, "citation_author", "dc.creator", "dcterms.creator").map(
    (displayName) => ({ displayName }),
  );
  const authors = uniqueAuthors(metaAuthors.length > 0 ? metaAuthors : jsonLdAuthors(jsonLd));
  const publicationDate =
    first(meta, "citation_publication_date", "citation_date", "dc.date", "dcterms.date") ??
    asString(jsonLd?.datePublished);
  const venue =
    first(meta, "citation_journal_title", "citation_conference_title") ??
    jsonLdString(asRecord(jsonLd?.isPartOf)?.name ?? jsonLd?.isPartOf);
  const rawIdentifier =
    first(meta, "citation_doi", "dc.identifier", "dcterms.identifier") ??
    asString(jsonLd?.doi) ??
    jsonLdString(jsonLd?.identifier);
  const doi = normalizeDoi(rawIdentifier);
  const arxivId = normalizeArxivId(
    first(meta, "citation_arxiv_id", "arxiv_id") ?? jsonLdString(jsonLd?.identifier),
  );
  const pdfUrl = resolveUrl(
    first(meta, "citation_pdf_url") ?? jsonLdString(jsonLd?.encoding),
    pageUrl,
  );
  const resolvedPageUrl = resolveUrl(pageUrl, pageUrl);

  assignIfDefined(
    metadata,
    "title",
    first(meta, "citation_title", "dc.title", "dcterms.title") ??
      asString(jsonLd?.headline) ??
      asString(jsonLd?.name),
  );
  assignIfDefined(
    metadata,
    "abstract",
    first(meta, "citation_abstract", "dc.description", "dcterms.abstract") ??
      asString(jsonLd?.abstract) ??
      asString(jsonLd?.description),
  );
  if (authors.length > 0) metadata.authors = authors;
  assignIfDefined(metadata, "publicationDate", publicationDate);
  if (publicationDate != null) {
    const yearMatch = /(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/u.exec(publicationDate);
    if (yearMatch?.[1] != null) metadata.publicationYear = Number.parseInt(yearMatch[1], 10);
  }
  assignIfDefined(metadata, "venue", venue);
  assignIfDefined(
    metadata,
    "volume",
    first(meta, "citation_volume") ?? asString(jsonLd?.volumeNumber),
  );
  assignIfDefined(
    metadata,
    "issue",
    first(meta, "citation_issue") ?? asString(jsonLd?.issueNumber),
  );
  const firstPage = first(meta, "citation_firstpage");
  const lastPage = first(meta, "citation_lastpage");
  assignIfDefined(
    metadata,
    "pages",
    first(meta, "citation_pages") ??
      (firstPage == null ? undefined : lastPage == null ? firstPage : `${firstPage}-${lastPage}`) ??
      asString(jsonLd?.pagination),
  );
  assignIfDefined(
    metadata,
    "publisher",
    first(meta, "citation_publisher", "dc.publisher") ?? jsonLdString(jsonLd?.publisher),
  );
  assignIfDefined(
    metadata,
    "language",
    first(meta, "citation_language", "dc.language") ?? asString(jsonLd?.inLanguage),
  );
  if (doi != null) metadata.doi = doi;
  if (arxivId != null) metadata.arxivId = arxivId;
  assignIfDefined(
    metadata,
    "url",
    resolvedPageUrl ?? resolveUrl(jsonLdString(jsonLd?.url ?? jsonLd?.mainEntityOfPage), pageUrl),
  );
  assignIfDefined(metadata, "pdfUrl", pdfUrl);
  const keywords = all(meta, "citation_keywords", "keywords").flatMap((value) =>
    value
      .split(/[;,]/u)
      .map((keyword) => keyword.trim())
      .filter(Boolean),
  );
  const jsonKeywords = asStringArray(jsonLd?.keywords) ?? [];
  const combinedKeywords = [...new Set([...keywords, ...jsonKeywords])];
  if (combinedKeywords.length > 0) metadata.keywords = combinedKeywords;

  return {
    metadata,
    source: "webpage",
    matchType: "structured",
    confidence: 0.9,
    retrievedAt: nowUtcIso(),
    ...(pageUrl == null ? {} : { reference: pageUrl }),
  };
}
