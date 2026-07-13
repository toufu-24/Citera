import { AwsClient } from "aws4fetch";
import { ApiError } from "./errors";
import type { Env } from "./types";

export function objectKeyFor(input: {
  userId: string;
  paperId?: string;
  fileId?: string;
  exportId?: string;
  kind: "original_pdf" | "supplement" | "thumbnail" | "extracted_text" | "export";
  extension: string;
}): string {
  const safe = /^[a-z][a-z0-9]{1,15}_[0-9A-HJKMNP-TV-Z]{26}$/u;
  if (!safe.test(input.userId))
    throw new ApiError(422, "OBJECT_KEY_INVALID", "User ID is invalid.");
  const extension = input.extension.toLowerCase().replace(/^\./u, "");
  if (!/^[a-z0-9]{1,10}$/u.test(extension)) {
    throw new ApiError(422, "OBJECT_KEY_INVALID", "File extension is invalid.");
  }
  if (input.kind === "export") {
    if (!input.exportId || !safe.test(input.exportId))
      throw new ApiError(422, "OBJECT_KEY_INVALID", "Export ID is invalid.");
    return `users/${input.userId}/exports/${input.exportId}/library.${extension}`;
  }
  if (!input.paperId || !input.fileId || !safe.test(input.paperId) || !safe.test(input.fileId)) {
    throw new ApiError(422, "OBJECT_KEY_INVALID", "Paper or file ID is invalid.");
  }
  const directory =
    input.kind === "original_pdf" || input.kind === "supplement" ? "original" : "derived";
  return `users/${input.userId}/papers/${input.paperId}/${directory}/${input.fileId}.${extension}`;
}

export function keyBelongsToUser(key: string, userId: string): boolean {
  return key.startsWith(`users/${userId}/`) && !key.includes("..") && !key.includes("//");
}

export function hexToBase64(hex: string): string {
  if (!/^[0-9a-f]{64}$/u.test(hex))
    throw new ApiError(422, "SHA256_INVALID", "SHA-256 must be lowercase hexadecimal.");
  let binary = "";
  for (let index = 0; index < hex.length; index += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return btoa(binary);
}

export function bufferToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function presignR2(
  env: Env,
  input: {
    key: string;
    method: "GET" | "PUT";
    contentType?: string;
    contentLength?: number;
    sha256?: string;
    expiresIn: number;
  },
): Promise<{ url: string; headers: Record<string, string>; expiresIn: number }> {
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET_NAME
  ) {
    throw new ApiError(
      503,
      "R2_SIGNING_NOT_CONFIGURED",
      "R2 S3 signing credentials are not configured.",
    );
  }
  const encodedKey = input.key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}/${encodedKey}`,
  );
  url.searchParams.set("X-Amz-Expires", String(input.expiresIn));
  const headers = new Headers();
  if (input.method === "PUT") {
    if (input.contentType) headers.set("Content-Type", input.contentType);
    if (!Number.isSafeInteger(input.contentLength) || Number(input.contentLength) <= 0) {
      throw new ApiError(
        422,
        "CONTENT_LENGTH_INVALID",
        "A positive content length is required for signed uploads.",
      );
    }
    headers.set("Content-Length", String(input.contentLength));
    if (input.sha256) headers.set("x-amz-checksum-sha256", hexToBase64(input.sha256));
    headers.set("If-None-Match", "*");
  }
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const signed = await signer.sign(new Request(url, { method: input.method, headers }), {
    aws: { signQuery: true, allHeaders: true },
  });
  const clientHeaders = new Headers(headers);
  // Content-Length is a forbidden browser request header. The user agent derives it from
  // the Blob/ArrayBuffer body; R2 still verifies that derived value because it is signed.
  clientHeaders.delete("Content-Length");
  return {
    url: signed.url,
    headers: Object.fromEntries(clientHeaders),
    expiresIn: input.expiresIn,
  };
}
