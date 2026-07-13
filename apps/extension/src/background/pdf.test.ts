// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadPdf } from "./pdf";

afterEach(() => vi.unstubAllGlobals());

describe("downloadPdf", () => {
  it("checks PDF magic bytes and returns SHA-256 metadata", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": "attachment; filename=fixture.pdf",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadPdf("https://publisher.test/private/document", {
      pageUrl: "https://publisher.test/article/1",
      allowCrossOrigin: false,
    });

    expect(result.originalName).toBe("fixture.pdf");
    expect(result.bytes).toEqual(bytes);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://publisher.test/private/document",
      expect.objectContaining({
        credentials: "include",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a non-PDF response even when the URL ends in pdf", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("<html>sign in</html>", { status: 200 }))),
    );

    await expect(
      downloadPdf("https://publisher.test/paper.pdf", {
        pageUrl: "https://publisher.test/article",
        allowCrossOrigin: false,
      }),
    ).rejects.toThrow(/マジックバイト/u);
  });

  it("rejects unsafe URL schemes before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadPdf("file:///tmp/paper.pdf", {
        pageUrl: "https://publisher.test/article",
        allowCrossOrigin: false,
      }),
    ).rejects.toThrow(/スキーム/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit consent before a cross-origin request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadPdf("https://cdn.test/paper.pdf", {
        pageUrl: "https://publisher.test/article",
        allowCrossOrigin: false,
      }),
    ).rejects.toThrow(/明示的な許可/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits credentials for an explicitly approved cross-origin request", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
    const fetchMock = vi.fn(() => Promise.resolve(new Response(bytes, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    await downloadPdf("https://cdn.test/paper.pdf", {
      pageUrl: "https://publisher.test/article",
      allowCrossOrigin: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.test/paper.pdf",
      expect.objectContaining({ credentials: "omit", redirect: "manual" }),
    );
  });

  it("validates every redirect target before making the next request", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadPdf("https://publisher.test/paper.pdf", {
        pageUrl: "https://publisher.test/article",
        allowCrossOrigin: false,
      }),
    ).rejects.toThrow(/ローカルまたはプライベート/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to another origin without explicit consent", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.test/paper.pdf" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadPdf("https://publisher.test/paper.pdf", {
        pageUrl: "https://publisher.test/article",
        allowCrossOrigin: false,
      }),
    ).rejects.toThrow(/明示的な許可/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("manually follows a validated same-origin redirect", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nredirected");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/files/final.pdf" },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadPdf("https://publisher.test/download", {
      pageUrl: "https://publisher.test/article",
      allowCrossOrigin: false,
    });

    expect(result.originalName).toBe("final.pdf");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://publisher.test/files/final.pdf",
      expect.objectContaining({ credentials: "include", redirect: "manual" }),
    );
  });
});
