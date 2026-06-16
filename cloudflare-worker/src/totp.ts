/**
 * RFC 6238 TOTP generation using the Web Crypto API.
 *
 * INWX uses this for the optional "mobile TAN" two-factor authentication.
 * The shared secret is the base32 string shown when you enable 2FA.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input
    .replace(/=+$/, "")
    .toUpperCase()
    .replace(/\s+/g, "");
  const output = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return output;
}

export interface TotpOptions {
  timeStep?: number;
  digits?: number;
  timestampMs?: number;
}

export async function generateTotp(secret: string, options: TotpOptions = {}): Promise<string> {
  const { timeStep = 30, digits = 6, timestampMs = Date.now() } = options;
  const key = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / timeStep);

  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(0, Math.floor(counter / 2 ** 32), false);
  view.setUint32(4, counter >>> 0, false);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}
