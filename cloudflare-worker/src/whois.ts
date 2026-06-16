/**
 * WHOIS-style domain metadata via RDAP (the modern, JSON-over-HTTPS successor
 * to WHOIS). Works from a Worker with plain `fetch`.
 *
 * We query the rdap.org bootstrap which redirects to the authoritative RDAP
 * server for the domain's TLD. Note: some ccTLDs (notably .de / DENIC) do not
 * publish registration/expiry dates over RDAP — those fields stay null. For
 * domains in your own INWX account, `domain.info` is used instead (see index.ts).
 */

export interface WhoisInfo {
  domain: string;
  source: "inwx" | "rdap" | "whois" | "none";
  available: boolean | null;
  status: string[];
  registered: string | null;
  expires: string | null;
  updated: string | null;
  registrar: string | null;
  error?: string;
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}

export interface RdapResponse {
  events?: RdapEvent[];
  status?: string[];
  entities?: RdapEntity[];
}

function baseInfo(domain: string): WhoisInfo {
  return {
    domain,
    source: "none",
    available: null,
    status: [],
    registered: null,
    expires: null,
    updated: null,
    registrar: null,
  };
}

function eventDate(events: RdapEvent[] | undefined, action: string): string | null {
  if (!events) return null;
  const found = events.find((ev) => (ev.eventAction ?? "").toLowerCase() === action);
  return found?.eventDate ?? null;
}

/** Extract a field (e.g. "fn") from a jCard / vcardArray structure. */
function vcardField(vcardArray: unknown, field: string): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return null;
  for (const item of entries) {
    if (Array.isArray(item) && item[0] === field && typeof item[3] === "string") {
      return item[3];
    }
  }
  return null;
}

function registrarName(entities: RdapEntity[] | undefined): string | null {
  if (!entities) return null;
  for (const entity of entities) {
    if ((entity.roles ?? []).includes("registrar")) {
      const name = vcardField(entity.vcardArray, "fn");
      if (name) return name;
    }
  }
  return null;
}

export function parseRdap(domain: string, data: RdapResponse): WhoisInfo {
  return {
    domain,
    source: "rdap",
    available: false,
    status: Array.isArray(data.status) ? data.status : [],
    registered: eventDate(data.events, "registration"),
    expires: eventDate(data.events, "expiration"),
    updated: eventDate(data.events, "last changed"),
    registrar: registrarName(data.entities),
  };
}

export async function lookupRdap(domain: string): Promise<WhoisInfo> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: {
        accept: "application/rdap+json",
        // Some RDAP servers reject requests without a User-Agent (HTTP 403).
        "user-agent": "inwx-bot-worker (+https://github.com/koljasagorski/inwx_bot)",
      },
      redirect: "follow",
    });
    if (res.status === 404) {
      // RDAP "not found" generally means the domain is unregistered.
      return { ...baseInfo(domain), source: "rdap", available: true };
    }
    if (!res.ok) {
      return { ...baseInfo(domain), error: `RDAP HTTP ${res.status}` };
    }
    const data = (await res.json()) as RdapResponse;
    return parseRdap(domain, data);
  } catch (e) {
    return { ...baseInfo(domain), error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Port-43 WHOIS fallback (for ccTLDs whose RDAP lacks dates). Best-effort: any
// failure returns null and the RDAP result stands. .de (DENIC) does not publish
// registration/expiry, but status and last-change are filled.
// ---------------------------------------------------------------------------

const WHOIS_SERVERS: Record<string, string> = {
  de: "whois.denic.de",
  at: "whois.nic.at",
  eu: "whois.eu",
  nl: "whois.domain-registry.nl",
};

export function whoisServerFor(domain: string): string | null {
  const tld = domain.split(".").pop()?.toLowerCase() ?? "";
  return WHOIS_SERVERS[tld] ?? null;
}

const WHOIS_REGISTERED_KEYS = ["creation date", "created", "registered on", "domain registration date", "registered"];
const WHOIS_EXPIRES_KEYS = [
  "registry expiry date",
  "registrar registration expiration date",
  "expiry date",
  "expiration date",
  "expire date",
  "expires",
  "paid-till",
  "renewal date",
];
const WHOIS_UPDATED_KEYS = ["updated date", "last updated", "last-update", "last modified", "changed"];

/** Parse a raw port-43 WHOIS response into the fields we track. */
export function parseWhoisText(text: string): Pick<WhoisInfo, "registered" | "expires" | "updated" | "status"> {
  const out: Pick<WhoisInfo, "registered" | "expires" | "updated" | "status"> = {
    registered: null,
    expires: null,
    updated: null,
    status: [],
  };
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "domain status" || key === "status") {
      out.status.push(value);
    } else if (!out.registered && WHOIS_REGISTERED_KEYS.includes(key)) {
      out.registered = value;
    } else if (!out.expires && WHOIS_EXPIRES_KEYS.includes(key)) {
      out.expires = value;
    } else if (!out.updated && WHOIS_UPDATED_KEYS.includes(key)) {
      out.updated = value;
    }
  }
  return out;
}

