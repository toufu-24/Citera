import type { DetectedSource, ExtractedAuthor, PageMetadata } from "../types";
import { parseSafeRemoteUrl, resolveSafeRemoteUrl } from "../lib/remote-url";

const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/iu;
const ARXIV_PATTERN =
  /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?)/iu;

interface StructuredMetadata {
  title?: string;
  authors: ExtractedAuthor[];
  publicationDate?: string;
  publicationYear?: number;
  venue?: string;
  abstract?: string;
  doi?: string;
  arxivId?: string;
  pdfUrl?: string;
  keywords: string[];
}

function metadataNames(document: Document): string[] {
  return [...document.querySelectorAll("meta")]
    .map((element) => element.getAttribute("name") ?? element.getAttribute("property") ?? "")
    .map((name) => name.toLowerCase());
}

function readMeta(document: Document, names: readonly string[]): string | undefined {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  for (const element of document.querySelectorAll("meta")) {
    const name = (
      element.getAttribute("name") ??
      element.getAttribute("property") ??
      ""
    ).toLowerCase();
    const content = element.getAttribute("content")?.trim();
    if (expected.has(name) && content != null && content !== "") return content;
  }
  return undefined;
}

function readAllMeta(document: Document, names: readonly string[]): string[] {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return [...document.querySelectorAll("meta")]
    .filter((element) => {
      const name = (
        element.getAttribute("name") ??
        element.getAttribute("property") ??
        ""
      ).toLowerCase();
      return expected.has(name);
    })
    .map((element) => element.getAttribute("content")?.trim())
    .filter((content): content is string => content != null && content !== "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function jsonLdValue(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct != null) return direct;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = jsonLdValue(child);
      if (found != null) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  return record == null
    ? undefined
    : (asString(record.contentUrl) ??
        asString(record.value) ??
        asString(record.url) ??
        asString(record["@id"]) ??
        asString(record.name));
}

function jsonLdTypes(record: Record<string, unknown>): string[] {
  const value = record["@type"];
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function findScholarlyArticle(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const result = findScholarlyArticle(child);
      if (result != null) return result;
    }
    return null;
  }
  const record = asRecord(value);
  if (record == null) return null;
  if (
    jsonLdTypes(record).some((type) =>
      /^(?:ScholarlyArticle|MedicalScholarlyArticle)$/iu.test(type),
    )
  ) {
    return record;
  }
  return findScholarlyArticle(record["@graph"]);
}

function readJsonLd(document: Document): Record<string, unknown> | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  )) {
    try {
      const article = findScholarlyArticle(JSON.parse(script.textContent ?? "null") as unknown);
      if (article != null) return article;
    } catch {
      // Invalid third-party JSON-LD must not block the remaining extraction strategies.
    }
  }
  return null;
}

function jsonLdAuthors(article: Record<string, unknown> | null): ExtractedAuthor[] {
  if (article == null) return [];
  const values = Array.isArray(article.author) ? article.author : [article.author];
  return values.flatMap((value): ExtractedAuthor[] => {
    const direct = asString(value);
    if (direct != null) return [{ displayName: direct }];
    const record = asRecord(value);
    if (record == null) return [];
    const givenName = asString(record.givenName);
    const familyName = asString(record.familyName);
    const displayName =
      asString(record.name) ?? [givenName, familyName].filter(Boolean).join(" ").trim();
    if (displayName === "") return [];
    return [
      {
        displayName,
        ...(givenName == null ? {} : { givenName }),
        ...(familyName == null ? {} : { familyName }),
      },
    ];
  });
}

