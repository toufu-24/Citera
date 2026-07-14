import { z } from "zod";

export const JobMessageSchema = z.object({
  jobId: z.string().min(1).max(100),
  type: z.enum([
    "paper.enrich",
    "pdf.download",
    "pdf.verify",
    "pdf.extract",
    "search.reindex",
    "export.generate",
    "metadata.refresh",
    "account.delete",
    "object.cleanup",
  ]),
  userId: z.string().min(1).max(100),
  paperId: z.string().min(1).max(100).optional(),
  fileId: z.string().min(1).max(100).optional(),
  exportId: z.string().min(1).max(100).optional(),
  pdfUrl: z.string().url().max(2_048).optional(),
  pdfUrls: z.array(z.string().url().max(2_048)).max(10).optional(),
  sourceVersion: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
});

export type JobMessage = z.infer<typeof JobMessageSchema>;

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  JOBS: Queue<JobMessage>;
  ENVIRONMENT: string;
  MAX_JOB_ATTEMPTS?: string;
  MAX_BACKUP_BYTES?: string;
  PENDING_UPLOAD_TTL_SECONDS?: string;
  METADATA_CACHE_SECONDS?: string;
  CROSSREF_MAILTO?: string;
  MAX_PDF_BYTES?: string;
  MAX_USER_STORAGE_BYTES?: string;
}

export class JobError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, message: string, transient: boolean) {
    super(message);
    this.name = "JobError";
    this.code = code;
    this.transient = transient;
  }
}

export interface JobResult {
  [key: string]: unknown;
}
