/**
 * INWX domain bot as a Cloudflare Worker.
 *
 * - A Cron Trigger runs the check on a schedule (see wrangler.toml).
 * - The domain list and the latest results live in a KV namespace.
 * - A web dashboard is served at `/`.
 * - JSON/CSV endpoints under `/api/*` (bearer-token protected, except the
 *   public `/api/status`) let you manage the list, trigger a run, and
 *   download results.
 *
 * This mirrors the behaviour of the Python `check_domain.py` script.
 */
import { dashboardPage } from "./dashboard";
import { InwxClient, type AccountInfo } from "./inwx";
import { lookupWhois, type WhoisInfo } from "./whois";

export interface Env {
  INWX_BOT: KVNamespace;
  INWX_USERNAME?: string;
  INWX_PASSWORD?: string;
  INWX_SHARED_SECRET?: string;
  INWX_API_URL?: string;
  INWX_NS1?: string;
  INWX_NS2?: string;
  ADMIN_TOKEN?: string;
  NOTIFY_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  API_DELAY_MS?: string;
  DRY_RUN?: string;
  EXPIRY_ALERT_DAYS?: string;
  RENEWAL_MODE?: string;
  PERIOD?: string;
  TRANSFER_LOCK?: string;
  HEARTBEAT_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_TO?: string;
  EMAIL_FROM?: string;
  WHOIS_PORT43?: string;
}

type Action = "skipped" | "purchased" | "purchase_failed" | "would_purchase" | "error";

interface DomainStatus {
  domain: string;
  available: boolean | null;
  action: Action;
  detail: string;
  api_code: number | null;
  api_msg: string | null;
  price?: number | null;
}

interface RunRecord {
  timestamp: string;
  dryRun: boolean;
  statuses: DomainStatus[];
  error?: string;
}

interface WhoisRecord {
  timestamp: string;
  domains: WhoisInfo[];
}

interface RunSummary {
  timestamp: string;
  dryRun: boolean;
  total: number;
  counts: Record<string, number>;
  error?: string;
}

interface DomainChange {
  domain: string;
  from: Action | "new";
  to: Action;
}

interface DomainState {
  action?: Action;
  available?: boolean | null;
  /** Expiry the alert thresholds below refer to (reset when it changes). */
  expires?: string | null;
  /** Expiry-alert thresholds (in days) already sent for the current expiry. */
  notifiedExpiryDays?: number[];
}

type StateMap = Record<string, DomainState>;

type DomainMode = "watch" | "auto";

interface DomainConfig {
  domain: string;
  /** "auto": register when free (unless DRY_RUN); "watch": only report. */
  mode: DomainMode;
  /** Skip auto-purchase if the INWX price exceeds this (in account currency). */
  maxPrice?: number;
  tags?: string[];
  notes?: string;
}

const LIVE_API_URL = "https://api.domrobot.com/jsonrpc/";
const DOMAINS_KEY = "domains";
const RESULTS_JSON_KEY = "results:latest.json";
const RESULTS_CSV_KEY = "results:latest.csv";
const WHOIS_KEY = "whois:latest.json";
const HISTORY_KEY = "history:runs";
const STATE_KEY = "state:domains";
const META_KEY = "state:meta";
const LOCK_KEY = "lock:run";
const HISTORY_LIMIT = 50;
const DEFAULT_EXPIRY_ALERT_DAYS = [30, 14, 7, 1];
const SETTINGS_KEY = "settings:config";
const AUDIT_KEY = "audit:log";
const AUDIT_LIMIT = 100;
const THROTTLE_PREFIX = "throttle:";
const THROTTLE_MAX = 10;
const THROTTLE_WINDOW_SECONDS = 300;
/** Domains per `domain.check` call (one subrequest per chunk). */
const CHECK_BATCH_SIZE = 30;
// Cron schedules (must match wrangler.toml). The availability check and the
// WHOIS refresh run in separate invocations so each gets its own subrequest
// budget; any other/unknown cron value runs both as a safe fallback.
const RUN_CRON = "0 6 * * *";
const WHOIS_CRON = "30 6 * * *";

/** Actions that are worth a notification when a domain first reaches them. */
const INTERESTING_ACTIONS: Action[] = ["would_purchase", "purchased", "purchase_failed", "error"];

/** Effective runtime settings (env defaults, possibly overridden via KV). */
interface Settings {
  dryRun: boolean;
  apiDelayMs: number;
  expiryAlertDays: number[];
  /** Registration options applied to domain.create. */
  renewalMode: string;
  period: string;
  transferLock: boolean;
}

/** Partial overrides stored in KV via the dashboard settings panel. */
interface SettingsOverride {
  dryRun?: boolean;
  apiDelayMs?: number;
  expiryAlertDays?: number[];
  renewalMode?: string;
  period?: string;
  transferLock?: boolean;
}

