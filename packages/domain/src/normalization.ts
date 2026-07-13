export interface ParsedArxivId {
  id: string;
  version: number | null;
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripUnbalancedTrailingBrackets(value: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  let result = value;

  for (const [opening, closing] of pairs) {
    while (
      result.endsWith(closing) &&
      result.split(closing).length > result.split(opening).length
    ) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

/** Returns the DOI registrant/suffix form, or `null` when the input is not a DOI. */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (input == null) return null;

  let value = safelyDecode(input).normalize("NFKC").trim().toLowerCase();
  value = value
    .replace(/^doi\s*:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim()
    .replace(/[\s.,;:]+$/u, "");
  value = stripUnbalancedTrailingBrackets(value);

  return /^10\.\d{4,9}\/\S+$/u.test(value) ? value : null;
}

/** Parses both modern (`2401.12345v2`) and legacy (`hep-th/9901001v3`) arXiv IDs. */
export function parseArxivId(input: string | null | undefined): ParsedArxivId | null {
  if (input == null) return null;

  const value = safelyDecode(input)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^arxiv\s*:\s*/i, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/[?#].*$/u, "")
    .replace(/\.pdf$/u, "")
    .replace(/[\s.,;:]+$/u, "");

  const match = /^(\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v(\d+))?$/u.exec(value);
  if (match?.[1] == null) return null;

  return {
    id: match[1],
    version: match[2] == null ? null : Number.parseInt(match[2], 10),
  };
}

/** Normalizes an arXiv ID and intentionally drops its version suffix. */
export function normalizeArxivId(input: string | null | undefined): string | null {
  return parseArxivId(input)?.id ?? null;
}

/** Normalization used by tag uniqueness constraints. */
export function normalizeTag(input: string): string {
  return input.normalize("NFKC").trim().replace(/^#+/u, "").replace(/\s+/gu, " ").toLowerCase();
}

/** Stable normalization for fuzzy comparisons; it does not transliterate non-Latin text. */
export function normalizeComparableText(input: string): string {
  return input
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeUrl(input: string | null | undefined): string | null {
  if (input == null || input.trim() === "") return null;
  try {
    const url = new URL(input.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return null;
  }
}
