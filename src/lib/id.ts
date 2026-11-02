const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/**
 * Generates a 26-character, lexicographically sortable ULID.
 *
 * IDs are generated in the application layer (not by MySQL) so both the
 * Next.js and FastAPI services can create rows without coordinating through
 * the database. Stored as CHAR(26) in `projects.id` and `assets.id`.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32] + timePart;
    time = Math.floor(time / 32);
  }

  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  let randomPart = "";
  for (const byte of random) {
    randomPart += ENCODING[byte % 32];
  }

  return timePart + randomPart;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}
