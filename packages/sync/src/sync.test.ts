import { describe, expect, it } from "vitest";

import {
  SyncMutationBatchSchema,
  acknowledgeOutbox,
  applyTagOperations,
  compactOutbox,
  enqueueOutbox,
  markOutboxAttempt,
  mergeTagOperations,
  resolveEntityConflict,
  resolveLastWriteWins,
  resolveMetadataConflict,
  resolveNoteConflict,
  selectReadyOutbox,
  toOutboxMutation,
} from "./index";
import type { SyncMutation, TagOperation } from "./index";

const mutation = (
  id: string,
  payload: Record<string, unknown> = { status: "reading" },
): SyncMutation => ({
  clientMutationId: id,
  entityType: "paper",
  entityId: "pap_01JTEST0000000000000000000",
  operation: "update",
  baseVersion: 2,
  payload,
  createdAt: "2026-07-13T00:00:00.000Z",
});

describe("outbox", () => {
  it("enqueues idempotently, compacts untouched updates, and acknowledges IDs", () => {
    let outbox = enqueueOutbox([], mutation("m1", { status: "reading" }));
    outbox = enqueueOutbox(outbox, mutation("m1", { status: "read" }));
    outbox = enqueueOutbox(outbox, {
      ...mutation("m2", { rating: 5 }),
      createdAt: "2026-07-13T00:01:00.000Z",
    });
    expect(outbox).toHaveLength(2);
    const compacted = compactOutbox(outbox);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      clientMutationId: "m2",
      baseVersion: 2,
      payload: { status: "reading", rating: 5 },
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    expect(acknowledgeOutbox(compacted, ["m2"])).toEqual([]);
  });

  it("applies bounded exponential retry and selects only ready mutations", () => {
    const attempted = markOutboxAttempt(
      toOutboxMutation(mutation("m1")),
      "2026-07-13T00:00:00.000Z",
      "offline",
    );
    expect(attempted).toMatchObject({
      attempts: 1,
      nextAttemptAt: "2026-07-13T00:00:01.000Z",
      lastError: "offline",
    });
    expect(selectReadyOutbox([attempted], "2026-07-13T00:00:00.500Z")).toEqual([]);
    expect(selectReadyOutbox([attempted], "2026-07-13T00:00:01.000Z")).toEqual([attempted]);
  });

  it("validates batches and caps them at 100 operations", () => {
    expect(SyncMutationBatchSchema.safeParse({ mutations: [mutation("m1")] }).success).toBe(true);
    expect(
      SyncMutationBatchSchema.safeParse({
        mutations: Array.from({ length: 101 }, (_, index) => mutation(`m${index}`)),
      }).success,
    ).toBe(false);
  });

  it("rejects REST-bypass payloads and unsafe source URLs", () => {
    expect(
      SyncMutationBatchSchema.safeParse({
        mutations: [mutation("m1", { status: "admin", unknownColumn: "value" })],
      }).success,
    ).toBe(false);
    expect(
      SyncMutationBatchSchema.safeParse({
        mutations: [mutation("m2", { sourceUrl: "javascript:alert(1)" })],
      }).success,
    ).toBe(false);
  });
});

describe("conflict resolution", () => {
  const local = {
    value: "reading",
    version: 4,
    updatedAt: "2026-07-13T00:00:00.000Z",
  } as const;
  const remote = {
    value: "read",
    version: 5,
    updatedAt: "2026-07-13T00:01:00.000Z",
  } as const;

  it("uses timestamp/version for scalar values and protects user metadata", () => {
    expect(resolveLastWriteWins(local, remote)).toEqual({ strategy: "remote", winner: remote });
    expect(
      resolveMetadataConflict(
        { ...local, value: "Correct title", source: "user" },
        { ...remote, value: "Provider title", source: "automatic" },
      ).winner.value,
    ).toBe("Correct title");
  });

  it("merges tag add/remove operations per tag", () => {
    const operations: TagOperation[] = mergeTagOperations(
      [
        {
          tagId: "tag_a",
          action: "add",
          occurredAt: "2026-07-13T00:00:00.000Z",
          version: 1,
        },
        {
          tagId: "tag_b",
          action: "add",
          occurredAt: "2026-07-13T00:00:00.000Z",
          version: 1,
        },
      ],
      [
        {
          tagId: "tag_a",
          action: "remove",
          occurredAt: "2026-07-13T00:02:00.000Z",
          version: 2,
        },
      ],
    );
    expect([...applyTagOperations([], operations)]).toEqual(["tag_b"]);
  });

  it("uses deterministic tie-breakers independent of replica order", () => {
    const add = {
      tagId: "tag_a",
      action: "add",
      occurredAt: "2026-07-13T00:00:00.000Z",
      version: 1,
    } as const;
    const remove = { ...add, action: "remove" } as const;
    expect(mergeTagOperations([add], [remove])).toEqual([remove]);
    expect(mergeTagOperations([remove], [add])).toEqual([remove]);

    const tiedLocal = { ...local, value: "read" };
    const tiedRemote = { ...local, value: "archived" };
    expect(resolveLastWriteWins(tiedLocal, tiedRemote).winner.value).toBe(
      resolveLastWriteWins(tiedRemote, tiedLocal).winner.value,
    );
  });

  it("creates a conflict copy for divergent notes instead of overwriting", () => {
    const resolution = resolveNoteConflict(
      {
        value: { id: "not_1", contentMarkdown: "offline edit" },
        version: 2,
        updatedAt: "2026-07-13T00:01:00.000Z",
      },
      {
        value: { id: "not_1", contentMarkdown: "remote edit" },
        version: 3,
        updatedAt: "2026-07-13T00:02:00.000Z",
      },
    );
    expect(resolution.strategy).toBe("conflict-copy");
    expect(resolution.winner.value.contentMarkdown).toBe("remote edit");
    expect(resolution.conflictCopy?.contentMarkdown).toBe("offline edit");
  });

  it("preserves tombstones against later ordinary updates", () => {
    const deleted = { ...local, deletedAt: "2026-07-13T00:00:01.000Z" };
    expect(resolveEntityConflict(deleted, remote)).toEqual({
      strategy: "tombstone",
      winner: deleted,
    });
  });
});
