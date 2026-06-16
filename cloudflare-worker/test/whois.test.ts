import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRdap, lookupRdap, parseWhoisText, whoisServerFor } from "../src/whois";

describe("parseRdap", () => {
  it("extracts events, status and registrar", () => {
    const out = parseRdap("example.com", {
      status: ["client transfer prohibited"],
      events: [
        { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
        { eventAction: "expiration", eventDate: "2026-08-13T04:00:00Z" },
        { eventAction: "last changed", eventDate: "2026-01-16T18:26:50Z" },
      ],
      entities: [
        {
          roles: ["registrar"],
          vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar"]]],
        },
      ],
    });
    expect(out).toMatchObject({
      domain: "example.com",
      source: "rdap",
      available: false,
      registered: "1995-08-14T04:00:00Z",
      expires: "2026-08-13T04:00:00Z",
      updated: "2026-01-16T18:26:50Z",
      registrar: "Example Registrar",
      status: ["client transfer prohibited"],
    });
  });
});

describe("lookupRdap", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats HTTP 404 as available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const out = await lookupRdap("free-xyz-9182736455.com");
    expect(out.available).toBe(true);
    expect(out.source).toBe("rdap");
  });

  it("reports other HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const out = await lookupRdap("x.com");
    expect(out.error).toContain("403");
  });
});

describe("whoisServerFor", () => {
  it("maps known ccTLDs and skips the rest (RDAP covers gTLDs)", () => {
    expect(whoisServerFor("example.de")).toBe("whois.denic.de");
    expect(whoisServerFor("EXAMPLE.AT")).toBe("whois.nic.at");
    expect(whoisServerFor("example.com")).toBeNull();
  });
});

describe("parseWhoisText", () => {
  it("extracts dates and status from a gTLD-style response", () => {
    const out = parseWhoisText(
      [
        "Domain Name: EXAMPLE.COM",
        "Creation Date: 1997-09-15T04:00:00Z",
        "Registry Expiry Date: 2028-09-14T04:00:00Z",
        "Updated Date: 2024-08-14T07:01:34Z",
        "Domain Status: clientTransferProhibited",
      ].join("\n"),
    );
    expect(out.registered).toBe("1997-09-15T04:00:00Z");
    expect(out.expires).toBe("2028-09-14T04:00:00Z");
    expect(out.updated).toBe("2024-08-14T07:01:34Z");
    expect(out.status).toEqual(["clientTransferProhibited"]);
  });

  it("handles a DENIC-style response (status + change, no expiry)", () => {
    const out = parseWhoisText(["Status: connect", "Changed: 2023-02-11T10:00:00+01:00", "Nserver: ns.example.de"].join("\n"));
    expect(out.status).toEqual(["connect"]);
    expect(out.updated).toBe("2023-02-11T10:00:00+01:00");
    expect(out.expires).toBeNull();
    expect(out.registered).toBeNull();
  });
});