interface AuditEntry {
  timestamp: string;
  action: string;
  detail?: string;
  ip?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isTrue = (value: string | undefined) => (value ?? "").trim().toLowerCase() === "true";

/** Normalize one entry (plain string or object) into a DomainConfig. */
function normalizeConfig(input: unknown): DomainConfig | null {
  if (typeof input === "string") {
    const domain = input.trim();
    return domain ? { domain, mode: "auto" } : null;
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const domain = String(obj.domain ?? "").trim();
    if (!domain) return null;
    const cfg: DomainConfig = { domain, mode: obj.mode === "watch" ? "watch" : "auto" };
    const maxPrice = Number(obj.maxPrice);
    if (obj.maxPrice !== undefined && obj.maxPrice !== null && obj.maxPrice !== "" && Number.isFinite(maxPrice)) {
      cfg.maxPrice = maxPrice;
    }
    if (Array.isArray(obj.tags)) {
      const tags = obj.tags.map((t) => String(t).trim()).filter(Boolean);
      if (tags.length > 0) cfg.tags = tags;
    }
    if (typeof obj.notes === "string" && obj.notes.trim()) cfg.notes = obj.notes.trim();
    return cfg;
  }
  return null;
}

/** Accepts a JSON array (of strings or objects) or newline-separated domains. */
function parseDomainConfigs(raw: string): DomainConfig[] {
  const trimmed = raw.trim();
  let entries: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = trimmed.split(/\r?\n/);
    }
  } else {
    entries = trimmed.split(/\r?\n/);
  }
  return entries.map(normalizeConfig).filter((c): c is DomainConfig => c !== null);
}

async function loadDomainConfigs(env: Env): Promise<DomainConfig[]> {
  const raw = await env.INWX_BOT.get(DOMAINS_KEY);
  return raw ? parseDomainConfigs(raw) : [];
}

async function loadDomains(env: Env): Promise<string[]> {
  return (await loadDomainConfigs(env)).map((c) => c.domain);
}

function toCsv(statuses: DomainStatus[]): string {
  const fields: (keyof DomainStatus)[] = ["domain", "available", "action", "detail", "api_code", "api_msg"];
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fields.join(",")];
  for (const status of statuses) {
    lines.push(fields.map((f) => escape(status[f])).join(","));
  }
  return lines.join("\n");
}

function countsOf(statuses: DomainStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s.action] = (counts[s.action] ?? 0) + 1;
  return counts;
}

async function readJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  const raw = await env.INWX_BOT.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const loadState = (env: Env) => readJson<StateMap>(env, STATE_KEY, {});
const saveState = (env: Env, state: StateMap) => env.INWX_BOT.put(STATE_KEY, JSON.stringify(state));

/** Settings from env (the safe defaults), overlaid with KV overrides. */
function envSettings(env: Env): Settings {
  return {
    dryRun: isTrue(env.DRY_RUN),
    apiDelayMs: env.API_DELAY_MS ? Number(env.API_DELAY_MS) : 1000,
    expiryAlertDays: parseThresholds(env.EXPIRY_ALERT_DAYS),
    // Conservative registration defaults: auto-renew so a domain isn't lost,
    // and lock transfers unless the user opts out.
    renewalMode: env.RENEWAL_MODE || "AUTORENEW",
    period: env.PERIOD ?? "",
    transferLock: env.TRANSFER_LOCK !== undefined ? isTrue(env.TRANSFER_LOCK) : true,
  };
}

function mergeSettings(base: Settings, ov: SettingsOverride): Settings {
  return {
    dryRun: typeof ov.dryRun === "boolean" ? ov.dryRun : base.dryRun,
    apiDelayMs:
      typeof ov.apiDelayMs === "number" && Number.isFinite(ov.apiDelayMs) && ov.apiDelayMs >= 0
        ? ov.apiDelayMs
        : base.apiDelayMs,
    expiryAlertDays:
      Array.isArray(ov.expiryAlertDays) && ov.expiryAlertDays.length > 0
        ? ov.expiryAlertDays.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => b - a)
        : base.expiryAlertDays,
    renewalMode: typeof ov.renewalMode === "string" && ov.renewalMode ? ov.renewalMode : base.renewalMode,
    period: typeof ov.period === "string" ? ov.period : base.period,
    transferLock: typeof ov.transferLock === "boolean" ? ov.transferLock : base.transferLock,
  };
}

async function loadSettings(env: Env): Promise<Settings> {
  return mergeSettings(envSettings(env), await readJson<SettingsOverride>(env, SETTINGS_KEY, {}));
}

