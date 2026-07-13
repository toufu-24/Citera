import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { changes, clientMutations, files, jobRuns, papers, users } from "./schema";

describe("D1 schema", () => {
  it("exports the tenant and idempotency tables used by the Workers", () => {
    expect([users, papers, files, changes, clientMutations, jobRuns].map(getTableName)).toEqual([
      "users",
      "papers",
      "files",
      "changes",
      "client_mutations",
      "job_runs",
    ]);
  });
});
