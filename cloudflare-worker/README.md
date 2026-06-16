# INWX Bot — Cloudflare Worker

A serverless variant of the [`check_domain.py`](../readme.md) bot. It runs on a
**Cron Trigger** instead of being started by hand, talks to the INWX JSON-RPC
API directly via `fetch` (the Python `requests`-based SDK does not run on
Workers), and stores the domain list and results in **Workers KV**.

## How it works

- Two **Cron Triggers** invoke the Worker: one runs the availability check
  (default 06:00 UTC), the other refreshes WHOIS (06:30 UTC). Splitting them
  keeps each invocation within Cloudflare's per-request subrequest limit.
- It logs in to INWX and checks the domains from the KV list with `domain.check`
  in **batches** (one subrequest per ~30 domains). Each domain has a **mode**:
  `auto` registers it when free (unless `DRY_RUN`), `watch` only reports. An
  optional per-domain **max price** skips auto-purchase when the INWX price
  exceeds the budget. You can also buy an available domain on demand ("Kaufen").
- Registrations use configurable options (`renewalMode`, `period`,
  `transferLock`) — defaulting to auto-renew + transfer-locked.
- Results are written to KV (`results:latest.json` and `results:latest.csv`).
- It also refreshes **WHOIS/registration metadata** per domain (registered /
  expires / last changed / status) and stores it in KV (`whois:latest.json`).
- Each run is recorded in a capped **history** (`history:runs`) shown in the
  dashboard, and a per-domain **state** is kept (`state:domains`).
- A **web dashboard** is served at `/` to view status, edit the domain list,
  trigger a run, view the WHOIS table and the run history, and download the CSV.
- Optional notifications via a Slack/Discord-compatible webhook, **Telegram**
  and/or **email** (Resend) — sent only on **change** (a domain newly available /
  bought / failed, or a new run error), not on every run, plus **expiry alerts**
  as owned domains approach their renewal date (`EXPIRY_ALERT_DAYS` thresholds).
- A best-effort KV **lock** prevents a manual run from overlapping the cron run.
- An optional **heartbeat** (`HEARTBEAT_URL`) is pinged after every cron run, so
  an external dead-man's-switch (e.g. healthchecks.io) can alert if it stalls.

> **Safety first:** `DRY_RUN` defaults to `"true"`, so out of the box the bot
> only *reports* available domains and never spends money. Set it to `"false"`
> in `wrangler.toml` and redeploy once you are confident.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free plan is enough).
- Node.js 18+ and the Wrangler CLI (installed locally via `npm install`).

## Setup

```bash
cd cloudflare-worker
npm install

# 1. Create the KV namespace and copy the printed id into wrangler.toml
#    (replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID).
npx wrangler kv namespace create INWX_BOT

# 2. Store your credentials as secrets (not in wrangler.toml).
npx wrangler secret put INWX_USERNAME
npx wrangler secret put INWX_PASSWORD
npx wrangler secret put ADMIN_TOKEN          # bearer token for the HTTP endpoints
# Optional:
npx wrangler secret put INWX_SHARED_SECRET   # only if 2FA / mobile TAN is enabled
npx wrangler secret put NOTIFY_WEBHOOK_URL   # Slack/Discord webhook
npx wrangler secret put INWX_NS1             # default nameservers on purchase
npx wrangler secret put INWX_NS2

# 3. Deploy.
npx wrangler deploy

# 4. Seed the domain list — easiest in the dashboard at
#    https://inwx-bot.<your-subdomain>.workers.dev/  or via the API.
# Plain list (every entry defaults to mode "auto"):
curl -X PUT https://inwx-bot.<your-subdomain>.workers.dev/api/domains \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  --data-binary $'example.de\nmy-other-domain.com'
# …or full per-domain config as JSON:
curl -X PUT https://inwx-bot.<your-subdomain>.workers.dev/api/domains \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" \
  --data '[{"domain":"example.de","mode":"auto","maxPrice":15},{"domain":"premium.com","mode":"watch"}]'
```