async function audit(env: Env, request: Request, action: string, detail?: string): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    action,
    detail,
    ip: request.headers.get("cf-connecting-ip") ?? undefined,
  };
  const log = await readJson<AuditEntry[]>(env, AUDIT_KEY, []);
  log.unshift(entry);
  await env.INWX_BOT.put(AUDIT_KEY, JSON.stringify(log.slice(0, AUDIT_LIMIT)));
}

// Brute-force protection on the admin token, keyed by client IP. Fail-open:
// any KV hiccup leaves the request allowed rather than locking the user out.
async function isThrottled(env: Env, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const n = Number(await env.INWX_BOT.get(THROTTLE_PREFIX + ip)) || 0;
  return n >= THROTTLE_MAX;
}

async function recordAuthFailure(env: Env, ip: string | null): Promise<void> {
  if (!ip) return;
  const n = (Number(await env.INWX_BOT.get(THROTTLE_PREFIX + ip)) || 0) + 1;
  await env.INWX_BOT.put(THROTTLE_PREFIX + ip, String(n), { expirationTtl: THROTTLE_WINDOW_SECONDS });
}

const clearAuthFailures = (env: Env, ip: string | null) =>
  ip ? env.INWX_BOT.delete(THROTTLE_PREFIX + ip) : Promise.resolve();

/** Expand an ad-hoc check request into concrete domains to query. */
function expandCheckTargets(input: { domain?: string; keyword?: string; tlds?: string[] }): string[] {
  if (typeof input.domain === "string" && input.domain.trim()) {
    return [input.domain.trim().toLowerCase()];
  }
  const keyword = (input.keyword ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  const tlds = (input.tlds ?? []).map((t) => String(t).trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (!keyword || tlds.length === 0) return [];
  return tlds.map((tld) => `${keyword}.${tld}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function appendHistory(env: Env, summary: RunSummary): Promise<void> {
  const history = await readJson<RunSummary[]>(env, HISTORY_KEY, []);
  history.unshift(summary);
  await env.INWX_BOT.put(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

// Best-effort mutual exclusion. KV is eventually consistent, so this only
// guards against the common case (an overlapping manual + scheduled run); it is
// not a hard lock.
async function acquireLock(env: Env, token: string, ttlSeconds = 1800): Promise<boolean> {
  if (await env.INWX_BOT.get(LOCK_KEY)) return false;
  await env.INWX_BOT.put(LOCK_KEY, token, { expirationTtl: ttlSeconds });
  return true;
}

async function releaseLock(env: Env, token: string): Promise<void> {
  if ((await env.INWX_BOT.get(LOCK_KEY)) === token) await env.INWX_BOT.delete(LOCK_KEY);
}

async function withLock<T>(env: Env, fn: () => Promise<T>): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const token = crypto.randomUUID();
  if (!(await acquireLock(env, token))) return { skipped: true };
  try {
    return { skipped: false, result: await fn() };
  } finally {
    await releaseLock(env, token);
  }
}

/** Domains whose action changed into an "interesting" state since last run. */
function detectRunChanges(prev: StateMap, statuses: DomainStatus[]): DomainChange[] {
  const changes: DomainChange[] = [];
  for (const s of statuses) {
    const before = prev[s.domain]?.action;
    if (s.action !== before && INTERESTING_ACTIONS.includes(s.action)) {
      changes.push({ domain: s.domain, from: before ?? "new", to: s.action });
    }
  }
  return changes;
}

function parseThresholds(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_EXPIRY_ALERT_DAYS;
  const parsed = raw
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed.sort((a, b) => b - a) : DEFAULT_EXPIRY_ALERT_DAYS;
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86_400_000);
}

async function sendWebhook(env: Env, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` suits Slack, `content` suits Discord — sending both is harmless.
      body: JSON.stringify({ text, content: text, ...extra }),
    });
  } catch {
    // Notifications are best-effort.
  }
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch {
    // Notifications are best-effort.
  }
}

async function sendEmail(env: Env, text: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.EMAIL_TO], subject: text.slice(0, 120), text }),
    });
  } catch {
    // Notifications are best-effort.
  }
}

/** True if at least one notification channel is configured. */
function hasNotifyChannel(env: Env): boolean {
  return Boolean(env.NOTIFY_WEBHOOK_URL || env.TELEGRAM_BOT_TOKEN || env.RESEND_API_KEY);
}

/** Fan out a notification to all configured channels (webhook + Telegram + email). */
async function notify(env: Env, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await Promise.all([sendWebhook(env, text, extra), sendTelegram(env, text), sendEmail(env, text)]);
}

