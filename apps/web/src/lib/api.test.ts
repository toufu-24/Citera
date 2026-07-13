import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiRequestError, shouldSendCredentials } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Citera web API contract", () => {
  it("normalizes nested upload tickets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          file: {
            id: "fil_01",
            ingestionId: null,
            originalName: "paper.pdf",
            sizeBytes: 12,
            mediaType: "application/pdf",
            kind: "original_pdf",
            uploadState: "pending",
          },
          upload: {
            url: "https://uploads.example.test/object",
            headers: { "Content-Type": "application/pdf" },
            expiresIn: 300,
          },
          duplicate: false,
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.uploadUrl("pap_01", {
        sizeBytes: 12,
        mediaType: "application/pdf",
        sha256: "a".repeat(64),
        originalName: "paper.pdf",
      }),
    ).resolves.toEqual({
      fileId: "fil_01",
      ingestionId: null,
      uploadUrl: "https://uploads.example.test/object",
      headers: { "Content-Type": "application/pdf" },
      expiresIn: 300,
      duplicate: false,
      uploadState: "pending",
    });
  });

  it("unwraps item and device collections", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: "tag_01", name: "ML", color: null }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          devices: [
            {
              id: "ses_01",
              deviceName: "Web browser",
              lastUsedAt: "2026-07-13T00:00:00Z",
              current: true,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.tags()).resolves.toEqual([{ id: "tag_01", name: "ML", color: null }]);
    await expect(api.devices()).resolves.toEqual([
      {
        id: "ses_01",
        deviceName: "Web browser",
        lastUsedAt: "2026-07-13T00:00:00Z",
        current: true,
      },
    ]);
  });

  it("uses idempotent relation endpoints for tags and collections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.addPaperTag("pap_01", "tag_01");
    await api.removePaperTag("pap_01", "tag_01");
    await api.addPaperToCollection("pap_01", "col_01");
    await api.removePaperFromCollection("pap_01", "col_01");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/papers/pap_01/tags/tag_01",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/papers/pap_01/tags/tag_01",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/collections/col_01/papers/pap_01",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/v1/collections/col_01/papers/pap_01",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("loads notes separately when an older paper response omits them", async () => {
    const detail = {
      id: "pap_01",
      title: "A paper",
      files: [],
      identifiers: [],
    };
    const notes = [{ id: "not_01", contentMarkdown: "A note" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(jsonResponse({ items: notes }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.paper("pap_01")).resolves.toMatchObject({ ...detail, notes });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves structured API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "The paper changed",
              details: { currentVersion: 2 },
            },
          },
          409,
        ),
      ),
    );

    const error = await api.paper("pap_01").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      details: { currentVersion: 2 },
    });
  });
});

describe("shouldSendCredentials", () => {
  it("uses cookies only for Citera file proxy URLs", () => {
    expect(shouldSendCredentials("http://127.0.0.1:8787/v1/files/fil_01/content")).toBe(true);
    expect(
      shouldSendCredentials(
        "https://bucket.r2.cloudflarestorage.com/signed-object?X-Amz-Signature=abc",
      ),
    ).toBe(false);
  });
});
