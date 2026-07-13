import type { JobMessage } from "./types";

export function jobIdempotencyKey(job: JobMessage): string {
  const entity = job.exportId ?? job.fileId ?? job.paperId ?? job.userId;
  return `${job.type}:${entity}:${job.sourceVersion}`;
}

export function retryDelaySeconds(attempt: number, maximum = 3_600): number {
  return Math.min(maximum, 2 ** Math.min(Math.max(1, attempt), 12));
}

export function shouldRetry(
  transient: boolean,
  attempts: number,
  maximumAttempts: number,
): boolean {
  return transient && attempts < maximumAttempts;
}