function buyParamsFor(
  domain: string,
  accountInfo: AccountInfo,
  ns: string[],
  reg: Pick<Settings, "renewalMode" | "period" | "transferLock">,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    domain,
    registrant: accountInfo.defaultRegistrant,
    admin: accountInfo.defaultAdmin,
    tech: accountInfo.defaultTech,
    billing: accountInfo.defaultBilling,
  };
  if (ns.length > 0) params.ns = ns;
  if (reg.renewalMode) params.renewalMode = reg.renewalMode;
  if (reg.period) params.period = reg.period;
  params.transferLock = reg.transferLock;
  return params;
}

async function processDomain(
  client: InwxClient,
  cfg: DomainConfig,
  check: { avail: boolean; price: number | null },
  accountInfo: AccountInfo,
  ns: string[],
  settings: Settings,
): Promise<DomainStatus> {
  const domain = cfg.domain;
  const { avail, price } = check;
  const priceNote = price !== null ? ` (Preis ${price})` : "";
  const notBought = (detail: string): DomainStatus => ({
    domain,
    available: true,
    action: "would_purchase",
    detail,
    api_code: null,
    api_msg: null,
    price,
  });

  if (!avail) {
    return { domain, available: false, action: "skipped", detail: "already registered", api_code: 1000, api_msg: "domain not available", price };
  }
  // Available — decide whether to actually register it.
  if (cfg.mode === "watch") return notBought(`watch-only${priceNote}`);
  if (settings.dryRun) return notBought(`dry run – not purchased${priceNote}`);
  if (cfg.maxPrice !== undefined) {
    if (price === null) return notBought(`price unknown – skipped (max ${cfg.maxPrice})`);
    if (price > cfg.maxPrice) return notBought(`over budget – ${price} > max ${cfg.maxPrice}`);
  }

  const { success, code, msg } = await client.buyDomain(buyParamsFor(domain, accountInfo, ns, settings));
  if (success) {
    return { domain, available: true, action: "purchased", detail: `success${priceNote}`, api_code: code ?? null, api_msg: msg, price };
  }
  return { domain, available: true, action: "purchase_failed", detail: `Code ${code}: ${msg}`, api_code: code ?? null, api_msg: msg, price };
}

async function runCheck(env: Env, settings: Settings): Promise<DomainStatus[]> {
  if (!env.INWX_USERNAME || !env.INWX_PASSWORD) {
    throw new Error("INWX_USERNAME or INWX_PASSWORD is not configured");
  }
  const delayMs = settings.apiDelayMs;
  const client = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
  const statuses: DomainStatus[] = [];

  let loggedIn = false;
  try {
    await client.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
    loggedIn = true;

    const accountInfo = await client.getAccountInfo();
    const ns = [env.INWX_NS1, env.INWX_NS2].filter((v): v is string => Boolean(v));
    const configs = await loadDomainConfigs(env);

    // Availability is checked in batches (one subrequest per chunk) instead of
    // one call per domain — this is what keeps large lists under the limits.
    const checks = new Map<string, { avail: boolean; price: number | null }>();
    const batches = chunk(
      configs.map((c) => c.domain),
      CHECK_BATCH_SIZE,
    );
    for (let b = 0; b < batches.length; b++) {
      if (b > 0 && delayMs > 0) await sleep(delayMs);
      const batchResult = await client.checkDomains(batches[b]);
      batchResult.forEach((value, key) => checks.set(key, value));
    }

    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      const check = checks.get(cfg.domain.toLowerCase()) ?? { avail: false, price: null };
      try {
        // Only registrations make a further API call, so a small delay between
        // them is enough; pure look-ups already happened in the batch above.
        if (i > 0 && delayMs > 0 && check.avail && cfg.mode === "auto" && !settings.dryRun) {
          await sleep(delayMs);
        }
        const status = await processDomain(client, cfg, check, accountInfo, ns, settings);
        statuses.push(status);
        console.log(`[${i + 1}/${configs.length}] ${cfg.domain} -> ${status.action}`);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        statuses.push({ domain: cfg.domain, available: null, action: "error", detail, api_code: null, api_msg: null });
        console.error(`[${i + 1}/${configs.length}] ${cfg.domain} -> error: ${detail}`);
      }
    }
  } finally {
    if (loggedIn) {
      await client.logout().catch(() => {});
    }
  }
  return statuses;
}

/**
 * Register a single domain on explicit user request (dashboard "Kaufen").
 * This is an explicit action and therefore ignores DRY_RUN and the per-domain
 * watch/auto mode — it always attempts the real purchase.
 */
