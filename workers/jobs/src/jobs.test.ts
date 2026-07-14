import { describe, expect, it } from "vitest";
import { sha256ForStream } from "./handlers";
import { JobMessageSchema, jobIdempotencyKey, retryDelaySeconds, shouldRetry } from "./index";

const job = JobMessageSchema.parse({
  jobId: "job_01J00000000000000000000000",
  type: "paper.enrich",
  userId: "usr_01J00000000000000000000000",
  paperId: "pap_01J00000000000000000000000",
  sourceVersion: 4,
  attempt: 1,
});

describe("queue job idempotency", () => {
  it("derives a stable key independent of delivery attempt and job id", () => {
    expect(jobIdempotencyKey(job)).toBe("paper.enrich:pap_01J00000000000000000000000:4");
    expect(jobIdempotencyKey({ ...job, jobId: "job_other", attempt: 3 })).toBe(
      jobIdempotencyKey(job),
    );
  });

  it("bounds exponential retry and stops permanent/exhausted jobs", () => {
    expect(retryDelaySeconds(1)).toBe(2);
    expect(retryDelaySeconds(20)).toBe(3_600);
    expect(shouldRetry(true, 4, 5)).toBe(true);
    expect(shouldRetry(true, 5, 5)).toBe(false);
    expect(shouldRetry(false, 1, 5)).toBe(false);
  });

  it("rejects unknown job types before executing", () => {
    expect(JobMessageSchema.safeParse({ ...job, type: "shell.execute" }).success).toBe(false);
  });

  it("gives each durable account-deletion recovery generation a new key", () => {
    const deletion = {
      ...job,
      type: "account.delete" as const,
      paperId: undefined,
      userId: "usr_01J00000000000000000000000",
      sourceVersion: 1,
    };
    expect(jobIdempotencyKey(deletion)).toBe("account.delete:usr_01J00000000000000000000000:1");
    expect(jobIdempotencyKey({ ...deletion, sourceVersion: 2 })).not.toBe(
      jobIdempotencyKey(deletion),
    );
  });
});

describe("streaming PDF checksum", () => {
  it("calculates SHA-256 across multiple chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode("The quick brown "), encoder.encode("fox jumps over the lazy dog")];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    await expect(sha256ForStream(stream)).resolves.toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });
});
