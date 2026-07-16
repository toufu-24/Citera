import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const origin = "https://citera.test";

async function request(
  path: string,
  init: RequestInit & { json?: unknown } = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  if (cookie) headers.set("Cookie", cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return exports.default.fetch(
    new Request(new URL(path, origin), {
      ...init,
      redirect: "manual",
      headers,
      body,
    }),
  );
}

async function login(email: string): Promise<{ cookie: string; body: Record<string, unknown> }> {
  const response = await request("/v1/auth/dev-login", {
    method: "POST",
    json: { email, displayName: email.split("@")[0] },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0];
  expect(cookie).toMatch(/^citera_session=/u);
  expect(body).not.toHaveProperty("accessToken");
  return { cookie: cookie ?? "", body };
}

async function jsonBody(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

function sha256Hex(value: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", value)
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

describe("Citera Workers API", () => {
  it("persists an isolated paper workflow across D1, R2, Queue, and sync boundaries", async () => {
    const health = await request("/v1/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ name: "Citera API", status: "ok" });

    const alice = await login("alice@citera.test");
    const aliceCookie = alice.cookie;

    const tagResponse = await request(
      "/v1/tags",
      { method: "POST", json: { name: "Reading list", color: "#b6412e" } },
      aliceCookie,
    );
    expect(tagResponse.status).toBe(201);
    const tag = await jsonBody(tagResponse);

    const collectionResponse = await request(
      "/v1/collections",
      { method: "POST", json: { name: "Default research" } },
      aliceCookie,
    );
    expect(collectionResponse.status).toBe(201);
    const collection = await jsonBody(collectionResponse);

    const preferencesResponse = await request(
      "/v1/preferences",
      {
        method: "PATCH",
        json: {
          defaultStatus: "reading",
          defaultTagIds: [tag.id],
          defaultCollectionId: collection.id,
          defaultExportFormat: "ris",
        },
      },
      aliceCookie,
    );
    expect(preferencesResponse.status).toBe(200);
    await expect(preferencesResponse.json()).resolves.toMatchObject({
      defaultStatus: "reading",
      defaultTagIds: [tag.id],
      defaultCollectionId: collection.id,
      defaultExportFormat: "ris",
    });

    const defaultedPaperResponse = await request(
      "/v1/papers",
      {
        method: "POST",
        json: {
          title: "Paper created with account defaults",
          clientMutationId: "integration-default-paper",
        },
      },
      aliceCookie,
    );
    expect(defaultedPaperResponse.status).toBe(201);
    await expect(defaultedPaperResponse.json()).resolves.toMatchObject({
      status: "reading",
      tags: [{ id: tag.id }],
      collections: [{ id: collection.id }],
    });

    const createResponse = await request(
      "/v1/papers",
      {
        method: "POST",
        json: {
          title: "Vector search for research libraries",
          abstract: "An integration fixture for Citera.",
          publicationYear: 2026,
          venue: "Citera Systems",
          paperType: "article-journal",
          status: "inbox",
          identifiers: [{ identifierType: "doi", value: "https://doi.org/10.5555/CITERA.2026.1" }],
          authors: [{ displayName: "Alice Example", givenName: "Alice", familyName: "Example" }],
          tagIds: [tag.id],
          collectionIds: [],
          clientMutationId: "integration-create-paper",
        },
      },
      aliceCookie,
    );
    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get("ETag")).toBe('"1"');
    const paper = await jsonBody(createResponse);
    expect(paper).toMatchObject({ title: "Vector search for research libraries", version: 1 });
    expect(paper.identifiers[0]).toMatchObject({
      identifierType: "doi",
      normalizedValue: "10.5555/citera.2026.1",
    });

    const idempotentResponse = await request(
      "/v1/papers",
      {
        method: "POST",
        json: {
          title: "Vector search for research libraries",
          identifiers: [{ identifierType: "doi", value: "10.5555/citera.2026.1" }],
          authors: [{ displayName: "Alice Example" }],
          tagIds: [tag.id],
          collectionIds: [],
          clientMutationId: "integration-create-paper",
        },
      },
      aliceCookie,
    );
    expect(idempotentResponse.status).toBe(200);
    expect((await jsonBody(idempotentResponse)).id).toBe(paper.id);

    const duplicateResponse = await request(
      "/v1/papers",
      {
        method: "POST",
        json: {
          title: "Duplicate DOI",
          identifiers: [{ identifierType: "doi", value: "10.5555/citera.2026.1" }],
          authors: [],
          tagIds: [],
          collectionIds: [],
        },
      },
      aliceCookie,
    );
    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      error: { code: "DUPLICATE_IDENTIFIER" },
      requestId: expect.any(String),
    });

    const noteResponse = await request(
      `/v1/papers/${paper.id}/notes`,
      {
        method: "POST",
        json: {
          noteType: "page",
          pageNumber: 1,
          anchor: null,
          contentMarkdown: "**Important** result for the reading group.",
        },
      },
      aliceCookie,
    );
    expect(noteResponse.status).toBe(201);
    const note = await jsonBody(noteResponse);

    const updateResponse = await request(
      `/v1/papers/${paper.id}`,
      {
        method: "PATCH",
        headers: { "If-Match": '"1"' },
        json: { status: "reading", readProgress: 25 },
      },
      aliceCookie,
    );
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.headers.get("ETag")).toBe('"2"');
    await expect(updateResponse.json()).resolves.toMatchObject({
      status: "reading",
      readProgress: 25,
      version: 2,
    });

    const staleUpdate = await request(
      `/v1/papers/${paper.id}`,
      { method: "PATCH", headers: { "If-Match": '"1"' }, json: { status: "read" } },
      aliceCookie,
    );
    expect(staleUpdate.status).toBe(409);
    await expect(staleUpdate.json()).resolves.toMatchObject({
      error: { code: "VERSION_CONFLICT" },
    });

    const detailResponse = await request(`/v1/papers/${paper.id}`, {}, aliceCookie);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: paper.id,
      notes: [{ id: note.id, pageNumber: 1 }],
    });

    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const checksum = await sha256Hex(pdf);
    const ticketResponse = await request(
      `/v1/papers/${paper.id}/files/upload-url`,
      {
        method: "POST",
        json: {
          sha256: checksum,
          mediaType: "application/pdf",
          sizeBytes: pdf.byteLength,
          originalName: "citera-integration.pdf",
          kind: "original_pdf",
        },
      },
      aliceCookie,
    );
    expect(ticketResponse.status).toBe(201);
    const ticket = await jsonBody(ticketResponse);
    expect(ticket).toMatchObject({ duplicate: false, file: { uploadState: "pending" } });

    const uploadResponse = await request(
      new URL(ticket.upload.url).pathname,
      {
        method: "PUT",
        headers: {
          ...ticket.upload.headers,
          "Content-Length": String(pdf.byteLength),
        },
        body: pdf,
      },
      aliceCookie,
    );
    expect(uploadResponse.status).toBe(204);

    const completeResponse = await request(
      `/v1/files/${ticket.file.id}/complete`,
      { method: "POST", json: {} },
      aliceCookie,
    );
    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toMatchObject({ uploadState: "verified" });

    const contentResponse = await request(`/v1/files/${ticket.file.id}/content`, {}, aliceCookie);
    expect(contentResponse.status).toBe(200);
    expect(new Uint8Array(await contentResponse.arrayBuffer())).toEqual(pdf);

    const deleteFileResponse = await request(
      `/v1/files/${ticket.file.id}`,
      { method: "DELETE" },
      aliceCookie,
    );
    expect(deleteFileResponse.status).toBe(204);
    const cleanupOutbox = await env.DB.prepare(
      `SELECT available_at,created_at FROM job_outbox
       WHERE json_extract(job_json,'$.type')='object.cleanup'
         AND json_extract(job_json,'$.fileId')=?`,
    )
      .bind(ticket.file.id)
      .first<{ available_at: string; created_at: string }>();
    expect(cleanupOutbox).toBeTruthy();
    expect(new Date(cleanupOutbox?.available_at ?? 0).getTime()).toBeGreaterThan(
      new Date(cleanupOutbox?.created_at ?? 0).getTime(),
    );

    const restoreFileResponse = await request(
      `/v1/files/${ticket.file.id}/restore`,
      { method: "POST" },
      aliceCookie,
    );
    expect(restoreFileResponse.status).toBe(200);
    const pendingCleanup = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM job_outbox
       WHERE state='pending' AND json_extract(job_json,'$.type')='object.cleanup'
         AND json_extract(job_json,'$.fileId')=?`,
    )
      .bind(ticket.file.id)
      .first<{ count: number }>();
    expect(Number(pendingCleanup?.count ?? 0)).toBe(0);

    const listResponse = await request(
      "/v1/papers?q=vector&hasPdf=true&hasNotes=true",
      {},
      aliceCookie,
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({ items: [{ id: paper.id }] });

    const syncResponse = await request("/v1/sync?cursor=0&limit=100", {}, aliceCookie);
    expect(syncResponse.status).toBe(200);
    const sync = await jsonBody(syncResponse);
    expect(sync.changes.map((change: { entityType: string }) => change.entityType)).toEqual(
      expect.arrayContaining(["tag", "paper", "note", "file"]),
    );
    const outbox = await env.DB.prepare("SELECT COUNT(*) AS count FROM job_outbox").first<{
      count: number;
    }>();
    expect(Number(outbox?.count ?? 0)).toBeGreaterThan(0);

    const bob = await login("bob@citera.test");
    const privateResponse = await request(`/v1/papers/${paper.id}`, {}, bob.cookie);
    expect(privateResponse.status).toBe(404);
    const bobList = await request("/v1/papers", {}, bob.cookie);
    await expect(bobList.json()).resolves.toMatchObject({ items: [] });

    const deleteResponse = await request(
      `/v1/papers/${paper.id}`,
      { method: "DELETE", headers: { "If-Match": '"2"' } },
      aliceCookie,
    );
    expect(deleteResponse.status).toBe(204);

    const reRegisteredResponse = await request(
      "/v1/papers",
      {
        method: "POST",
        json: {
          title: "Re-registered after trash",
          identifiers: [{ identifierType: "doi", value: "10.5555/citera.2026.1" }],
          authors: [],
          tagIds: [],
          collectionIds: [],
        },
      },
      aliceCookie,
    );
    expect(reRegisteredResponse.status).toBe(201);
    const reRegisteredPaper = await jsonBody(reRegisteredResponse);
    expect(reRegisteredPaper.id).not.toBe(paper.id);

    const restoreResponse = await request(
      `/v1/papers/${paper.id}/restore`,
      { method: "POST", headers: { "If-Match": '"3"' } },
      aliceCookie,
    );
    expect(restoreResponse.status).toBe(409);
    await expect(restoreResponse.json()).resolves.toMatchObject({
      error: { code: "DUPLICATE_IDENTIFIER" },
    });
  });

  it("keeps omitted paper fields intact during focused patches", async () => {
    const user = await login("focused-patch@citera.test");
    const createdResponse = await request(
      "/v1/papers",
      {
        method: "POST",
        json: {
          title: "Focused patch regression",
          paperType: "thesis",
          status: "archived",
          priority: 4,
          readProgress: 63,
          metadataState: "complete",
        },
      },
      user.cookie,
    );
    expect(createdResponse.status).toBe(201);
    const created = await jsonBody(createdResponse);

    const patchedResponse = await request(
      `/v1/papers/${created.id}`,
      { method: "PATCH", headers: { "If-Match": '"1"' }, json: { rating: 5 } },
      user.cookie,
    );
    expect(patchedResponse.status).toBe(200);
    await expect(patchedResponse.json()).resolves.toMatchObject({
      rating: 5,
      paperType: "thesis",
      status: "archived",
      priority: 4,
      readProgress: 63,
      metadataState: "complete",
    });

    const emptyPatch = await request(
      `/v1/papers/${created.id}`,
      { method: "PATCH", headers: { "If-Match": '"2"' }, json: {} },
      user.cookie,
    );
    expect(emptyPatch.status).toBe(422);
  });

  it("rejects unauthenticated access with the stable error envelope", async () => {
    const response = await request("/v1/papers");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED", message: expect.any(String) },
      requestId: expect.any(String),
    });
  });

  it("enforces streaming JSON limits and extension token rotation families", async () => {
    const tooLarge = await request("/v1/auth/dev-login", {
      method: "POST",
      json: { email: "large@citera.test", displayName: "x".repeat(1024 * 1024) },
    });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });

    const mislabeledBody = JSON.stringify({
      email: "mislabeled@citera.test",
      displayName: "x".repeat(1024 * 1024),
    });
    const mislabeled = await request("/v1/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: mislabeledBody,
    });
    expect(mislabeled.status).toBe(413);

    const user = await login("extension@citera.test");
    const verifier = "citera-integration-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const redirectUri = "https://integration-extension-id.chromiumapp.org/oauth2";
    const authorize = await request(
      `/v1/auth/extension/authorize?${new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "integration-state",
        nonce: "integration-nonce",
      })}`,
      {},
      user.cookie,
    );
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("Location") ?? "https://invalid.test");
    expect(callback.searchParams.get("state")).toBe("integration-state");

    const exchange = await request("/v1/auth/extension/token", {
      method: "POST",
      json: {
        grantType: "authorization_code",
        code: callback.searchParams.get("code"),
        redirectUri,
        codeVerifier: verifier,
        deviceName: "Integration extension",
      },
    });
    expect(exchange.status).toBe(200);
    const tokens = await jsonBody(exchange);
    const access = await request("/v1/papers", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(access.status).toBe(200);
    const refreshAsBearer = await request("/v1/papers", {
      headers: { Authorization: `Bearer ${tokens.refreshToken}` },
    });
    expect(refreshAsBearer.status).toBe(401);

    const rotated = await request("/v1/auth/refresh", {
      method: "POST",
      json: { refreshToken: tokens.refreshToken },
    });
    expect(rotated.status).toBe(200);
    const rotatedTokens = await jsonBody(rotated);
    const replay = await request("/v1/auth/refresh", {
      method: "POST",
      json: { refreshToken: tokens.refreshToken },
    });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "REFRESH_TOKEN_REUSED" } });
    const revokedChild = await request("/v1/papers", {
      headers: { Authorization: `Bearer ${rotatedTokens.accessToken}` },
    });
    expect(revokedChild.status).toBe(401);
  });

  it("revokes the session and durably queues confirmed account deletion", async () => {
    const email = "delete-me@citera.test";
    const user = await login(email);
    const response = await request(
      "/v1/account",
      { method: "DELETE", json: { confirmation: email } },
      user.cookie,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      state: "queued",
      jobId: expect.stringMatching(/^job_/u),
    });
    expect(response.headers.get("Set-Cookie")).toContain("citera_session=");

    const revoked = await request("/v1/auth/session", {}, user.cookie);
    expect(revoked.status).toBe(401);
    const pendingLogin = await request("/v1/auth/dev-login", {
      method: "POST",
      json: { email, displayName: "Delete me" },
    });
    expect(pendingLogin.status).toBe(409);
    await expect(pendingLogin.json()).resolves.toMatchObject({
      error: { code: "ACCOUNT_DELETION_PENDING" },
    });
    const tombstone = await env.DB.prepare(
      "SELECT deletion_requested_at,deletion_generation FROM users WHERE email=?",
    )
      .bind(email)
      .first<{ deletion_requested_at: string | null; deletion_generation: number }>();
    expect(tombstone?.deletion_requested_at).toEqual(expect.any(String));
    expect(tombstone?.deletion_generation).toBe(1);
    const queued = await env.DB.prepare(
      "SELECT state FROM job_outbox WHERE idempotency_key LIKE 'account.delete:%' ORDER BY created_at DESC LIMIT 1",
    ).first<{ state: string }>();
    expect(queued?.state).toMatch(/^(pending|dispatched)$/u);
  });
});
