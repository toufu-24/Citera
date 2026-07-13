// @vitest-environment node

import { describe, expect, it } from "vitest";

import { base64Url, createCodeChallenge, createPkceTransaction } from "./pkce";

describe("PKCE helpers", () => {
  it("uses unpadded URL-safe base64", () => {
    expect(base64Url(new Uint8Array([251, 255, 239]))).toBe("-__v");
  });

  it("matches the RFC 7636 S256 example", async () => {
    await expect(createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates independent high-entropy transaction values", async () => {
    const transaction = await createPkceTransaction();
    expect(transaction.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(transaction.state).not.toBe(transaction.nonce);
    expect(transaction.codeChallenge).not.toBe(transaction.codeVerifier);
  });
});
