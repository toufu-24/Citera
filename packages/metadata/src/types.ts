export type MetadataSourceType =
  "user" | "crossref" | "openalex" | "arxiv" | "webpage" | "pdf" | "import" | "fuzzy";

export type MetadataMatchType =
  "user" | "exact-identifier" | "structured" | "embedded" | "import" | "fuzzy";

export interface MetadataAuthor {
  displayName: string;
  givenName?: string;
  familyName?: string;
  orcid?: string;
}

export interface BibliographicMetadata {
  title?: string;
  abstract?: string;
  authors?: MetadataAuthor[];
  publicationDate?: string;
  publicationYear?: number;
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  language?: string;
  paperType?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  pdfUrl?: string;
  keywords?: string[];
}

export type MetadataField = keyof BibliographicMetadata;

export interface MetadataCandidate {
  metadata: BibliographicMetadata;
  source: MetadataSourceType;
  matchType: MetadataMatchType;
  confidence: number;
  fieldConfidences?: Partial<Record<MetadataField, number>>;
  retrievedAt: string;
  reference?: string;
}

export interface MetadataIdentifier {
  type: "doi" | "arxiv" | "pmid" | "openalex" | "isbn" | "url";
  value: string;
}

export interface MetadataSearchQuery {
  title: string;
  authors?: string[];
  publicationYear?: number;
  venue?: string;
}

export interface MetadataProviderContext {
  signal?: AbortSignal;
  locale?: string;
}

/** Adapter contract shared by Crossref, OpenAlex, arXiv, and future providers. */
export interface MetadataProvider<RawResult = unknown> {
  readonly id: string;
  lookupByIdentifier(
    identifier: MetadataIdentifier,
    context?: MetadataProviderContext,
  ): Promise<MetadataCandidate | null>;
  search(
    query: MetadataSearchQuery,
    context?: MetadataProviderContext,
  ): Promise<MetadataCandidate[]>;
  normalize(result: RawResult): MetadataCandidate | null;
}
