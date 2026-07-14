import type { PaperStatus, PaperType } from "@citera/domain";

export interface ImportedPaper {
  title: string;
  authors: Array<{ displayName: string; givenName?: string; familyName?: string }>;
  identifiers: Array<{ identifierType: "doi" | "arxiv"; value: string }>;
  tags: string[];
  abstract?: string;
  publicationYear?: number;
  publicationDate?: string;
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  language?: string;
  paperType?: PaperType;
  status?: PaperStatus;
  rating?: number;
  sourceUrl?: string;
  noteMarkdown?: string;
}

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 1_000;

const paperTypes = new Set<PaperType>([
  "article-journal",
  "paper-conference",
  "chapter",
  "book",
  "thesis",
  "preprint",
  "report",
  "dataset",
  "software",
  "other",
]);
const statuses = new Set<PaperStatus>(["inbox", "reading", "read", "archived"]);

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result || undefined;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function uniqueTexts(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed.slice(0, 100));
  }
  return output;
}

function splitNames(value: string | undefined, separator = /\s*(?:;|\band\b)\s*/iu): string[] {
  return value ? uniqueTexts(value.split(separator)) : [];
}

function normalizeUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dateParts(input: Record<string, unknown>): number[] {
  const issued = record(input.issued);
  const parts = issued["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return [];
  return parts[0].filter((part): part is number => typeof part === "number");
}

function authorsFromJson(value: unknown): ImportedPaper["authors"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return text(item) ? [{ displayName: item.trim() }] : [];
    const author = record(item);
    const givenName = text(author.givenName) ?? text(author.given);
    const familyName = text(author.familyName) ?? text(author.family);
    const displayName =
      text(author.displayName) ??
      text(author.literal) ??
      [givenName, familyName].filter(Boolean).join(" ").trim();
    return displayName
      ? [
          {
            displayName,
            ...(givenName ? { givenName } : {}),
            ...(familyName ? { familyName } : {}),
          },
        ]
      : [];
  });
}

function tagsFromJson(value: unknown): string[] {
  if (typeof value === "string") return uniqueTexts(value.split(/\s*[,;]\s*/u));
  if (!Array.isArray(value)) return [];
  return uniqueTexts(
    value.flatMap((item) => {
      if (typeof item === "string") return [item];
      const name = text(record(item).name);
      return name ? [name] : [];
    }),
  );
}

