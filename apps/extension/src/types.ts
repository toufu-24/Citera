import type { PaperStatus } from "@citera/domain";

export type DetectedSource = "citation" | "dublin-core" | "json-ld" | "doi" | "arxiv" | "pdf";

export interface ExtractedAuthor {
  displayName: string;
  givenName?: string;
  familyName?: string;
  orcid?: string;
}

export interface PageMetadata {
  title: string;
  authors: ExtractedAuthor[];
  publicationYear?: number;
  publicationDate?: string;
  venue?: string;
  abstract?: string;
  doi?: string;
  arxivId?: string;
  pageUrl: string;
  pdfUrl?: string;
  keywords: string[];
  detectedSources: DetectedSource[];
  isPdf: boolean;
}

export interface TagChoice {
  id: string;
  name: string;
  color: string | null;
}

export interface CollectionChoice {
  id: string;
  name: string;
}

export interface LibraryChoices {
  tags: TagChoice[];
  collections: CollectionChoice[];
  preferences: {
    defaultStatus: PaperStatus;
    defaultTagIds: string[];
    defaultCollectionId: string | null;
  };
}

export interface ExtensionSettings {
  apiBaseUrl: string;
  defaultStatus: PaperStatus;
  includePdfByDefault: boolean;
  notificationsEnabled: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  expiresAt?: number;
}

export type SaveStage =
  "creating" | "downloading-pdf" | "hashing-pdf" | "uploading-pdf" | "finalizing";

export interface SavePaperInput {
  metadata: PageMetadata;
  status: PaperStatus;
  tagIds: string[];
  collectionIds: string[];
  includePdf: boolean;
  allowCrossOriginPdf: boolean;
}

export type SavePaperResult =
  | {
      outcome: "saved";
      paperId: string;
      ingestionId: string;
      pdfIncluded: boolean;
      warning?: string;
    }
  | {
      outcome: "duplicate";
      paperId?: string;
      title?: string;
      reason: string;
    };

export type ExtensionRequest =
  | { type: "AUTH_STATUS" }
  | { type: "LOGIN" }
  | { type: "LOGOUT" }
  | { type: "OPEN_OPTIONS" }
  | { type: "EXTRACT_ACTIVE_PAGE" }
  | { type: "GET_LIBRARY_CHOICES" }
  | { type: "SAVE_PAPER"; input: SavePaperInput };

export interface ProgressMessage {
  type: "SAVE_PROGRESS";
  stage: SaveStage;
  detail: string;
}

export interface ContentExtractRequest {
  type: "CITERA_EXTRACT_PAGE";
}
