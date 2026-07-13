export interface VersionedValue<Value> {
  value: Value;
  version: number;
  updatedAt: string;
  source?: "user" | "automatic";
  deletedAt?: string | null;
}

export interface ConflictResolution<Value> {
  strategy: "local" | "remote" | "merged" | "conflict-copy" | "tombstone";
  winner: VersionedValue<Value>;
}

function compareVersioned<Value>(
  local: VersionedValue<Value>,
  remote: VersionedValue<Value>,
): number {
  const timestampOrder = local.updatedAt.localeCompare(remote.updatedAt);
  if (timestampOrder !== 0) return timestampOrder;
  const versionOrder = local.version - remote.version;
  if (versionOrder !== 0) return versionOrder;
  return stableValueKey(local.value).localeCompare(stableValueKey(remote.value));
}

function stableValueKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValueKey).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValueKey(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** Last-write-wins for status/rating: UTC time first, then version as deterministic tie-breaker. */
export function resolveLastWriteWins<Value>(
  local: VersionedValue<Value>,
  remote: VersionedValue<Value>,
): ConflictResolution<Value> {
  return compareVersioned(local, remote) >= 0
    ? { strategy: "local", winner: local }
    : { strategy: "remote", winner: remote };
}

/** User-edited bibliography is never replaced by an automatic metadata refresh. */
export function resolveMetadataConflict<Value>(
  local: VersionedValue<Value>,
  remote: VersionedValue<Value>,
): ConflictResolution<Value> {
  if (local.source === "user" && remote.source !== "user") {
    return { strategy: "local", winner: local };
  }
  if (remote.source === "user" && local.source !== "user") {
    return { strategy: "remote", winner: remote };
  }
  return resolveLastWriteWins(local, remote);
}

export interface TagOperation {
  tagId: string;
  action: "add" | "remove";
  occurredAt: string;
  version: number;
  clientMutationId?: string;
}

function compareTagOperations(left: TagOperation, right: TagOperation): number {
  const timestamp = left.occurredAt.localeCompare(right.occurredAt);
  if (timestamp !== 0) return timestamp;
  const version = left.version - right.version;
  if (version !== 0) return version;
  const mutationId = (left.clientMutationId ?? "").localeCompare(right.clientMutationId ?? "");
  if (mutationId !== 0) return mutationId;
  if (left.action === right.action) return 0;
  return left.action === "remove" ? 1 : -1;
}

/** Merges add/remove at tag granularity instead of applying entity-level last-write-wins. */
export function mergeTagOperations(
  local: readonly TagOperation[],
  remote: readonly TagOperation[],
): TagOperation[] {
  const latest = new Map<string, TagOperation>();
  for (const operation of [...local, ...remote]) {
    const previous = latest.get(operation.tagId);
    if (previous == null || compareTagOperations(previous, operation) <= 0) {
      latest.set(operation.tagId, operation);
    }
  }
  return [...latest.values()].sort(compareTagOperations);
}

export function applyTagOperations(
  initialTagIds: ReadonlySet<string> | readonly string[],
  operations: readonly TagOperation[],
): Set<string> {
  const tags = new Set(initialTagIds);
  for (const operation of [...operations].sort(compareTagOperations)) {
    if (operation.action === "add") tags.add(operation.tagId);
    else tags.delete(operation.tagId);
  }
  return tags;
}

export interface NoteValue {
  id: string;
  contentMarkdown: string;
  [key: string]: unknown;
}

export interface NoteConflictResolution extends ConflictResolution<NoteValue> {
  conflictCopy?: {
    sourceId: string;
    contentMarkdown: string;
    basedOnVersion: number;
    createdAt: string;
  };
}

/** Keeps the latest note canonical and returns the other edit as an explicit conflict-copy draft. */
export function resolveNoteConflict(
  local: VersionedValue<NoteValue>,
  remote: VersionedValue<NoteValue>,
): NoteConflictResolution {
  const deletion = resolveDeletionConflict(local, remote);
  if (deletion != null) return deletion;
  const latest = resolveLastWriteWins(local, remote);
  if (local.value.contentMarkdown === remote.value.contentMarkdown) return latest;
  const loser = latest.winner === local ? remote : local;
  return {
    strategy: "conflict-copy",
    winner: latest.winner,
    conflictCopy: {
      sourceId: loser.value.id,
      contentMarkdown: loser.value.contentMarkdown,
      basedOnVersion: loser.version,
      createdAt: latest.winner.updatedAt,
    },
  };
}

function resolveDeletionConflict<Value>(
  local: VersionedValue<Value>,
  remote: VersionedValue<Value>,
): ConflictResolution<Value> | null {
  const localDeleted = local.deletedAt != null;
  const remoteDeleted = remote.deletedAt != null;
  if (!localDeleted && !remoteDeleted) return null;
  if (localDeleted && !remoteDeleted) return { strategy: "tombstone", winner: local };
  if (remoteDeleted && !localDeleted) return { strategy: "tombstone", winner: remote };
  const deletedAtOrder = (local.deletedAt ?? "").localeCompare(remote.deletedAt ?? "");
  return {
    strategy: "tombstone",
    winner:
      deletedAtOrder === 0
        ? resolveLastWriteWins(local, remote).winner
        : deletedAtOrder > 0
          ? local
          : remote,
  };
}

/** A tombstone wins over an ordinary update, preventing an offline client from resurrecting data. */
export function resolveEntityConflict<Value>(
  local: VersionedValue<Value>,
  remote: VersionedValue<Value>,
): ConflictResolution<Value> {
  return resolveDeletionConflict(local, remote) ?? resolveLastWriteWins(local, remote);
}
