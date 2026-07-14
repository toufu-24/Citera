import { api, type SyncChange } from "./api";
import { db } from "./database";

let syncing: Promise<void> | null = null;

export type SyncStatus = "syncing" | "synced" | "offline" | "error";

async function applyChange(change: SyncChange): Promise<void> {
  const table =
    change.entityType === "paper"
      ? db.papers
      : change.entityType === "note"
        ? db.notes
        : change.entityType === "tag"
          ? db.tags
          : change.entityType === "collection"
            ? db.collections
            : null;
  if (!table) return;
  if (change.operation === "delete") {
    await table.delete(change.entityId);
  } else if (change.data) {
    if (change.entityType === "paper") {
      const current = await db.papers.get(change.entityId);
      // Paper change-log entries may be field patches. Never replace a complete
      // offline record with a partial payload; the online list fetch seeds new records.
      if (current) await db.papers.put({ ...current, ...change.data, id: change.entityId });
      return;
    }
    const current = await table.get(change.entityId);
    await table.put({ ...(current ?? {}), ...change.data, id: change.entityId } as never);
  }
}

async function performSync(): Promise<void> {
  if (!navigator.onLine) return;
  const pending = await db.outbox.orderBy("createdAt").toArray();
  if (pending.length) {
    const result = await api.mutate(pending);
    const completed = result.results
      .filter(({ status }) => status === "applied" || status === "duplicate")
      .map(({ clientMutationId }) => clientMutationId);
    if (completed.length) await db.outbox.bulkDelete(completed);
  }

  let state = (await db.syncState.get("main")) ?? {
    key: "main" as const,
    cursor: 0,
    lastSyncedAt: null,
  };
  let hasMore = true;
  while (hasMore) {
    const page = await api.sync(state.cursor);
    await db.transaction(
      "rw",
      [db.papers, db.notes, db.tags, db.collections, db.syncState],
      async () => {
        for (const change of page.changes) await applyChange(change);
        state = { key: "main", cursor: page.nextCursor, lastSyncedAt: new Date().toISOString() };
        await db.syncState.put(state);
      },
    );
    hasMore = page.hasMore;
  }
}

export function syncNow(): Promise<void> {
  syncing ??= performSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

export function installSyncTriggers(
  onStatus: (status: SyncStatus) => void = () => undefined,
): () => void {
  const run = () => {
    if (!navigator.onLine) {
      onStatus("offline");
      return;
    }
    onStatus("syncing");
    void syncNow().then(
      () => onStatus("synced"),
      () => onStatus("error"),
    );
  };
  const focus = () => document.visibilityState === "visible" && run();
  window.addEventListener("online", run);
  window.addEventListener("offline", run);
  document.addEventListener("visibilitychange", focus);
  const timer = window.setInterval(run, 60_000);
  run();
  return () => {
    window.removeEventListener("online", run);
    window.removeEventListener("offline", run);
    document.removeEventListener("visibilitychange", focus);
    window.clearInterval(timer);
  };
}