Each entry is `{ "domain", "mode": "auto"|"watch", "maxPrice"?, "tags"?, "notes"? }`.
Plain strings and newline lists stay supported and default to `mode: "auto"`.

You can also set the domain list without the HTTP API:

```bash
npx wrangler kv key put --binding INWX_BOT domains $'example.de\nfoo.com'
```

## Configuration

Non-secret settings live in `wrangler.toml` under `[vars]`:

| Variable        | Default                              | Description                                   |
|-----------------|--------------------------------------|-----------------------------------------------|
| `DRY_RUN`          | `"true"`                             | When true, never registers — only reports.    |
| `API_DELAY_MS`     | `"1000"`                             | Delay between API calls (rate limiting).      |
| `INWX_API_URL`     | `https://api.domrobot.com/jsonrpc/`  | Set to the OT&E URL to test against sandbox.   |
| `EXPIRY_ALERT_DAYS`| `"30,14,7,1"`                        | Days-before-expiry thresholds for alerts.     |
| `RENEWAL_MODE`     | `"AUTORENEW"`                        | `domain.create` renewal mode.                 |
| `TRANSFER_LOCK`    | `"true"`                             | Lock transfers on newly registered domains.   |
| `PERIOD`           | —                                    | Registration period (e.g. `1Y`); empty = min. |
| `WHOIS_PORT43`     | `"false"`                            | Opt-in port-43 WHOIS fallback (see below).    |

