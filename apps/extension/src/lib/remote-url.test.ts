import { describe, expect, it } from "vitest";

import {
  isSameRemoteOrigin,
  parseSafeRemoteUrl,
  requiresCrossOriginPdfConsent,
  resolveSafeRemoteUrl,
} from "./remote-url";

describe("remote URL safety", () => {
  it("accepts public HTTP(S) URLs and resolves safe relative URLs", () => {
    expect(parseSafeRemoteUrl("https://203.0.114.8/paper").toString()).toBe(
      "https://203.0.114.8/paper",
    );
    expect(resolveSafeRemoteUrl("../paper.pdf", "https://publisher.test/a/b").toString()).toBe(
      "https://publisher.test/paper.pdf",
    );
  });

  it.each([
    "file:///tmp/paper.pdf",
    "data:application/pdf,example",
    "https://user:secret@publisher.test/paper.pdf",
    "http://localhost/paper.pdf",
    "https://service.local/paper.pdf",
    "https://127.0.0.1/paper.pdf",
    "https://127.1/paper.pdf",
    "https://0x7f000001/paper.pdf",
    "https://10.1.2.3/paper.pdf",
    "https://169.254.169.254/latest/meta-data",
    "https://172.16.0.1/paper.pdf",
    "https://192.168.1.1/paper.pdf",
    "https://[::1]/paper.pdf",
    "https://[fc00::1]/paper.pdf",
    "https://[fe80::1]/paper.pdf",
    "https://[::ffff:127.0.0.1]/paper.pdf",
  ])("rejects a non-public target: %s", (url) => {
    expect(() => parseSafeRemoteUrl(url)).toThrow();
  });

  it("uses strict origin equality for automatic PDF retrieval", () => {
    expect(isSameRemoteOrigin("https://papers.test/article", "https://papers.test/file.pdf")).toBe(
      true,
    );
    expect(
      isSameRemoteOrigin("https://papers.test/article", "https://cdn.papers.test/file.pdf"),
    ).toBe(false);
    expect(
      requiresCrossOriginPdfConsent("https://papers.test/article", "https://cdn.test/file.pdf"),
    ).toBe(true);
  });
});
