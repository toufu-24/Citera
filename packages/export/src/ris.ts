import { compactLine, tagNames, uniqueCitationKeys } from "./common";
import type { ExportPaper } from "./types";

function risType(paperType: string | null | undefined): string {
  switch (paperType) {
    case "paper-conference":
      return "CPAPER";
    case "book":
      return "BOOK";
    case "chapter":
      return "CHAP";
    case "thesis":
      return "THES";
    case "report":
      return "RPRT";
    case "preprint":
      return "UNPB";
    default:
      return "JOUR";
  }
}

export function escapeRis(value: string): string {
  return compactLine(value);
}

function add(lines: string[], tag: string, value: string | number | null | undefined): void {
  if (value == null || String(value).trim() === "") return;
  lines.push(`${tag}  - ${escapeRis(String(value))}`);
}

export function exportRis(papers: readonly ExportPaper[]): string {
  const keys = uniqueCitationKeys(papers);
  return papers
    .map((paper, index) => {
      const lines = [`TY  - ${risType(paper.paperType)}`];
      add(lines, "ID", keys[index]);
      add(lines, "TI", paper.title);
      for (const author of paper.authors ?? []) add(lines, "AU", author.displayName);
      add(lines, "PY", paper.publicationYear);
      add(lines, paper.paperType === "paper-conference" ? "T2" : "JO", paper.venue);
      add(lines, "VL", paper.volume);
      add(lines, "IS", paper.issue);
      if (paper.pages != null) {
        const pageParts = /^\s*([^–—-]+)\s*[–—-]\s*(.+)\s*$/u.exec(paper.pages);
        if (pageParts?.[1] != null && pageParts[2] != null) {
          add(lines, "SP", pageParts[1]);
          add(lines, "EP", pageParts[2]);
        } else {
          add(lines, "SP", paper.pages);
        }
      }
      add(lines, "PB", paper.publisher);
      add(lines, "DO", paper.doi);
      add(lines, "UR", paper.sourceUrl);
      add(lines, "AB", paper.abstract);
      for (const keyword of [...new Set([...(paper.keywords ?? []), ...tagNames(paper)])]) {
        add(lines, "KW", keyword);
      }
      lines.push("ER  - ");
      return lines.join("\r\n");
    })
    .join("\r\n\r\n");
}
