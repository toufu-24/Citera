export interface PkceTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  createdAt: number;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64Url(new Uint8Array(digest));
}

export async function createPkceTransaction(): Promise<PkceTransaction> {
  const codeVerifier = randomBase64Url(64);
  return {
    state: randomBase64Url(32),
    nonce: randomBase64Url(32),
    codeVerifier,
    codeChallenge: await createCodeChallenge(codeVerifier),
    createdAt: Date.now(),
  };
}
