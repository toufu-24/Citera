import { describe, expect, it } from "vitest";
import { constantTimeEqual, decodeCursor, encodeCursor, sha256Hex } from "./utils";

describe("API security utilities", () => {
  it("round trips opaque cursor data", () => {
    const input = {
      sort: "updated_at",
      direction: "DESC",
      value: "2026-07-13T00:00:00.000Z",
      id: "pap_x",
    };
    expect(decodeCursor(encodeCursor(input))).toEqual(input);
  });

  it("hashes tokens and compares secrets without early length acceptance", async () => {
    expect(await sha256Hex("citera")).toMatch(/^[0-9a-f]{64}$/u);
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
  });
});
