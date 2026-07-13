import { describe, expect, it } from "vitest";

import {
  CursorPageSchema,
  NoteSchema,
  PaperStatusSchema,
  createId,
  normalizeArxivId,
  normalizeDoi,
  normalizeTag,
  nowUtcIso,
  parseArxivId,
} from "./index";

describe("domain primitives", () => {
  it("creates prefixed ULIDs and UTC timestamps", () => {
    const id = createId("pap", Date.UTC(2026, 0, 2));
    expect(id).toMatch(/^pap_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(nowUtcIso(new Date("2026-07-13T00:30:00+09:00"))).toBe("2026-07-12T15:30:00.000Z");
  });

  it("normalizes identifiers and tags at shared boundaries", () => {
    expect(normalizeDoi(" HTTPS://doi.org/10.1000/ABC.123 ")).toBe("10.1000/abc.123");
    expect(normalizeDoi("not a DOI")).toBeNull();
    expect(normalizeArxivId("https://arxiv.org/pdf/2401.01234v3.pdf")).toBe("2401.01234");
    expect(parseArxivId("arXiv:hep-th/9901001v2")).toEqual({
      id: "hep-th/9901001",
      version: 2,
    });
    expect(normalizeTag("  #Machine   Learning  ")).toBe("machine learning");
  });

  it("validates enums, cursor pages, and page-note invariants", () => {
    expect(PaperStatusSchema.options).toEqual(["inbox", "reading", "read", "archived"]);
    expect(
      CursorPageSchema(PaperStatusSchema).parse({
        items: ["reading"],
        nextCursor: "18421",
        hasMore: true,
      }),
    ).toEqual({ items: ["reading"], nextCursor: "18421", hasMore: true });

    const invalidPageNote = NoteSchema.safeParse({
      id: createId("not"),
      userId: createId("usr"),
      paperId: createId("pap"),
      parentNoteId: null,
      noteType: "page",
      pageNumber: null,
      anchor: null,
      contentMarkdown: "Remember this",
      version: 1,
      createdAt: nowUtcIso(),
      updatedAt: nowUtcIso(),
      deletedAt: null,
    });
    expect(invalidPageNote.success).toBe(false);
  });
});
