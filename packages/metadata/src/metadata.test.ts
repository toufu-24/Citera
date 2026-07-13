import { describe, expect, it } from "vitest";

import {
  extractWebpageMetadata,
  findDuplicateCandidates,
  mergeMetadata,
  rankMetadataCandidates,
  shouldAutoAccept,
} from "./index";
import type { MetadataCandidate } from "./index";

const RETRIEVED_AT = "2026-07-13T00:00:00.000Z";

describe("webpage metadata extraction", () => {
  it("extracts citation/DC tags and resolves PDF URLs", () => {
    const result = extractWebpageMetadata(
      `
        <meta content="A &amp; B" name="citation_title">
        <meta name="citation_author" content="Ada Lovelace">
        <meta name="dc.creator" content="Ada Lovelace">
        <meta name="dc.creator" content="Alan Turing">
        <meta name="citation_publication_date" content="2026-02-03">
        <meta name="citation_journal_title" content="Journal of Tests">
        <meta name="citation_doi" content="https://doi.org/10.5555/ABC">
        <meta name="citation_firstpage" content="41">
        <meta name="citation_lastpage" content="57">
        <meta name="citation_pdf_url" content="/papers/test.pdf">
      `,
      "https://example.test/article/1",
    );

    expect(result.metadata).toMatchObject({
      title: "A & B",
      authors: [{ displayName: "Ada Lovelace" }, { displayName: "Alan Turing" }],
      publicationDate: "2026-02-03",
      publicationYear: 2026,
      venue: "Journal of Tests",
      doi: "10.5555/abc",
      pages: "41-57",
      pdfUrl: "https://example.test/papers/test.pdf",
    });
  });

  it("falls back to ScholarlyArticle JSON-LD", () => {
    const result = extractWebpageMetadata(
      `
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"ScholarlyArticle","headline":"Typed APIs",
         "author":[{"name":"Grace Hopper","givenName":"Grace","familyName":"Hopper"}],
         "datePublished":"2025-09-01",
         "identifier":{"@type":"PropertyValue","propertyID":"DOI","value":"doi:10.1234/TYPE.1"},
         "encoding":{"@type":"MediaObject","contentUrl":"/typed.pdf"}}
      </script>
    `,
      "https://example.test/article",
    );
    expect(result.metadata.title).toBe("Typed APIs");
    expect(result.metadata.authors?.[0]).toEqual({
      displayName: "Grace Hopper",
      givenName: "Grace",
      familyName: "Hopper",
    });
    expect(result.metadata.doi).toBe("10.1234/type.1");
    expect(result.metadata.pdfUrl).toBe("https://example.test/typed.pdf");
  });
});

describe("metadata merge and candidate scoring", () => {
  const candidate = (
    source: MetadataCandidate["source"],
    matchType: MetadataCandidate["matchType"],
    confidence: number,
    title: string,
  ): MetadataCandidate => ({
    metadata: { title, authors: [{ displayName: "Ada Lovelace" }], publicationYear: 2026 },
    source,
    matchType,
    confidence,
    retrievedAt: RETRIEVED_AT,
  });

  it("keeps user-edited fields while filling missing provider fields", () => {
    const merged = mergeMetadata([
      candidate("crossref", "exact-identifier", 0.99, "Provider title"),
      {
        metadata: { title: "My corrected title" },
        source: "user",
        matchType: "user",
        confidence: 1,
        retrievedAt: "2026-07-13T01:00:00.000Z",
      },
    ]);
    expect(merged.metadata.title).toBe("My corrected title");
    expect(merged.metadata.authors).toEqual([{ displayName: "Ada Lovelace" }]);
    expect(merged.fields.title?.source).toBe("user");
    expect(merged.metadataState).toBe("complete");
  });

  it("requires both a high score and an 0.08 lead for fuzzy auto-adoption", () => {
    const query = {
      title: "Composable Metadata Pipelines",
      authors: ["Ada Lovelace"],
      publicationYear: 2026,
      venue: "Journal of Tests",
    };
    const ranked = rankMetadataCandidates(query, [
      {
        ...candidate("fuzzy", "fuzzy", 0.6, "Composable Metadata Pipelines"),
        metadata: {
          ...candidate("fuzzy", "fuzzy", 0.6, "x").metadata,
          ...query,
          authors: [{ displayName: "Ada Lovelace" }],
        },
      },
      candidate("fuzzy", "fuzzy", 0.6, "A Different Pipeline"),
    ]);
    expect(ranked[0]?.score).toBe(1);
    expect(shouldAutoAccept(ranked)).toBe(true);
    expect(shouldAutoAccept([{ score: 0.95 }, { score: 0.9 }])).toBe(false);
  });
});

describe("duplicate detection", () => {
  it("prioritizes normalized DOI, then arXiv/hash/fuzzy/url evidence", () => {
    const duplicates = findDuplicateCandidates(
      {
        id: "new",
        title: "A Paper",
        authors: [{ displayName: "Ada Lovelace" }],
        publicationYear: 2026,
        doi: "doi:10.1000/ABC",
      },
      [
        {
          id: "existing",
          title: "A Paper",
          authors: [{ displayName: "Ada Lovelace" }],
          publicationYear: 2026,
          doi: "https://doi.org/10.1000/abc",
        },
      ],
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ score: 1, strength: "exact", reasons: ["doi", "fuzzy"] });
  });
});
