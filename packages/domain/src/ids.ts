const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

export const PREFIXED_ULID_PATTERN = /^[a-z][a-z0-9]{1,15}_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  const encoded = new Array<string>(10);

  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = CROCKFORD_BASE32[remaining % 32] ?? "0";
    remaining = Math.floor(remaining / 32);
  }

  return encoded.join("");
}

function encodeRandomness(bytes: Uint8Array): string {
  let buffer = 0;
  let bitsInBuffer = 0;
  let result = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;

    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      result += CROCKFORD_BASE32[(buffer >>> bitsInBuffer) & 31] ?? "0";
      buffer &= (1 << bitsInBuffer) - 1;
    }
  }

  if (bitsInBuffer > 0) {
    result += CROCKFORD_BASE32[(buffer << (5 - bitsInBuffer)) & 31] ?? "0";
  }

  return result.slice(0, 16);
}

/** Creates a lexicographically sortable, opaque identifier such as `pap_01...`. */
export function createId<const Prefix extends string>(
  prefix: Prefix,
  timestamp = Date.now(),
): `${Prefix}_${string}` {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError("ID prefixes must be 2-16 lowercase alphanumeric characters");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 281_474_976_710_655) {
    throw new RangeError("ULID timestamps must fit in 48 bits");
  }

  const randomness = new Uint8Array(10);
  crypto.getRandomValues(randomness);
  return `${prefix}_${encodeTimestamp(timestamp)}${encodeRandomness(randomness)}`;
}

export function nowUtcIso(date: Date = new Date()): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Cannot format an invalid date");
  }
  return date.toISOString();
}
