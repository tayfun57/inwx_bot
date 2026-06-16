/**
 * Minimal INWX DomRobot JSON-RPC client built on the `fetch` API so it runs
 * inside a Cloudflare Worker (where the Python `requests`-based SDK cannot).
 *
 * The session is cookie based: `account.login` returns a `domrobot` cookie
 * that must be sent on every subsequent call. Workers' `fetch` does not keep
 * a cookie jar, so we capture and replay it manually.
 */
import { generateTotp } from "./totp";

export interface InwxResponse<T = unknown> {
  code?: number;
  msg?: string;
  resData?: T;
}

export interface AccountInfo {
  defaultRegistrant?: number;
  defaultAdmin?: number;
  defaultTech?: number;
  defaultBilling?: number;
  [key: string]: unknown;
}

export class InwxApiError extends Error {
  constructor(
    public readonly code: number | undefined,
    public readonly msg: string,
    public readonly context = "",
  ) {
    super(`API error ${context}. Code: ${code}, Message: ${msg}`);
    this.name = "InwxApiError";
  }
}

function extractSessionCookie(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  let cookies: string[] = [];
  if (typeof headers.getSetCookie === "function") {
    cookies = headers.getSetCookie();
  } else {
    const single = res.headers.get("set-cookie");
    if (single) cookies = [single];
  }
  for (const cookie of cookies) {
    const match = cookie.match(/domrobot=[^;]+/);
    if (match) return match[0];
  }
  // Fallback: replay the first cookie's name=value pair.
  if (cookies.length > 0) {
    const first = cookies[0].split(";")[0]?.trim();
    if (first) return first;
  }
  return null;
}

export class InwxClient {
  private cookie: string | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly lang = "en",
  ) {}

  private async rawCall(method: string, params: Record<string, unknown> = {}): Promise<InwxResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cookie) headers["cookie"] = this.cookie;

    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, params }),
    });

    const sessionCookie = extractSessionCookie(res);
    if (sessionCookie) this.cookie = sessionCookie;

    if (!res.ok) {
      throw new InwxApiError(res.status, `HTTP ${res.status} ${res.statusText}`, `calling ${method}`);
    }
    return (await res.json()) as InwxResponse;
  }

  /** Call an API method and require a 1000 ("Command completed") response. */
  async call(method: string, params: Record<string, unknown> = {}, context = ""): Promise<InwxResponse> {
    const result = await this.rawCall(method, params);
    if (result.code === 1000) return result;
    throw new InwxApiError(result.code, result.msg ?? "", context);
  }

  async login(user: string, pass: string, sharedSecret?: string): Promise<void> {
    const result = await this.rawCall("account.login", { user, pass, lang: this.lang });
    if (result.code !== 1000) {
      throw new InwxApiError(result.code, result.msg ?? "", "during login");
    }
    // Optional mobile-TAN / 2FA step.
    const tfa = (result.resData as { tfa?: string } | undefined)?.tfa;
    if (tfa && tfa !== "0") {
      if (!sharedSecret) {
        throw new InwxApiError(result.code, "2FA required but INWX_SHARED_SECRET is not set", "during login");
      }
      const tan = await generateTotp(sharedSecret);
      await this.call("account.unlock", { tan }, "during 2FA unlock");
    }
  }

  async logout(): Promise<void> {
    try {
      await this.rawCall("account.logout");
    } finally {
      this.cookie = null;
    }
  }

  /**
   * Check availability and (best-effort) price in a single `domain.check`.
   * `price` is null when INWX does not return one for this domain.
   */
  private static priceFromEntry(entry: Record<string, unknown>): number | null {
    const raw = entry.price ?? entry.checkPrice ?? null;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
    return null;
  }

  async checkDomain(domain: string): Promise<{ avail: boolean; price: number | null }> {
    const result = await this.call("domain.check", { domain }, "during domain check");
    const entry = (result.resData as { domain?: Array<Record<string, unknown>> } | undefined)?.domain?.[0] ?? {};
    return { avail: Boolean(entry.avail), price: InwxClient.priceFromEntry(entry) };
  }

  /**
   * Check several domains in a single `domain.check` call (INWX accepts a list),
   * cutting one subrequest per domain down to one per call. Results are keyed by
   * lowercased domain name.
   */
  async checkDomains(domains: string[]): Promise<Map<string, { avail: boolean; price: number | null }>> {
    const out = new Map<string, { avail: boolean; price: number | null }>();
    if (domains.length === 0) return out;
    const result = await this.call("domain.check", { domain: domains }, "during domain check");
    const entries = (result.resData as { domain?: Array<Record<string, unknown>> } | undefined)?.domain ?? [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const name = typeof entry.domain === "string" && entry.domain ? entry.domain : domains[i];
      if (!name) continue;
      out.set(name.toLowerCase(), { avail: Boolean(entry.avail), price: InwxClient.priceFromEntry(entry) });
    }
    return out;
  }

  async isDomainFree(domain: string): Promise<boolean> {
    return (await this.checkDomain(domain)).avail;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const result = await this.call("account.info", {}, "while fetching account info");
    return (result.resData ?? {}) as AccountInfo;
  }

  /**
   * Fetch details for a domain in the account (registration / expiry / update
   * dates, status, …). Returns null if the domain is not in this account.
   */
  async getDomainInfo(domain: string): Promise<Record<string, unknown> | null> {
    const result = await this.rawCall("domain.info", { domain });
    if (result.code === 1000) return (result.resData ?? {}) as Record<string, unknown>;
    return null;
  }

  /** Attempt to register a domain. Never throws; returns the API outcome. */
  async buyDomain(buyParams: Record<string, unknown>): Promise<{ success: boolean; code?: number; msg: string }> {
    const result = await this.rawCall("domain.create", buyParams);
    return { success: result.code === 1000, code: result.code, msg: result.msg ?? "" };
  }
}
