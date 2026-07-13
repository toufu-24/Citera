import Dexie, { type EntityTable } from "dexie";

import type { NoteRecord, OutboxMutation, PaperListItem } from "./api";

export interface SyncStateRecord {
  key: "main";
  cursor: number;
  lastSyncedAt: string | null;
}

export interface OutboxRecord extends OutboxMutation {
  createdAt: string;
  attempts: number;
}

class CiteraDatabase extends Dexie {
  papers!: EntityTable<PaperListItem, "id">;
  notes!: EntityTable<NoteRecord, "id">;
  tags!: EntityTable<{ id: string; name: string; color: string | null }, "id">;
  collections!: EntityTable<{ id: string; name: string }, "id">;
  outbox!: EntityTable<OutboxRecord, "clientMutationId">;
  syncState!: EntityTable<SyncStateRecord, "key">;
  uploads!: EntityTable<{ id: string; paperId: string; progress: number; state: string }, "id">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      papers: "id, updatedAt, status, publicationYear, *tags.id",
      notes: "id, paperId, updatedAt",
      tags: "id, name",
      collections: "id, name",
      outbox: "clientMutationId, entityType, entityId, createdAt",
      syncState: "key",
      uploads: "id, paperId, state",
    });
  }
}

const ACTIVE_USER_KEY = "citera.active-user.v1";
const USER_ID_PATTERN = /^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

function storedUserId(): string | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(ACTIVE_USER_KEY);
  return value && USER_ID_PATTERN.test(value) ? value : null;
}

function databaseName(userId: string | null): string {
  return userId ? `citera-${userId}` : "citera-unbound";
}

let activeUserId = storedUserId();
export let db = new CiteraDatabase(databaseName(activeUserId));

/** Switches the offline store before any user-scoped data is read or written. */
export async function activateDatabaseForUser(userId: string): Promise<boolean> {
  if (!USER_ID_PATTERN.test(userId)) throw new TypeError("Invalid Citera user ID");
  if (activeUserId === userId) return false;
  db.close();
  activeUserId = userId;
  localStorage.setItem(ACTIVE_USER_KEY, userId);
  db = new CiteraDatabase(databaseName(userId));
  await db.open();
  return true;
}

export async function clearActiveDatabase(): Promise<void> {
  await db.delete();
  activeUserId = null;
  localStorage.removeItem(ACTIVE_USER_KEY);
  db = new CiteraDatabase(databaseName(null));
}
