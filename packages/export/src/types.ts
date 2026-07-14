export type ExportFormat = "bibtex" | "csl-json" | "ris" | "csv" | "json";

export interface ExportAuthor {
  displayName: string;
  givenName?: string | null;
  familyName?: string | null;
  orcid?: string | null;
}

export interface ExportPaper {
  id: string;
  citationKey?: string;
  title: string;
  authors?: ExportAuthor[];
  publicationYear?: number | null;
  publicationDate?: string | null;
  venue?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  language?: string | null;
  paperType?: string | null;
  status?: string;
  readingStatus?: string;
  rating?: number | null;
  doi?: string | null;
  arxivId?: string | null;
  sourceUrl?: string | null;
  abstract?: string | null;
  noteMarkdown?: string | null;
  keywords?: string[];
  tags?: Array<string | { name: string }>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ExportResult {
  content: string;
  mediaType: string;
  fileExtension: string;
}
