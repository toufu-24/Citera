import { describe, expect, it } from "vitest";

import { parseCitationText, resolveImportedTagIds } from "./import";

describe("citation import", () => {
  it("parses Citera CSV including quoted multiline fields", () => {
    const result = parseCitationText(
      'title,authors,publicationYear,doi,abstract,tags\r\n"A, useful paper","Ada; Taro",2026,10.1000/test,"Line 1\nLine 2","ML; Reading"',
      "library.csv",
    );
    expect(result).toEqual([
      expect.objectContaining({
        title: "A, useful paper",
        publicationYear: 2026,
        authors: [{ displayName: "Ada" }, { displayName: "Taro" }],
        identifiers: [{ identifierType: "doi", value: "10.1000/test" }],
        tags: ["ML", "Reading"],
        abstract: "Line 1\nLine 2",
      }),
    ]);
  });

  it("parses BibTeX and RIS exports", () => {
    const bib = parseCitationText(
      "@article{sample, title={A {Nested} Title}, author={Ada Lovelace and Taro Yamada}, year={2025}, doi={10.1/example}, keywords={History, Computing}}",
      "library.bib",
    );
    expect(bib[0]).toMatchObject({
      title: "A Nested Title",
      publicationYear: 2025,
      paperType: "article-journal",
      tags: ["History", "Computing"],
    });

    const ris = parseCitationText(
      "TY  - CPAPER\r\nTI  - Reliable Workers\r\nAU  - Ada Lovelace\r\nPY  - 2026\r\nER  - ",
      "library.ris",
    );
    expect(ris[0]).toMatchObject({
      title: "Reliable Workers",
      publicationYear: 2026,
      paperType: "paper-conference",
    });
  });

  it("parses CSL JSON date parts and authors", () => {
    const result = parseCitationText(
      JSON.stringify([
        {
          title: "CSL fixture",
          type: "article-journal",
          author: [{ given: "Ada", family: "Lovelace" }],
          issued: { "date-parts": [[1843, 1, 1]] },
          DOI: "10.1000/csl",
        },
      ]),
      "library.json",
    );
    expect(result[0]).toMatchObject({
      publicationDate: "1843-01-01",
      authors: [{ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" }],
    });
  });

  it("uses existing import tags without returning unknown tags", () => {
    const knownTags = new Map([
      ["reading", { id: "tag-reading" }],
      ["ml", { id: "tag-ml" }],
    ]);

    expect(resolveImportedTagIds(["Reading", "New tag", "ML", "reading"], knownTags)).toEqual({
      tagIds: ["tag-reading", "tag-ml"],
      ignoredTagNames: ["New tag"],
    });
  });
});
