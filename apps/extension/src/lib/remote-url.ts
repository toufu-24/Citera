const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".lan",
  ".internal",
  ".home.arpa",
] as const;

function parseIpv4(hostname: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isNonPublicIpv4(octets: number[]): boolean {
  const [first = -1, second = -1, third = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(hostname: string): number[] | null {
  if (!hostname.includes(":")) return null;
  const halves = hostname.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (value: string): number[] | null => {
    if (value === "") return [];
    const words: number[] = [];
    for (const part of value.split(":")) {
      if (!/^[a-f0-9]{1,4}$/iu.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };

  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (left == null || right == null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function isNonPublicIpv6(words: number[]): boolean {
  const first = words[0] ?? 0;

  // IPv4-mapped IPv6 addresses must be checked against the embedded IPv4 address.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return isNonPublicIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }

  // Only globally routable unicast space is accepted. Documentation space is excluded too.
  return (first & 0xe000) !== 0x2000 || (first === 0x2001 && words[1] === 0x0db8);
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
}

function isPrivateHost(url: URL): boolean {
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost" ||
    hostname === "local" ||
    hostname === "localdomain" ||
    hostname === "lan" ||
    hostname === "internal" ||
    hostname === "home.arpa" ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return true;
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 != null) return isNonPublicIpv4(ipv4);
  const ipv6 = parseIpv6(hostname);
  return hostname.includes(":") ? ipv6 == null || isNonPublicIpv6(ipv6) : false;
}

export function parseSafeRemoteUrl(value: string, label = "URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}が不正です。`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}のスキームを利用できません。`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label}にユーザー情報を含めることはできません。`);
  }
  if (isPrivateHost(url)) {
    throw new Error(`${label}がローカルまたはプライベートネットワークを参照しています。`);
  }
  return url;
}

export function resolveSafeRemoteUrl(value: string, baseUrl: string, label = "URL"): URL {
  const base = parseSafeRemoteUrl(baseUrl, "ページURL");
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    throw new Error(`${label}が不正です。`);
  }
  return parseSafeRemoteUrl(resolved.toString(), label);
}

export function isSameRemoteOrigin(left: string | URL, right: string | URL): boolean {
  const leftUrl = parseSafeRemoteUrl(left.toString());
  const rightUrl = parseSafeRemoteUrl(right.toString());
  return leftUrl.origin === rightUrl.origin;
}

export function requiresCrossOriginPdfConsent(pageUrl: string, pdfUrl: string): boolean {
  return !isSameRemoteOrigin(
    parseSafeRemoteUrl(pageUrl, "ページURL"),
    parseSafeRemoteUrl(pdfUrl, "PDF URL"),
  );
}
