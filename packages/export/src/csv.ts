import { tagNames } from "./common";
import type { ExportPaper } from "./types";

const COLUMNS = [
  "id",
  "title",
  "authors",
  "publicationYear",
  "publicationDate",
  "venue",
  "volume",
  "issue",
  "pages",
  "publisher",
  "paperType",
  "status",
  "readingStatus",
  "rating",
  "doi",
  "arxivId",
  "sourceUrl",
  "abstract",
  "keywords",
  "tags",
  "noteMarkdown",
] as const;

export function escapeCsv(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  const raw = String(value);
  const text = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function row(paper: ExportPaper): string[] {
  return [
    paper.id,
    paper.title,
    paper.authors?.map((author) => author.displayName).join("; ") ?? "",
    paper.publicationYear == null ? "" : String(paper.publicationYear),
    paper.publicationDate ?? "",
    paper.venue ?? "",
    paper.volume ?? "",
    paper.issue ?? "",
    paper.pages ?? "",
    paper.publisher ?? "",
    paper.paperType ?? "",
    paper.status ?? "",
    paper.readingStatus ?? "",
    paper.rating == null ? "" : String(paper.rating),
    paper.doi ?? "",
    paper.arxivId ?? "",
    paper.sourceUrl ?? "",
    paper.abstract ?? "",
    paper.keywords?.join("; ") ?? "",
    tagNames(paper).join("; "),
    paper.noteMarkdown ?? "",
  ];
}

export function exportCsv(papers: readonly ExportPaper[]): string {
  return [COLUMNS.join(","), ...papers.map((paper) => row(paper).map(escapeCsv).join(","))].join(
    "\r\n",
  );
}
