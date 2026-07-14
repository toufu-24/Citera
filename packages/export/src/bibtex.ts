import { compactLine, tagNames, uniqueCitationKeys } from "./common";
import type { ExportAuthor, ExportPaper } from "./types";

const BIBTEX_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  _: "\\_",
  "#": "\\#",
  $: "\\$",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function escapeBibTeX(value: string): string {
  return [...compactLine(value)]
    .map((character) => BIBTEX_ESCAPES[character] ?? character)
    .join("");
}

function entryType(paperType: string | null | undefined): string {
  switch (paperType) {
    case "article-journal":
      return "article";
    case "paper-conference":
      return "inproceedings";
    case "book":
      return "book";
    case "chapter":
      return "incollection";
    case "thesis":
      return "phdthesis";
    case "report":
      return "techreport";
    default:
      return "misc";
  }
}

function bibtexAuthor(author: ExportAuthor): string {
  if (author.familyName != null && author.familyName.trim() !== "") {
    const given = author.givenName?.trim();
    return given == null || given === ""
      ? escapeBibTeX(author.familyName)
      : `${escapeBibTeX(author.familyName)}, ${escapeBibTeX(given)}`;
  }
  return escapeBibTeX(author.displayName);
}

function addField(fields: string[], name: string, value: string | number | null | undefined): void {
  if (value == null || String(value).trim() === "") return;
  fields.push(`  ${name} = {${escapeBibTeX(String(value))}}`);
}

export function exportBibTeX(papers: readonly ExportPaper[]): string {
  const keys = uniqueCitationKeys(papers);
  return papers
    .map((paper, index) => {
      const fields: string[] = [];
      addField(fields, "title", paper.title);
      if (paper.authors != null && paper.authors.length > 0) {
        fields.push(`  author = {${paper.authors.map(bibtexAuthor).join(" and ")}}`);
      }
      addField(fields, "year", paper.publicationYear);
      addField(
        fields,
        paper.paperType === "paper-conference" ? "booktitle" : "journal",
        paper.venue,
      );
      addField(fields, "volume", paper.volume);
      addField(fields, "number", paper.issue);
      addField(fields, "pages", paper.pages);
      addField(fields, "publisher", paper.publisher);
      addField(fields, "doi", paper.doi);
      addField(fields, "url", paper.sourceUrl);
      addField(fields, "abstract", paper.abstract);
      addField(fields, "note", paper.noteMarkdown);
      const keywords = [...new Set([...(paper.keywords ?? []), ...tagNames(paper)])];
      if (keywords.length > 0) addField(fields, "keywords", keywords.join(", "));
      return `@${entryType(paper.paperType)}{${keys[index] ?? "item"},\n${fields.join(",\n")}\n}`;
    })
    .join("\n\n");
}
