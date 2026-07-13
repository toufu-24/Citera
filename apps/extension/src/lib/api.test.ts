// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { SavePaperInput } from "../types";
import { buildIngestionPayload } from "./api";

describe("buildIngestionPayload", () => {
  it("matches the Citera extension ingestion contract", () => {
    const input: SavePaperInput = {
      metadata: {
        title: "A Browser Paper",
        authors: [{ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" }],
        publicationYear: 2026,
        publicationDate: "2026-03-14",
        venue: "Web Science",
        abstract: "A useful abstract.",
        doi: "10.1234/browser.1",
        arxivId: "2603.01234",
        pageUrl: "https://publisher.test/article/1",
        pdfUrl: "https://publisher.test/article/1.pdf",
        keywords: ["browser", "research"],
        detectedSources: ["citation", "doi", "pdf"],
        isPdf: false,
      },
      status: "reading",
      tagIds: ["tag_01"],
      collectionIds: ["col_01", "col_02"],
      includePdf: true,
      allowCrossOriginPdf: false,
    };

    expect(buildIngestionPayload(input)).toMatchObject({
      clientMutationId: expect.any(String),
      sourceType: "extension",
      sourceUrl: "https://publisher.test/article/1",
      includePdf: true,
      paper: {
        title: "A Browser Paper",
        authors: [{ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" }],
        status: "reading",
        tagIds: ["tag_01"],
        collectionIds: ["col_01", "col_02"],
        identifiers: [
          { identifierType: "doi", originalValue: "10.1234/browser.1" },
          { identifierType: "arxiv", originalValue: "2603.01234" },
          { identifierType: "url", originalValue: "https://publisher.test/article/1" },
        ],
        observedMetadata: {
          publicationDate: "2026-03-14",
          pdfUrl: "https://publisher.test/article/1.pdf",
          keywords: ["browser", "research"],
          detectedSources: ["citation", "doi", "pdf"],
        },
      },
    });
  });
});