function jsonPaper(value: unknown, index: number): ImportedPaper {
  const input = record(value);
  const title = text(input.title);
  if (!title) throw new Error(`${index + 1}件目にタイトルがありません。`);
  const parts = dateParts(input);
  const publicationYear = integer(input.publicationYear, 1000, 9999) ?? parts[0];
  const publicationDate =
    text(input.publicationDate) ??
    (parts.length >= 3
      ? `${String(parts[0]).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`
      : undefined);
  const doi = text(input.doi) ?? text(input.DOI);
  const arxivId = text(input.arxivId);
  const rawType = text(input.paperType) ?? text(input.type);
  const rawStatus = text(input.status);
  const rating = integer(input.rating, 1, 5);
  const abstract = text(input.abstract)?.slice(0, 1_000_000);
  const venue = (text(input.venue) ?? text(input["container-title"]))?.slice(0, 2_000);
  const volume = text(input.volume)?.slice(0, 100);
  const issue = text(input.issue)?.slice(0, 100);
  const pages = (text(input.pages) ?? text(input.page))?.slice(0, 100);
  const publisher = text(input.publisher)?.slice(0, 2_000);
  const language = text(input.language)?.slice(0, 35);
  const sourceUrl = normalizeUrl(input.sourceUrl ?? input.URL);
  const noteMarkdown = (text(input.noteMarkdown) ?? text(input.note))?.slice(0, 1_000_000);
  return {
    title: title.slice(0, 10_000),
    authors: authorsFromJson(input.authors ?? input.author).slice(0, 200),
    identifiers: [
      ...(doi ? [{ identifierType: "doi" as const, value: doi }] : []),
      ...(arxivId ? [{ identifierType: "arxiv" as const, value: arxivId }] : []),
    ],
    tags: tagsFromJson(input.tags ?? input.keyword ?? input.keywords),
    ...(abstract ? { abstract } : {}),
    ...(publicationYear ? { publicationYear } : {}),
    ...(publicationDate && /^\d{4}-\d{2}-\d{2}$/u.test(publicationDate) ? { publicationDate } : {}),
    ...(venue ? { venue } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(publisher ? { publisher } : {}),
    ...(language ? { language } : {}),
    ...(rawType && paperTypes.has(rawType as PaperType) ? { paperType: rawType as PaperType } : {}),
    ...(rawStatus && statuses.has(rawStatus as PaperStatus)
      ? { status: rawStatus as PaperStatus }
      : {}),
    ...(rating ? { rating } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(noteMarkdown ? { noteMarkdown } : {}),
  };
}

function parseJson(input: string): ImportedPaper[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error("JSONを解析できませんでした。");
  }
  const values = Array.isArray(parsed) ? parsed : record(parsed).papers;
  if (!Array.isArray(values))
    throw new Error("JSONは論文の配列、または papers 配列を含む必要があります。");
  return values.map(jsonPaper);
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSVの引用符が閉じられていません。");
  row.push(field.replace(/\r$/u, ""));
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseCsv(input: string): ImportedPaper[] {
  const rows = parseCsvRows(input);
  const headers = rows.shift()?.map((header) => header.trim().replace(/^\uFEFF/u, ""));
  if (!headers?.includes("title")) throw new Error("CSVには title 列が必要です。");
  return rows.map((values, index) => {
    const item = Object.fromEntries(
      headers.map((header, column) => [header, values[column] ?? ""]),
    );
    return jsonPaper(
      {
        ...item,
        authors: splitNames(item.authors),
        tags: splitNames(item.tags),
        keywords: splitNames(item.keywords),
        doi: item.doi,
        arxivId: item.arxivId,
      },
      index,
    );
  });
}

function cleanBibtex(value: string): string {
  return value
    .replace(/[{}]/gu, "")
    .replace(/\\([%&#_$])/gu, "$1")
    .replace(/\\text(?:backslash|asciitilde|asciicircum)\s*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function bibtexFields(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  let cursor = body.indexOf(",") + 1;
  while (cursor > 0 && cursor < body.length) {
    while (/[,\s]/u.test(body[cursor] ?? "")) cursor += 1;
    const keyMatch = /^[A-Za-z][\w-]*/u.exec(body.slice(cursor));
    if (!keyMatch) break;
    const key = keyMatch[0].toLowerCase();
    cursor += keyMatch[0].length;
    while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
    if (body[cursor] !== "=") break;
    cursor += 1;
    while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
    const opener = body[cursor];
    let value = "";
    if (opener === "{" || opener === '"') {
      const closer = opener === "{" ? "}" : '"';
      let depth = 0;
      cursor += 1;
      while (cursor < body.length) {
        const character = body[cursor] ?? "";
        if (opener === "{" && character === "{") depth += 1;
        else if (character === closer && (opener === '"' || depth === 0)) {
          cursor += 1;
          break;
        } else if (opener === "{" && character === "}") depth -= 1;
        value += character;
        cursor += 1;
      }
    } else {
      const end = body.indexOf(",", cursor);
      value = body.slice(cursor, end < 0 ? body.length : end);
      cursor = end < 0 ? body.length : end;
    }
    result[key] = cleanBibtex(value);
  }
  return result;
}

function parseBibtex(input: string): ImportedPaper[] {
  const entries: Array<{ type: string; body: string }> = [];
  const pattern = /@([A-Za-z]+)\s*([{(])/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    const start = pattern.lastIndex;
    const opener = match[2];
    const closer = opener === "{" ? "}" : ")";
    let depth = 1;
    let cursor = start;
    for (; cursor < input.length && depth > 0; cursor += 1) {
      if (input[cursor] === opener) depth += 1;
      else if (input[cursor] === closer) depth -= 1;
    }
    if (depth !== 0) throw new Error("BibTeXエントリの括弧が閉じられていません。");
    entries.push({ type: match[1]?.toLowerCase() ?? "misc", body: input.slice(start, cursor - 1) });
    pattern.lastIndex = cursor;
  }
  return entries.map(({ type, body }, index) => {
    const fields = bibtexFields(body);
    const typeMap: Record<string, PaperType> = {
      article: "article-journal",
      inproceedings: "paper-conference",
      conference: "paper-conference",
      incollection: "chapter",
      book: "book",
      phdthesis: "thesis",
      mastersthesis: "thesis",
      techreport: "report",
      unpublished: "preprint",
    };
    return jsonPaper(
      {
        title: fields.title,
        authors: splitNames(fields.author),
        publicationYear: fields.year,
        venue: fields.journal ?? fields.booktitle,
        volume: fields.volume,
        issue: fields.number,
        pages: fields.pages,
        publisher: fields.publisher,
        doi: fields.doi,
        sourceUrl: fields.url,
        abstract: fields.abstract,
        noteMarkdown: fields.note,
        tags: fields.keywords?.split(/\s*,\s*/u),
        paperType: typeMap[type] ?? "other",
      },
      index,
    );
  });
}

function parseRis(input: string): ImportedPaper[] {
  const entries: Array<Record<string, string[]>> = [];
  let current: Record<string, string[]> = {};
  for (const line of input.split(/\r?\n/u)) {
    const match = /^([A-Z0-9]{2})\s{2}-\s?(.*)$/u.exec(line);
    if (!match?.[1]) continue;
    const tag = match[1];
    if (tag === "TY" && Object.keys(current).length) current = {};
    (current[tag] ??= []).push(match[2]?.trim() ?? "");
    if (tag === "ER") {
      entries.push(current);
      current = {};
    }
  }
  if (Object.keys(current).length) entries.push(current);
  const typeMap: Record<string, PaperType> = {
    JOUR: "article-journal",
    CPAPER: "paper-conference",
    CONF: "paper-conference",
    BOOK: "book",
    CHAP: "chapter",
    THES: "thesis",
    RPRT: "report",
    UNPB: "preprint",
    DATA: "dataset",
  };
  return entries.map((entry, index) =>
    jsonPaper(
      {
        title: entry.TI?.[0] ?? entry.T1?.[0],
        authors: entry.AU ?? entry.A1 ?? [],
        publicationYear: /^\d{4}/u.exec(entry.PY?.[0] ?? entry.Y1?.[0] ?? "")?.[0],
        venue: entry.JO?.[0] ?? entry.JF?.[0] ?? entry.T2?.[0],
        volume: entry.VL?.[0],
        issue: entry.IS?.[0],
        pages: [entry.SP?.[0], entry.EP?.[0]].filter(Boolean).join("-") || undefined,
        publisher: entry.PB?.[0],
        doi: entry.DO?.[0],
        sourceUrl: entry.UR?.[0],
        abstract: entry.AB?.[0],
        noteMarkdown: entry.N1?.join("\n"),
        tags: entry.KW ?? [],
        paperType: typeMap[entry.TY?.[0] ?? ""] ?? "other",
      },
      index,
    ),
  );
}

export function parseCitationText(input: string, fileName: string): ImportedPaper[] {
  const extension = fileName.toLowerCase().split(".").pop();
  const papers =
    extension === "bib" || extension === "bibtex"
      ? parseBibtex(input)
      : extension === "ris"
        ? parseRis(input)
        : extension === "csv"
          ? parseCsv(input)
          : extension === "json"
            ? parseJson(input)
            : (() => {
                throw new Error("対応形式は BibTeX、RIS、CSV、JSON です。");
              })();
  if (papers.length === 0) throw new Error("インポートできる論文が見つかりませんでした。");
  if (papers.length > MAX_IMPORT_RECORDS) {
    throw new Error(`一度にインポートできるのは${MAX_IMPORT_RECORDS}件までです。`);
  }
  return papers;
}

export async function parseCitationFile(file: File): Promise<ImportedPaper[]> {
  if (file.size > MAX_IMPORT_BYTES)
    throw new Error("インポートファイルは5 MiB以下にしてください。");
  return parseCitationText(await file.text(), file.name);
}

export function resolveImportedTagIds(
  tagNames: string[],
  knownTagsByName: ReadonlyMap<string, { id: string }>,
): { tagIds: string[]; ignoredTagNames: string[] } {
  const tagIds = new Set<string>();
  const ignoredTagNames = new Set<string>();
  for (const rawName of tagNames) {
    const name = rawName.trim();
    if (!name) continue;
    const tag = knownTagsByName.get(name.toLocaleLowerCase());
    if (tag) tagIds.add(tag.id);
    else ignoredTagNames.add(name);
  }
  return { tagIds: [...tagIds], ignoredTagNames: [...ignoredTagNames] };
}
