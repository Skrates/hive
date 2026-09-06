import { randomBytes } from "node:crypto";

/**
 * §5.B2: a seat or operator act is keyed by a client-minted ULID — 48 bits of
 * millisecond time and 80 bits of randomness in Crockford base32, 26 characters,
 * lexically ordered by mint time. The CLI mints one per write so a retried
 * command replays instead of re-applying.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(now: number = Date.now(), random: Buffer = randomBytes(10)): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffff_ffff_ffff) throw new Error("ulid: time out of range");
  if (random.length !== 10) throw new Error("ulid: need exactly 10 random bytes");
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  // 80 random bits → 16 base32 characters, read from a bit accumulator.
  let entropy = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of random) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      entropy += ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
      accumulator &= (1 << bits) - 1;
    }
  }
  return time + entropy;
}