function uniqueAuthors(authors: ExtractedAuthor[]): ExtractedAuthor[] {
  const seen = new Set<string>();
  return authors.filter((author) => {
    const key = author.displayName.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripUnbalancedTrailingBrackets(value: string): string {
  let result = value;
  for (const [opening, closing] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (
      result.endsWith(closing) &&
      result.split(closing).length > result.split(opening).length
    ) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

function normalizeDoi(input: string | undefined): string | undefined {
  if (input == null) return undefined;
  const decoded = safelyDecode(input);
  const match = DOI_PATTERN.exec(decoded)?.[0] ?? decoded;
  const value = stripUnbalancedTrailingBrackets(
    match
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/^doi\s*:\s*/iu, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
      .replace(/[\s.,;:]+$/u, ""),
  );
  return /^10\.\d{4,9}\/\S+$/u.test(value) ? value : undefined;
}

function normalizeArxivId(input: string | undefined): string | undefined {
  if (input == null) return undefined;
  const match = ARXIV_PATTERN.exec(input)?.[1] ?? input;
  const value = match
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^arxiv\s*:\s*/iu, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//iu, "")
    .replace(/[?#].*$/u, "")
    .replace(/\.pdf$/u, "")
    .replace(/v\d+$/u, "")
    .replace(/[\s.,;:]+$/u, "");
  return /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})$/u.test(value) ? value : undefined;
}

function jsonKeywords(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((item) =>
    typeof item === "string"
      ? item
          .split(/[;,]/u)
          .map((keyword) => keyword.trim())
          .filter(Boolean)
      : [],
  );
}

function structuredMetadata(document: Document): StructuredMetadata {
  const jsonLd = readJsonLd(document);
  const metaAuthors = readAllMeta(document, [
    "citation_author",
    "dc.creator",
    "dcterms.creator",
  ]).map((displayName) => ({ displayName }));
  const publicationDate =
    readMeta(document, ["citation_publication_date", "citation_date", "dc.date", "dcterms.date"]) ??
    asString(jsonLd?.datePublished);
  const yearMatch =
    publicationDate == null
      ? undefined
      : /(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/u.exec(publicationDate)?.[1];
  const jsonPart = asRecord(jsonLd?.isPartOf);
  const rawKeywords = readAllMeta(document, ["citation_keywords", "keywords"]).flatMap((value) =>
    value
      .split(/[;,]/u)
      .map((keyword) => keyword.trim())
      .filter(Boolean),
  );
  const title =
    readMeta(document, ["citation_title", "dc.title", "dcterms.title"]) ??
    asString(jsonLd?.headline) ??
    asString(jsonLd?.name);
  const venue =
    readMeta(document, ["citation_journal_title", "citation_conference_title"]) ??
    asString(jsonPart?.name);
  const abstract =
    readMeta(document, ["citation_abstract", "dc.description", "dcterms.abstract"]) ??
    asString(jsonLd?.abstract) ??
    asString(jsonLd?.description);
  const doi =
    readMeta(document, ["citation_doi", "dc.identifier", "dcterms.identifier"]) ??
    asString(jsonLd?.doi) ??
    jsonLdValue(jsonLd?.identifier);
  const arxivId =
    readMeta(document, ["citation_arxiv_id", "arxiv_id"]) ?? jsonLdValue(jsonLd?.identifier);
  const pdfUrl = readMeta(document, ["citation_pdf_url"]) ?? jsonLdValue(jsonLd?.encoding);
  return {
    ...(title == null ? {} : { title }),
    authors: uniqueAuthors(metaAuthors.length === 0 ? jsonLdAuthors(jsonLd) : metaAuthors),
    ...(publicationDate == null ? {} : { publicationDate }),
    ...(yearMatch == null ? {} : { publicationYear: Number.parseInt(yearMatch, 10) }),
    ...(venue == null ? {} : { venue }),
    ...(abstract == null ? {} : { abstract }),
    ...(doi == null ? {} : { doi }),
    ...(arxivId == null ? {} : { arxivId }),
    ...(pdfUrl == null ? {} : { pdfUrl }),
    keywords: [...new Set([...rawKeywords, ...jsonKeywords(jsonLd?.keywords)])],
  };
}

function safeHttpUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (value == null || value.trim() === "") return undefined;
  try {
    return resolveSafeRemoteUrl(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function bodySample(document: Document): string {
  return (document.body?.textContent ?? "").slice(0, 250_000);
}

function detectDoi(
  document: Document,
  pageUrl: string,
  structured: string | undefined,
): string | undefined {
  const candidates = [
    structured,
    readMeta(document, ["citation_doi", "dc.identifier", "dcterms.identifier"]),
    pageUrl,
    DOI_PATTERN.exec(bodySample(document))?.[0],
  ];
  for (const candidate of candidates) {
    const found = normalizeDoi(candidate);
    if (found != null) return found;
  }
  return undefined;
}

function detectArxiv(
  document: Document,
  pageUrl: string,
  structured: string | undefined,
): string | undefined {
  const candidates = [
    structured,
    readMeta(document, ["citation_arxiv_id", "arxiv_id", "dc.identifier"]),
    pageUrl,
    ARXIV_PATTERN.exec(bodySample(document))?.[0],
  ];
  for (const candidate of candidates) {
    const found = normalizeArxivId(candidate);
    if (found != null) return found;
  }
  return undefined;
}

function pdfLinkFromDocument(document: Document, pageUrl: string): string | undefined {
  const typedLink = document.querySelector<HTMLLinkElement>('link[type="application/pdf"][href]');
  const typedUrl = safeHttpUrl(typedLink?.href, pageUrl);
  if (typedUrl != null) return typedUrl;

  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
  const scored = links
    .map((link) => {
      const url = safeHttpUrl(link.href, pageUrl);
      if (url == null) return null;
      const pathLooksPdf = /\.pdf(?:$|[?#])/iu.test(url);
      const semanticPdf = /\bpdf\b/iu.test(
        `${link.textContent ?? ""} ${link.getAttribute("title") ?? ""}`,
      );
      if (!pathLooksPdf && !semanticPdf) return null;
      return { url, score: (pathLooksPdf ? 2 : 0) + (semanticPdf ? 1 : 0) };
    })
    .filter((item): item is { url: string; score: number } => item != null)
    .sort((left, right) => right.score - left.score);
  return scored[0]?.url;
}

function titleFromUrl(pageUrl: string): string {
  try {
    const segment = new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1) ?? "PDF";
    return (
      decodeURIComponent(segment)
        .replace(/\.pdf$/iu, "")
        .replace(/[-_]+/gu, " ")
        .trim() || "PDF"
    );
  } catch {
    return "Untitled paper";
  }
}

export function extractDocumentMetadata(
  document: Document,
  pageUrl: string,
  contentType = document.contentType,
): PageMetadata {
  const normalizedPageUrl = parseSafeRemoteUrl(pageUrl, "ページURL").toString();
  const metadata = structuredMetadata(document);
  const names = metadataNames(document);
  const detectedSources: DetectedSource[] = [];
  if (names.some((name) => name.startsWith("citation_"))) detectedSources.push("citation");
  if (
    names.some((name) => name === "dc" || name.startsWith("dc.") || name.startsWith("dcterms."))
  ) {
    detectedSources.push("dublin-core");
  }
  if (
    [...document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')].some(
      (script) => /ScholarlyArticle/iu.test(script.textContent ?? ""),
    )
  ) {
    detectedSources.push("json-ld");
  }

  const doi = detectDoi(document, normalizedPageUrl, metadata.doi);
  const arxivId = detectArxiv(document, normalizedPageUrl, metadata.arxivId);
  if (doi != null) detectedSources.push("doi");
  if (arxivId != null) detectedSources.push("arxiv");

  const isPdf =
    contentType.toLowerCase().includes("application/pdf") ||
    /\.pdf(?:$|[?#])/iu.test(normalizedPageUrl);
  const pdfUrl =
    safeHttpUrl(metadata.pdfUrl, normalizedPageUrl) ??
    (isPdf
      ? safeHttpUrl(normalizedPageUrl, normalizedPageUrl)
      : pdfLinkFromDocument(document, normalizedPageUrl));
  if (pdfUrl != null) detectedSources.push("pdf");

  const title = metadata.title?.trim() || document.title.trim() || titleFromUrl(normalizedPageUrl);
  return {
    title,
    authors: metadata.authors,
    ...(metadata.publicationYear == null ? {} : { publicationYear: metadata.publicationYear }),
    ...(metadata.publicationDate == null ? {} : { publicationDate: metadata.publicationDate }),
    ...(metadata.venue == null ? {} : { venue: metadata.venue }),
    ...(metadata.abstract == null ? {} : { abstract: metadata.abstract }),
    ...(doi == null ? {} : { doi }),
    ...(arxivId == null ? {} : { arxivId }),
    pageUrl: normalizedPageUrl,
    ...(pdfUrl == null ? {} : { pdfUrl }),
    keywords: metadata.keywords,
    detectedSources: [...new Set(detectedSources)],
    isPdf,
  };
}