Secrets (set with `wrangler secret put`): `INWX_USERNAME`, `INWX_PASSWORD`,
`ADMIN_TOKEN`, and the optional `INWX_SHARED_SECRET`, `NOTIFY_WEBHOOK_URL`,
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (Telegram notifications),
`RESEND_API_KEY` + `EMAIL_TO` + `EMAIL_FROM` (email notifications via Resend),
`HEARTBEAT_URL` (dead-man's-switch ping), `INWX_NS1`, `INWX_NS2`.

Notifications are sent to every configured channel (Slack/Discord webhook and/or
Telegram). Responses carry a strict CSP and `X-Content-Type-Options: nosniff`.
Registration options and the runtime settings above can also be changed from the
dashboard without a redeploy.

The schedule is the two-entry `crons` array in `wrangler.toml` (run + WHOIS);
keep it in sync with `RUN_CRON` / `WHOIS_CRON` in `src/index.ts`.

## Dashboard

Open the Worker URL (`https://inwx-bot.<your-subdomain>.workers.dev/`) in a
browser. The page is public, but all data is gated behind the admin token:
enter your `ADMIN_TOKEN` once (kept in the browser's `sessionStorage`) to

- see the last run's status and per-domain results, including the **price**,
- edit the domain list in a table (mode `auto`/`watch`, max price, tags, notes),
- **buy an available domain on demand** ("Kaufen" button — the confirmation shows
  the price, the row updates immediately, and a notification is sent),
- trigger a check immediately ("Jetzt prüfen"),
- run an ad-hoc **quick check** for a domain or a keyword across several TLDs,
- view the **WHOIS / domain-status table** (registered / expires / last changed /
  status per domain; expiry within 30 days is highlighted) and refresh it,
- **filter and sort** the results and WHOIS tables (type to filter, click a
  column header to sort),
- review the run **history** and the **audit log**, download the CSV, or
  **download a full backup** (domains + settings) for safekeeping,
- change **settings** (dry-run, API delay, expiry thresholds, registration
  options) without redeploying, or **reset** them to the `wrangler.toml` defaults.

A strict Content-Security-Policy (nonce-based, no external assets) is applied,
and the admin token is protected by per-IP brute-force throttling.

### Settings overrides

`wrangler.toml` `[vars]` provide the safe defaults; the dashboard (or
`PUT /api/settings`) can override `dryRun`, `apiDelayMs` and `expiryAlertDays`
at runtime — stored in KV (`settings:config`) and applied without a redeploy.
Toggling dry-run off from the dashboard asks for confirmation first.

> **Note:** a stored override **persists across deploys** until you reset it.
> Use the dashboard's "Auf Standard zurücksetzen" button or `DELETE /api/settings`
> to drop all overrides and fall back to `wrangler.toml`.

### WHOIS / domain status

Registration metadata is gathered per domain from two sources:

- **INWX `domain.info`** for domains in your own account — authoritative dates
  (registered / expires / last changed) and status, works for every TLD.
- **RDAP** (the JSON successor to WHOIS) for all other domains. Some ccTLDs —
  notably **.de** (DENIC) — aren't covered by RDAP; for those the table reports
  the dates as *unknown* (rather than falsely "available") unless port-43 is on.
- **Port-43 WHOIS** (opt-in via `WHOIS_PORT43="true"`): a raw WHOIS query over
  TCP for the handful of ccTLDs RDAP doesn't cover. It's best-effort and
  time-boxed (5 s) so it can never stall a run — many registries block
  datacenter IPs, so it often returns nothing, and DENIC never publishes
  registration/expiry anyway (only status + last change).

The table refreshes on each cron run and via the "WHOIS aktualisieren" button.

## HTTP endpoints

`GET /` (dashboard) and `GET /api/status` are public. Everything else requires
`Authorization: Bearer <ADMIN_TOKEN>`.

| Method & path             | Description                                              |
|---------------------------|----------------------------------------------------------|
| `GET /`                   | Web dashboard (HTML).                                    |
| `GET /api/status`         | Health/status: dry-run mode, last run time, last error.  |
| `GET /api/domains`        | Current domain list (array of per-domain config objects).|
| `PUT /api/domains`        | Replace the list (config JSON, string array, or text).   |
| `POST /api/run`           | Run the check now and return the result.                 |
| `POST /api/run?async=true`| Start a run in the background, return `202` immediately. |
| `POST /api/buy`           | Register one available domain now: `{"domain":"x.de"}`.  |
| `GET /api/results.json`   | Full result of the last run.                             |
| `GET /api/results.csv`    | Last run as CSV (same columns as the Python script).     |
| `GET /api/whois`          | WHOIS/registration metadata per domain (last refresh).   |
| `POST /api/whois/refresh` | Refresh WHOIS data now (`?async=true` for background).    |
| `GET /api/history`        | Recent run history (capped list, newest first).          |
| `GET /api/settings`       | Effective settings + the stored KV override.             |
| `PUT /api/settings`       | Override `dryRun` / `apiDelayMs` / `expiryAlertDays`.    |
| `DELETE /api/settings`    | Reset overrides to the `wrangler.toml` defaults.         |
| `POST /api/check`         | Ad-hoc check: `{"domain"}` or `{"keyword","tlds":[]}`.   |
| `GET /api/audit`          | Recent admin actions (capped, newest first).             |
| `GET /api/export`         | Download a backup of the domain list + settings (JSON).  |
| `POST /api/import`        | Restore from a backup: `{"domains":[…],"settings":{…}}`.  |

`POST /api/run`, `POST /api/whois/refresh`, `POST /api/buy` and `POST /api/check`
return `409` if another run is already in progress (best-effort KV lock).
`POST /api/buy` is an explicit action and **ignores `DRY_RUN` and the per-domain
mode** — it always attempts the real (paid) registration. After too many failed
token attempts from one IP, protected endpoints return `429` for a few minutes.

## Local development

```bash
cp .dev.vars.sample .dev.vars   # fill in credentials (gitignored)
npm run dev                     # wrangler dev
npm run typecheck               # tsc --noEmit
npm test                        # vitest run (unit tests in test/)
```

Tip: test against the INWX OT&E sandbox first by uncommenting `INWX_API_URL`
in `wrangler.toml`.
