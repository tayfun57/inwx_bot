import { describe, it, expect } from "vitest";
import { generateTotp } from "../src/totp";

// RFC 6238 test vectors for the SHA-1 secret ASCII "12345678901234567890".
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("generateTotp (RFC 6238)", () => {
  it("matches the T=59 vector", async () => {
    expect(await generateTotp(SECRET, { timestampMs: 59_000 })).toBe("287082");
  });
  it("matches the T=1111111109 vector", async () => {
    expect(await generateTotp(SECRET, { timestampMs: 1_111_111_109_000 })).toBe("081804");
  });
});
