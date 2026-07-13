export type JobType =
  | "paper.enrich"
  | "pdf.verify"
  | "pdf.extract"
  | "search.reindex"
  | "export.generate"
  | "metadata.refresh"
  | "account.delete"
  | "object.cleanup";

export interface JobMessage {
  jobId: string;
  type: JobType;
  userId: string;
  paperId?: string;
  fileId?: string;
  exportId?: string;
  sourceVersion: number;
  attempt: number;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  JOBS: Queue<JobMessage>;
  ENVIRONMENT: string;
  APP_ORIGIN: string;
  ALLOWED_ORIGINS: string;
  EXTENSION_REDIRECT_ORIGINS?: string;
  ALLOWED_EXTENSION_IDS?: string;
  AUTH_DEV_BYPASS?: string;
  OWNER_EMAIL?: string;
  DEV_AUTH_TOKEN?: string;
  TOKEN_HASH_PEPPER: string;
  IP_HASH_SALT?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  MAX_PDF_BYTES?: string;
  MAX_USER_STORAGE_BYTES?: string;
  MAX_EXPORT_BYTES?: string;
  PRESIGN_TTL_SECONDS?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthSession {
  id: string;
  via: "cookie" | "bearer";
}

export interface AppBindings {
  Bindings: Env;
  Variables: {
    requestId: string;
    user: AuthUser;
    session: AuthSession;
  };
}
