export type Row = Record<string, unknown>;

export async function first<T extends Row>(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<T | null> {
  return (
    (await db
      .prepare(sql)
      .bind(...bindings)
      .first<T>()) ?? null
  );
}

export async function all<T extends Row>(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...bindings)
      .all<T>()
  ).results;
}
