// @vitest-environment node

import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl } from "./settings";

describe("normalizeApiBaseUrl", () => {
  it("normalizes HTTPS URLs", () => {
    expect(normalizeApiBaseUrl(" https://citera.example.test/ ")).toBe(
      "https://citera.example.test",
    );
  });

  it("allows loopback HTTP for local development", () => {
    expect(normalizeApiBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeApiBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("rejects remote cleartext HTTP and embedded credentials", () => {
    expect(() => normalizeApiBaseUrl("http://citera.example.test")).toThrow(/HTTPS/u);
    expect(() => normalizeApiBaseUrl("https://user:secret@citera.example.test")).toThrow(
      /ユーザー名/u,
    );
  });
});
