import type { OutboxMutation, SyncMutation } from "./schemas";

export function toOutboxMutation(mutation: SyncMutation): OutboxMutation {
  return {
    ...mutation,
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  };
}

/** Adds a mutation idempotently without mutating the IndexedDB-compatible array. */
export function enqueueOutbox(
  outbox: readonly OutboxMutation[],
  mutation: SyncMutation | OutboxMutation,
): OutboxMutation[] {
  if (outbox.some((item) => item.clientMutationId === mutation.clientMutationId)) {
    return [...outbox];
  }
  const outboxMutation = "status" in mutation ? mutation : toOutboxMutation(mutation);
  return [...outbox, outboxMutation];
}

export function acknowledgeOutbox(
  outbox: readonly OutboxMutation[],
  clientMutationIds: ReadonlySet<string> | readonly string[],
): OutboxMutation[] {
  const acknowledged =
    clientMutationIds instanceof Set ? clientMutationIds : new Set(clientMutationIds);
  return outbox.filter((mutation) => !acknowledged.has(mutation.clientMutationId));
}

export function retryDelayMs(
  attempt: number,
  baseDelayMs = 1_000,
  maximumDelayMs = 5 * 60_000,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 30));
}

export function markOutboxAttempt(
  mutation: OutboxMutation,
  attemptedAt: string,
  error?: string,
  maximumAttempts = 8,
): OutboxMutation {
  const attempts = mutation.attempts + 1;
  const failed = attempts >= maximumAttempts;
  const nextAttemptAt = failed
    ? null
    : new Date(new Date(attemptedAt).getTime() + retryDelayMs(attempts)).toISOString();
  return {
    ...mutation,
    status: failed ? "failed" : "pending",
    attempts,
    nextAttemptAt,
    lastError: error ?? null,
  };
}

export function selectReadyOutbox(
  outbox: readonly OutboxMutation[],
  now: string,
  limit = 100,
): OutboxMutation[] {
  const nowTime = new Date(now).getTime();
  return outbox
    .filter(
      (mutation) =>
        mutation.status === "pending" &&
        (mutation.nextAttemptAt == null || new Date(mutation.nextAttemptAt).getTime() <= nowTime),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.clientMutationId.localeCompare(right.clientMutationId),
    )
    .slice(0, Math.max(0, limit));
}

/**
 * Coalesces never-attempted updates to the same entity. Once attempted, a mutation ID may
 * already have reached the server, so it is deliberately left untouched.
 */
export function compactOutbox(outbox: readonly OutboxMutation[]): OutboxMutation[] {
  const result: OutboxMutation[] = [];
  const compactableIndex = new Map<string, number>();

  for (const mutation of outbox) {
    const key = `${mutation.entityType}:${mutation.entityId}`;
    const previousIndex = compactableIndex.get(key);
    const previous = previousIndex == null ? undefined : result[previousIndex];
    const canCompact =
      mutation.operation === "update" &&
      mutation.status === "pending" &&
      mutation.attempts === 0 &&
      previous?.operation === "update" &&
      previous.status === "pending" &&
      previous.attempts === 0;

    if (canCompact && previousIndex != null && previous != null) {
      result[previousIndex] = {
        ...mutation,
        baseVersion: previous.baseVersion,
        payload: { ...previous.payload, ...mutation.payload },
        createdAt: previous.createdAt,
      };
      continue;
    }

    result.push(mutation);
    if (
      mutation.operation === "update" &&
      mutation.status === "pending" &&
      mutation.attempts === 0
    ) {
      compactableIndex.set(key, result.length - 1);
    } else {
      compactableIndex.delete(key);
    }
  }
  return result;
}
