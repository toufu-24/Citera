import { describe, expect, it, vi } from "vitest";

import { createCiteraApiClient } from "./index";

const now = "2026-07-13T00:00:00.000Z";
const paperId = "pap_01J00000000000000000000000";
const fileId = "fil_01J00000000000000000000000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function paperMutation() {
  return {
    id: paperId,
    title: "Citera contract fixture",
    summary: null,
    abstract: null,
    authors: [],
    publicationYear: null,
    publicationDate: null,
    venue: null,
    volume: null,
    issue: null,
    pages: null,
    publisher: null,
    language: null,
    paperType: "article-journal",
    status: "inbox",
    priority: 0,
    rating: null,
    readProgress: 0,
    sourceUrl: null,
    metadataState: "pending",
    version: 1,
    lastOpenedAt: null,
    identifiers: [],
    tags: [],
    collections: [],
    files: [],
    hasPdf: false,
    hasNotes: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe("Citera API client contracts", () => {
  it("accepts create and update responses where detail-only notes are omitted", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(paperMutation(), 201)));
    const client = createCiteraApiClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(client.createPaper({ title: "Citera contract fixture" })).resolves.toMatchObject({
      id: paperId,
      title: "Citera contract fixture",
    });
  });

  it("parses the nested R2 upload ticket returned by the Worker", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          {
            file: {
              id: fileId,
              kind: "original_pdf",
              mediaType: "application/pdf",
              sizeBytes: 42,
              originalName: "paper.pdf",
              uploadState: "pending",
              sha256: "a".repeat(64),
            },
            upload: {
              url: `https://citera.test/v1/files/${fileId}/content`,
              headers: { "Content-Type": "application/pdf" },
              expiresIn: 300,
            },
            duplicate: false,
          },
          201,
        ),
      ),
    );
    const client = createCiteraApiClient({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      client.createUploadTicket(paperId, {
        sizeBytes: 42,
        mediaType: "application/pdf",
        sha256: "a".repeat(64),
        originalName: "paper.pdf",
      }),
    ).resolves.toMatchObject({
      file: { id: fileId, uploadState: "pending" },
      upload: { expiresIn: 300 },
      duplicate: false,
    });
  });
});
