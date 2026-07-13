import { tagNames, uniqueCitationKeys } from "./common";
import type { ExportAuthor, ExportPaper } from "./types";

export interface CslJsonAuthor {
  family?: string;
  given?: string;
  literal?: string;
  ORCID?: string;
}

export interface CslJsonItem {
  id: string;
  type: string;
  title: string;
  author?: CslJsonAuthor[];
  issued?: { "date-parts": number[][] };
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  language?: string;
  DOI?: string;
  URL?: string;
  abstract?: string;
  keyword?: string;
}

function cslType(paperType: string | null | undefined): string {
  switch (paperType) {
    case "paper-conference":
      return "paper-conference";
    case "book":
      return "book";
    case "chapter":
      return "chapter";
    case "thesis":
      return "thesis";
    case "report":
      return "report";
    case "dataset":
      return "dataset";
    case "software":
      return "software";
    default:
      return "article-journal";
  }
}

function cslAuthor(author: ExportAuthor): CslJsonAuthor {
  const result: CslJsonAuthor = {};
  if (author.familyName != null) result.family = author.familyName;
  if (author.givenName != null) result.given = author.givenName;
  if (result.family == null && result.given == null) result.literal = author.displayName;
  if (author.orcid != null) result.ORCID = author.orcid;
  return result;
}

function issued(paper: ExportPaper): { "date-parts": number[][] } | undefined {
  if (paper.publicationDate != null) {
    const parts = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/u.exec(paper.publicationDate);
    if (parts?.[1] != null) {
      return {
        "date-parts": [
          [parts[1], parts[2], parts[3]]
            .filter((part): part is string => part != null)
            .map((part) => Number.parseInt(part, 10)),
        ],
      };
    }
  }
  return paper.publicationYear == null ? undefined : { "date-parts": [[paper.publicationYear]] };
}

export function toCslJson(papers: readonly ExportPaper[]): CslJsonItem[] {
  const keys = uniqueCitationKeys(papers);
  return papers.map((paper, index) => {
    const keywords = [...new Set([...(paper.keywords ?? []), ...tagNames(paper)])];
    const issuedDate = issued(paper);
    return {
      id: keys[index] ?? paper.id,
      type: cslType(paper.paperType),
      title: paper.title,
      ...(paper.authors == null || paper.authors.length === 0
        ? {}
        : { author: paper.authors.map(cslAuthor) }),
      ...(issuedDate == null ? {} : { issued: issuedDate }),
      ...(paper.venue == null ? {} : { "container-title": paper.venue }),
      ...(paper.volume == null ? {} : { volume: paper.volume }),
      ...(paper.issue == null ? {} : { issue: paper.issue }),
      ...(paper.pages == null ? {} : { page: paper.pages }),
      ...(paper.publisher == null ? {} : { publisher: paper.publisher }),
      ...(paper.language == null ? {} : { language: paper.language }),
      ...(paper.doi == null ? {} : { DOI: paper.doi }),
      ...(paper.sourceUrl == null ? {} : { URL: paper.sourceUrl }),
      ...(paper.abstract == null ? {} : { abstract: paper.abstract }),
      ...(keywords.length === 0 ? {} : { keyword: keywords.join(", ") }),
    };
  });
}

export function exportCslJson(papers: readonly ExportPaper[]): string {
  return JSON.stringify(toCslJson(papers), null, 2);
}