async function buyDomainNow(
  env: Env,
  domain: string,
): Promise<{ ok: boolean; action: Action; detail: string; code?: number; price?: number | null }> {
  if (!env.INWX_USERNAME || !env.INWX_PASSWORD) {
    return { ok: false, action: "error", detail: "INWX credentials not configured" };
  }
  const client = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
  let loggedIn = false;
  try {
    await client.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
    loggedIn = true;
    const { avail, price } = await client.checkDomain(domain);
    if (!avail) return { ok: false, action: "skipped", detail: "not available", price };
    const accountInfo = await client.getAccountInfo();
    const ns = [env.INWX_NS1, env.INWX_NS2].filter((v): v is string => Boolean(v));
    const settings = await loadSettings(env);
    const { success, code, msg } = await client.buyDomain(buyParamsFor(domain, accountInfo, ns, settings));
    if (success) {
      await markDomainPurchased(env, domain, price);
      await notify(env, `INWX-Bot: Domain registriert – ${domain}${price !== null ? ` (Preis ${price})` : ""}`);
      return { ok: true, action: "purchased", detail: "success", code, price };
    }
    return { ok: false, action: "purchase_failed", detail: `Code ${code}: ${msg}`, code, price };
  } catch (e) {
    return { ok: false, action: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (loggedIn) await client.logout().catch(() => {});
  }
}

/** Keep stored results/state consistent after an on-demand purchase. */
async function markDomainPurchased(env: Env, domain: string, price: number | null): Promise<void> {
  const record = await readJson<RunRecord | null>(env, RESULTS_JSON_KEY, null);
  if (record && Array.isArray(record.statuses)) {
    const row = record.statuses.find((s) => s.domain === domain);
    if (row) {
      row.action = "purchased";
      row.available = true;
      row.detail = "manuell gekauft";
      row.price = price;
      await env.INWX_BOT.put(RESULTS_JSON_KEY, JSON.stringify(record, null, 2));
      await env.INWX_BOT.put(RESULTS_CSV_KEY, toCsv(record.statuses));
    }
  }
  const state = await loadState(env);
  state[domain] = { ...state[domain], action: "purchased", available: true };
  await saveState(env, state);
}

interface CheckResult {
  domain: string;
  available?: boolean;
  price?: number | null;
  error?: string;
}

/** Ad-hoc availability/price check for arbitrary domains (does not buy). */
async function runAdhocCheck(env: Env, targets: string[]): Promise<CheckResult[]> {
  if (!env.INWX_USERNAME || !env.INWX_PASSWORD) {
    throw new Error("INWX credentials not configured");
  }
  const settings = await loadSettings(env);
  const client = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
  let loggedIn = false;
  try {
    await client.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
    loggedIn = true;
    const checks = new Map<string, { avail: boolean; price: number | null }>();
    const batches = chunk(targets, CHECK_BATCH_SIZE);
    for (let b = 0; b < batches.length; b++) {
      if (b > 0 && settings.apiDelayMs > 0) await sleep(settings.apiDelayMs);
      const result = await client.checkDomains(batches[b]);
      result.forEach((value, key) => checks.set(key, value));
    }
    return targets.map((domain) => {
      const c = checks.get(domain.toLowerCase());
      return c ? { domain, available: c.avail, price: c.price } : { domain, error: "no result" };
    });
  } finally {
    if (loggedIn) await client.logout().catch(() => {});
  }
}

const ACTION_LABELS_DE: Record<Action, string> = {
  skipped: "übersprungen",
  would_purchase: "verfügbar",
  purchased: "gekauft",
  purchase_failed: "Kauf fehlgeschlagen",
  error: "Fehler",
};

async function notifyRun(env: Env, record: RunRecord, changes: DomainChange[]): Promise<void> {
  if (!hasNotifyChannel(env)) return;

  // De-duplicate fatal run errors so a persistent failure does not spam.
  if (record.error) {
    const meta = await readJson<{ lastNotifiedError?: string }>(env, META_KEY, {});
    if (meta.lastNotifiedError !== record.error) {
      await notify(env, `INWX-Bot: Lauf fehlgeschlagen – ${record.error}`);
      await env.INWX_BOT.put(META_KEY, JSON.stringify({ ...meta, lastNotifiedError: record.error }));
    }
    return;
  }
  // Clear a stored error once a run succeeds again.
  await env.INWX_BOT.put(META_KEY, JSON.stringify({}));

  // Only notify when a domain's status actually changed since the last run.
  if (changes.length === 0) return;
  const detail = changes.map((c) => `${c.domain}: ${ACTION_LABELS_DE[c.to]}`).join(", ");
  const prefix = record.dryRun ? "INWX-Bot (Probelauf)" : "INWX-Bot";
  await notify(env, `${prefix}: ${changes.length} Änderung(en) – ${detail}`, { changes });
}

async function runAndStore(env: Env): Promise<RunRecord> {
  const timestamp = new Date().toISOString();
  const settings = await loadSettings(env);
  const dryRun = settings.dryRun;
  let record: RunRecord;
  try {
    record = { timestamp, dryRun, statuses: await runCheck(env, settings) };
  } catch (e) {
    record = { timestamp, dryRun, statuses: [], error: e instanceof Error ? e.message : String(e) };
  }

  await env.INWX_BOT.put(RESULTS_JSON_KEY, JSON.stringify(record, null, 2));
  await env.INWX_BOT.put(RESULTS_CSV_KEY, toCsv(record.statuses));

  // Detect per-domain changes vs. the previous run, then persist the new state.
  const state = await loadState(env);
  const changes = detectRunChanges(state, record.statuses);
  for (const s of record.statuses) {
    state[s.domain] = { ...state[s.domain], action: s.action, available: s.available };
  }
  await saveState(env, state);

  await appendHistory(env, {
    timestamp,
    dryRun,
    total: record.statuses.length,
    counts: countsOf(record.statuses),
    error: record.error,
  });

  await notifyRun(env, record, changes);
  return record;
}

function inwxToWhois(domain: string, info: Record<string, unknown>): WhoisInfo {
  const status = info.status;
  const statusList = Array.isArray(status)
    ? status.map(String)
    : status
      ? [String(status)]
      : [];
  return {
    domain,
    source: "inwx",
    available: false,
    status: statusList,
    registered: (info.crDate as string) ?? null,
    expires: (info.exDate as string) ?? null,
    updated: (info.upDate as string) ?? null,
    registrar: "INWX",
  };
}

/** Prefer authoritative INWX data for owned domains; fall back to RDAP/WHOIS. */
async function enrichDomain(client: InwxClient | null, domain: string, port43: boolean): Promise<WhoisInfo> {
  if (client) {
    try {
      const info = await client.getDomainInfo(domain);
      if (info) return inwxToWhois(domain, info);
    } catch {
      // not owned / API hiccup -> fall back to RDAP
    }
  }
  return lookupWhois(domain, { port43 });
}

async function refreshWhois(env: Env): Promise<WhoisRecord> {
  const timestamp = new Date().toISOString();
  const settings = await loadSettings(env);
  const delayMs = settings.apiDelayMs;
  const port43 = isTrue(env.WHOIS_PORT43);
  const domains = await loadDomains(env);

  // Logging in is optional: without INWX credentials we still serve RDAP data.
  let client: InwxClient | null = null;
  let loggedIn = false;
  if (env.INWX_USERNAME && env.INWX_PASSWORD) {
    const c = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
    try {
      await c.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
      client = c;
      loggedIn = true;
    } catch {
      client = null;
    }
  }

  const results: WhoisInfo[] = [];
  try {
    for (let i = 0; i < domains.length; i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      try {
        results.push(await enrichDomain(client, domains[i], port43));
      } catch (e) {
        results.push({
          domain: domains[i],
          source: "none",
          available: null,
          status: [],
          registered: null,
          expires: null,
          updated: null,
          registrar: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    if (loggedIn && client) await client.logout().catch(() => {});
  }

  const record: WhoisRecord = { timestamp, domains: results };
  await env.INWX_BOT.put(WHOIS_KEY, JSON.stringify(record, null, 2));
  await processExpiryAlerts(env, results, settings.expiryAlertDays);
  return record;
}

/** Notify once per crossed threshold as an owned/registered domain nears expiry. */
async function processExpiryAlerts(env: Env, results: WhoisInfo[], thresholds: number[]): Promise<void> {
  const state = await loadState(env);
  const alerts: string[] = [];

  for (const w of results) {
    const st: DomainState = state[w.domain] ?? {};
    // Reset the notified thresholds if the expiry date changed (e.g. renewed).
    if (st.expires !== (w.expires ?? null)) {
      st.expires = w.expires ?? null;
      st.notifiedExpiryDays = [];
    }
    const left = daysUntil(w.expires);
    if (left !== null && left >= 0) {
      const notified = st.notifiedExpiryDays ?? [];
      const crossed = thresholds.filter((t) => left <= t && !notified.includes(t));
      if (crossed.length > 0) {
        alerts.push(`${w.domain}: läuft in ${left} Tag(en) ab (${(w.expires ?? "").slice(0, 10)})`);
        st.notifiedExpiryDays = [...notified, ...crossed];
      }
    }
    state[w.domain] = st;
  }

  await saveState(env, state);
  if (alerts.length > 0) {
    await notify(env, `INWX-Bot: Ablauf-Warnung – ${alerts.join("; ")}`, { expiring: alerts });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ");
  return scheme === "Bearer" && token === env.ADMIN_TOKEN;
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Web dashboard (public shell; data calls below need the admin token).
  if (request.method === "GET" && (path === "/" || path === "/dashboard")) {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    return new Response(dashboardPage(nonce), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; ` +
          `connect-src 'self'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  }

  // Public, low-detail status endpoint (no domain details leaked).
  if (request.method === "GET" && path === "/api/status") {
    const [raw, whoisRaw, settings] = await Promise.all([
      env.INWX_BOT.get(RESULTS_JSON_KEY),
      env.INWX_BOT.get(WHOIS_KEY),
      loadSettings(env),
    ]);
    const last = raw ? (JSON.parse(raw) as RunRecord) : null;
    const whois = whoisRaw ? (JSON.parse(whoisRaw) as WhoisRecord) : null;
    return json({
      ok: true,
      service: "inwx-bot worker",
      dryRun: settings.dryRun,
      authConfigured: Boolean(env.ADMIN_TOKEN),
      lastRun: last?.timestamp ?? null,
      lastRunDomains: last?.statuses.length ?? 0,
      lastRunError: last?.error ?? null,
      whoisLastRun: whois?.timestamp ?? null,
    });
  }

  // Everything below requires the admin bearer token, with per-IP throttling
  // to slow down brute-force attempts.
  const ip = request.headers.get("cf-connecting-ip");
  if (await isThrottled(env, ip)) {
    return json({ error: "too many failed attempts – try again later" }, 429);
  }
  if (!isAuthorized(request, env)) {
    await recordAuthFailure(env, ip);
    return unauthorized();
  }
  await clearAuthFailures(env, ip);

  if (request.method === "GET" && path === "/api/results.csv") {
    const csv = (await env.INWX_BOT.get(RESULTS_CSV_KEY)) ?? "";
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8" } });
  }

  if (request.method === "GET" && path === "/api/results.json") {
    const raw = await env.INWX_BOT.get(RESULTS_JSON_KEY);
    return new Response(raw ?? "{}", { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (path === "/api/domains") {
    if (request.method === "GET") {
      return json({ domains: await loadDomainConfigs(env) });
    }
    if (request.method === "PUT" || request.method === "POST") {
      const domains = parseDomainConfigs(await request.text());
      await env.INWX_BOT.put(DOMAINS_KEY, JSON.stringify(domains));
      await audit(env, request, "domains.save", `${domains.length} domains`);
      return json({ ok: true, count: domains.length, domains });
    }
  }

  if (request.method === "POST" && path === "/api/run") {
    await audit(env, request, "run", url.searchParams.get("async") === "true" ? "async" : "sync");
    // `?async=true` returns immediately and runs in the background; otherwise
    // the run completes inline (suitable for small lists / manual triggers).
    if (url.searchParams.get("async") === "true") {
      ctx.waitUntil(withLock(env, () => runAndStore(env)).then(() => undefined));
      return json({ ok: true, started: true }, 202);
    }
    const outcome = await withLock(env, () => runAndStore(env));
    if (outcome.skipped) return json({ ok: false, error: "a run is already in progress" }, 409);
    return json({ ok: !outcome.result.error, ...outcome.result });
  }

  if (request.method === "POST" && path === "/api/buy") {
    let body: { domain?: string } = {};
    try {
      body = (await request.json()) as { domain?: string };
    } catch {
      // ignore malformed body
    }
    const domain = (body.domain ?? "").trim();
    if (!domain) return json({ ok: false, error: "domain required" }, 400);
    await audit(env, request, "buy", domain);
    const outcome = await withLock(env, () => buyDomainNow(env, domain));
    if (outcome.skipped) return json({ ok: false, error: "a run is already in progress" }, 409);
    return json({ domain, ...outcome.result });
  }

  if (request.method === "GET" && path === "/api/whois") {
    const raw = await env.INWX_BOT.get(WHOIS_KEY);
    return new Response(raw ?? "{}", { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (request.method === "POST" && path === "/api/whois/refresh") {
    await audit(env, request, "whois.refresh");
    if (url.searchParams.get("async") === "true") {
      ctx.waitUntil(withLock(env, () => refreshWhois(env)).then(() => undefined));
      return json({ ok: true, started: true }, 202);
    }
    const outcome = await withLock(env, () => refreshWhois(env));
    if (outcome.skipped) return json({ ok: false, error: "a refresh is already in progress" }, 409);
    return json({ ok: true, ...outcome.result });
  }

  if (request.method === "GET" && path === "/api/history") {
    const raw = await env.INWX_BOT.get(HISTORY_KEY);
    return new Response(raw ?? "[]", { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (path === "/api/settings") {
    if (request.method === "GET") {
      const [effective, override] = await Promise.all([
        loadSettings(env),
        readJson<SettingsOverride>(env, SETTINGS_KEY, {}),
      ]);
      return json({ effective, override });
    }
    if (request.method === "PUT" || request.method === "POST") {
      let body: SettingsOverride = {};
      try {
        body = (await request.json()) as SettingsOverride;
      } catch {
        // ignore malformed body
      }
      const override: SettingsOverride = {};
      if (typeof body.dryRun === "boolean") override.dryRun = body.dryRun;
      if (typeof body.apiDelayMs === "number" && Number.isFinite(body.apiDelayMs) && body.apiDelayMs >= 0) {
        override.apiDelayMs = body.apiDelayMs;
      }
      if (Array.isArray(body.expiryAlertDays)) {
        const days = body.expiryAlertDays.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
        if (days.length > 0) override.expiryAlertDays = days;
      }
      if (typeof body.renewalMode === "string" && body.renewalMode) override.renewalMode = body.renewalMode;
      if (typeof body.period === "string") override.period = body.period;
      if (typeof body.transferLock === "boolean") override.transferLock = body.transferLock;
      await env.INWX_BOT.put(SETTINGS_KEY, JSON.stringify(override));
      await audit(env, request, "settings.save", JSON.stringify(override));
      return json({ ok: true, override, effective: await loadSettings(env) });
    }
    if (request.method === "DELETE") {
      // Drop all overrides and fall back to the wrangler.toml defaults.
      await env.INWX_BOT.delete(SETTINGS_KEY);
      await audit(env, request, "settings.reset");
      return json({ ok: true, override: {}, effective: await loadSettings(env) });
    }
  }

  if (request.method === "POST" && path === "/api/check") {
    let body: { domain?: string; keyword?: string; tlds?: string[] } = {};
    try {
      body = (await request.json()) as { domain?: string; keyword?: string; tlds?: string[] };
    } catch {
      // ignore malformed body
    }
    const targets = expandCheckTargets(body);
    if (targets.length === 0) return json({ ok: false, error: "provide a domain, or a keyword + tlds" }, 400);
    if (!env.INWX_USERNAME || !env.INWX_PASSWORD) {
      return json({ ok: false, error: "INWX credentials not configured" });
    }
    await audit(env, request, "check", targets.join(","));
    try {
      const outcome = await withLock(env, () => runAdhocCheck(env, targets));
      if (outcome.skipped) return json({ ok: false, error: "a run is already in progress" }, 409);
      return json({ ok: true, results: outcome.result });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (request.method === "GET" && path === "/api/audit") {
    const raw = await env.INWX_BOT.get(AUDIT_KEY);
    return new Response(raw ?? "[]", {
      headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }

  if (request.method === "GET" && path === "/api/export") {
    const [domains, settings] = await Promise.all([
      loadDomainConfigs(env),
      readJson<SettingsOverride>(env, SETTINGS_KEY, {}),
    ]);
    return new Response(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), domains, settings }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="inwx-bot-backup.json"',
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (request.method === "POST" && path === "/api/import") {
    let body: { domains?: unknown; settings?: SettingsOverride } = {};
    try {
      body = (await request.json()) as { domains?: unknown; settings?: SettingsOverride };
    } catch {
      return json({ ok: false, error: "invalid JSON" }, 400);
    }
    const restored: string[] = [];
    if (Array.isArray(body.domains)) {
      const domains = body.domains.map(normalizeConfig).filter((c): c is DomainConfig => c !== null);
      await env.INWX_BOT.put(DOMAINS_KEY, JSON.stringify(domains));
      restored.push(`${domains.length} domains`);
    }
    if (body.settings && typeof body.settings === "object") {
      await env.INWX_BOT.put(SETTINGS_KEY, JSON.stringify(body.settings));
      restored.push("settings");
    }
    await audit(env, request, "import", restored.join(", ") || "nothing");
    return json({ ok: true, restored });
  }

  return json({ error: "not found" }, 404);
}

/** Dead-man's-switch ping: an external monitor alerts if these stop arriving. */
async function pingHeartbeat(env: Env): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  try {
    await fetch(env.HEARTBEAT_URL, { method: "GET" });
  } catch {
    // best-effort
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Split the work across cron triggers so each invocation gets its own
    // subrequest budget. Unknown cron values fall back to running both.
    let task: () => Promise<void>;
    if (event.cron === RUN_CRON) {
      task = async () => {
        await runAndStore(env);
      };
    } else if (event.cron === WHOIS_CRON) {
      task = async () => {
        await refreshWhois(env);
      };
    } else {
      task = async () => {
        await runAndStore(env);
        await refreshWhois(env);
      };
    }
    // A lock guards against overlap with a manual run; the heartbeat fires
    // afterwards regardless, so a stalled cron is detected externally.
    ctx.waitUntil(withLock(env, task).then(() => pingHeartbeat(env)));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Re-exported for unit tests (see test/).
export {
  normalizeConfig,
  parseDomainConfigs,
  toCsv,
  countsOf,
  detectRunChanges,
  parseThresholds,
  daysUntil,
  mergeSettings,
  expandCheckTargets,
  chunk,
};
export type { DomainConfig, DomainStatus, Action, StateMap, Settings, SettingsOverride };
