import { describe, expect, it } from "vitest";
import { keyBelongsToUser, objectKeyFor, presignR2 } from "./r2";
import type { Env } from "./types";

const userId = "usr_01J00000000000000000000000";
const paperId = "pap_01J00000000000000000000000";
const fileId = "fil_01J00000000000000000000000";

describe("R2 object key authorization", () => {
  it("never includes the user supplied filename", () => {
    const key = objectKeyFor({ userId, paperId, fileId, kind: "original_pdf", extension: "pdf" });
    expect(key).toBe(
      "users/usr_01J00000000000000000000000/papers/pap_01J00000000000000000000000/original/fil_01J00000000000000000000000.pdf",
    );
  });

  it("rejects cross-tenant and traversal keys", () => {
    expect(
      keyBelongsToUser(`users/${userId}/papers/${paperId}/original/${fileId}.pdf`, userId),
    ).toBe(true);
    expect(keyBelongsToUser("users/usr_other/papers/pap_x/original/fil_x.pdf", userId)).toBe(false);
    expect(keyBelongsToUser(`users/${userId}/../usr_other/object`, userId)).toBe(false);
  });

  it("binds production PUT signatures to the browser-derived content length", async () => {
    const signed = await presignR2(
      {
        R2_ACCOUNT_ID: "account-id",
        R2_ACCESS_KEY_ID: "access-key",
        R2_SECRET_ACCESS_KEY: "secret-key",
        R2_BUCKET_NAME: "citera-files",
      } as Env,
      {
        key: `users/${userId}/papers/${paperId}/original/${fileId}.pdf`,
        method: "PUT",
        contentType: "application/pdf",
        contentLength: 1234,
        sha256: "0".repeat(64),
        expiresIn: 300,
      },
    );

    const signedHeaders = new URL(signed.url).searchParams.get("X-Amz-SignedHeaders");
    expect(signedHeaders?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type", "if-none-match"]),
    );
    expect(signed.headers).not.toHaveProperty("content-length");
  });
});
