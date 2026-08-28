export type StudioAccessMode = "local" | "trusted-lan";

export interface StudioAccessPolicy {
  readonly mode: StudioAccessMode;
  readonly allowedOrigins: ReadonlyArray<string>;
}

/** Returns true only for concrete RFC1918 IPv4 addresses. */
export function isPrivateIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) {
    return false;
  }

  const numbers = octets.map(Number);
  if (numbers.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return (
    numbers[0] === 10
    || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31)
    || (numbers[0] === 192 && numbers[1] === 168)
  );
}

/** Normalizes valid HTTP(S) origins and drops invalid/non-web origins. */
export function normalizeAllowedOrigins(origins: ReadonlyArray<string>): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of origins) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      continue;
    }

    const origin = url.origin;
    if (!seen.has(origin)) {
      seen.add(origin);
      normalized.push(origin);
    }
  }

  return normalized;
}

/** Origin matching only; this is a CSRF policy helper, not authentication. */
export function isAllowedMutationOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlyArray<string>,
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}
