import type { ExportAuthor, ExportPaper } from "./types";

export function authorDisplayName(author: ExportAuthor): string {
  return author.displayName.trim();
}

export function tagNames(paper: ExportPaper): string[] {
  return (paper.tags ?? []).map((tag) => (typeof tag === "string" ? tag : tag.name));
}

function asciiIdentifier(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/giu, "");
}

export function baseCitationKey(paper: ExportPaper): string {
  if (paper.citationKey != null && paper.citationKey.trim() !== "") {
    return asciiIdentifier(paper.citationKey) || "item";
  }
  const firstAuthor = paper.authors?.[0];
  const family =
    firstAuthor?.familyName ?? firstAuthor?.displayName.trim().split(/\s+/u).at(-1) ?? "anonymous";
  const titleWord = paper.title
    .split(/\s+/u)
    .map(asciiIdentifier)
    .find((word) => word.length >= 3 && !/^(?:the|and|for|with)$/iu.test(word));
  return `${asciiIdentifier(family) || "anonymous"}${paper.publicationYear ?? "nd"}${titleWord ?? "item"}`;
}

export function uniqueCitationKeys(papers: readonly ExportPaper[]): string[] {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  const bases = papers.map(baseCitationKey);
  for (const base of bases)
    totals.set(base.toLowerCase(), (totals.get(base.toLowerCase()) ?? 0) + 1);
  return bases.map((base) => {
    const normalized = base.toLowerCase();
    if ((totals.get(normalized) ?? 0) === 1) return base;
    const index = seen.get(normalized) ?? 0;
    seen.set(normalized, index + 1);
    return `${base}${String.fromCharCode(97 + index)}`;
  });
}

export function compactLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