async function readWhois(socket: { writable: WritableStream; readable: ReadableStream }, server: string, domain: string): Promise<string> {
  const writer = socket.writable.getWriter();
  const query = (server === "whois.denic.de" ? `-T dn ${domain}` : domain) + "\r\n";
  await writer.write(new TextEncoder().encode(query));
  writer.releaseLock();

  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < 200; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value as Uint8Array, { stream: true });
    if (text.length > 100_000) break;
  }
  return text;
}

async function lookupPort43(domain: string, timeoutMs = 5000): Promise<Partial<WhoisInfo> | null> {
  const server = whoisServerFor(domain);
  if (!server) return null;
  try {
    // Dynamic import so importing this module in Node (tests) doesn't fail.
    const { connect } = await import(/* @vite-ignore */ "cloudflare:sockets");
    const socket = connect({ hostname: server, port: 43 });
    // Race the exchange against a timeout so a non-responsive (or blocked)
    // WHOIS server can never stall the refresh. `.catch` swallows a late
    // rejection once the timeout has already won the race.
    const exchange = readWhois(socket, server, domain).catch(() => null);
    const text = await Promise.race([
      exchange,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    // Close in the background — awaiting a stuck connection's close would
    // re-introduce the very hang the timeout is meant to prevent.
    void Promise.resolve(socket.close()).catch(() => {});
    if (!text) return null;
    const parsed = parseWhoisText(text);
    if (!parsed.registered && !parsed.expires && !parsed.updated && parsed.status.length === 0) return null;
    return { source: "whois", ...parsed };
  } catch {
    return null;
  }
}

/**
 * RDAP first; for known ccTLDs without usable RDAP, fall back to port-43 WHOIS.
 *
 * For gTLDs we trust RDAP entirely (including a 404 meaning "unregistered").
 * But rdap.org has no server for e.g. .de, so a 404 there is meaningless — for
 * the ccTLDs in WHOIS_SERVERS we therefore consult port-43, which also tells us
 * whether the domain is actually free (DENIC reports "Status: free").
 */
export async function lookupWhois(domain: string, opts: { port43?: boolean } = {}): Promise<WhoisInfo> {
  const rdap = await lookupRdap(domain);
  if (rdap.registered || rdap.expires) return rdap;
  if (whoisServerFor(domain) === null) return rdap; // gTLD: RDAP is authoritative

  // ccTLD that rdap.org doesn't really cover (e.g. .de): its 404→"available" is
  // not trustworthy. If port-43 is enabled, use it; otherwise report "unknown"
  // rather than falsely flagging a registered domain as available.
  if (opts.port43) {
    const p43 = await lookupPort43(domain);
    if (p43) {
      const free = (p43.status ?? []).some((s) => /\b(free|available)\b/i.test(s));
      return {
        ...rdap,
        source: "whois",
        available: free,
        registered: p43.registered ?? null,
        expires: p43.expires ?? null,
        updated: p43.updated ?? null,
        status: p43.status && p43.status.length > 0 ? p43.status : rdap.status,
      };
    }
  }
  return { ...rdap, available: rdap.available === true ? null : rdap.available };
}
