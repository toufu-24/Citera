import { all, first } from "./db";
import { parseJson } from "./utils";

export interface UserPreferences {
  defaultCollectionId: string | null;
  defaultTagIds: string[];
  defaultStatus: "inbox" | "reading" | "read" | "archived";
  defaultExportFormat: "bibtex" | "csl-json" | "ris" | "csv" | "json";
  updatedAt: string | null;
}

interface PreferenceRow extends Record<string, unknown> {
  default_collection_id: string | null;
  default_tag_ids_json: string;
  default_status: UserPreferences["defaultStatus"];
  default_export_format: UserPreferences["defaultExportFormat"];
  updated_at: string;
}

export async function readUserPreferences(
  db: D1Database,
  userId: string,
): Promise<UserPreferences> {
  const row = await first<PreferenceRow>(
    db,
    "SELECT * FROM user_preferences WHERE user_id=?",
    userId,
  );
  if (!row) {
    return {
      defaultCollectionId: null,
      defaultTagIds: [],
      defaultStatus: "inbox",
      defaultExportFormat: "bibtex",
      updatedAt: null,
    };
  }

  const requestedTagIds = [
    ...new Set(
      parseJson<unknown[]>(row.default_tag_ids_json, []).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ].slice(0, 100);
  const ownedTags = requestedTagIds.length
    ? await all<{ id: string } & Record<string, unknown>>(
        db,
        `SELECT id FROM tags WHERE user_id=? AND id IN (${requestedTagIds.map(() => "?").join(",")})`,
        userId,
        ...requestedTagIds,
      )
    : [];
  const ownedTagIds = new Set(ownedTags.map((tag) => tag.id));
  const collection = row.default_collection_id
    ? await first<Record<string, unknown>>(
        db,
        "SELECT id FROM collections WHERE id=? AND user_id=? AND deleted_at IS NULL",
        row.default_collection_id,
        userId,
      )
    : null;

  return {
    defaultCollectionId: collection ? row.default_collection_id : null,
    defaultTagIds: requestedTagIds.filter((id) => ownedTagIds.has(id)),
    defaultStatus: row.default_status,
    defaultExportFormat: row.default_export_format,
    updatedAt: row.updated_at,
  };
}
