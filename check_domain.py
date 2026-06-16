import csv
import logging
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from INWX.Domrobot import ApiClient

load_dotenv()

LOG_FILE = os.getenv("log_file", "log.txt")
DOMAINS_FILE = os.getenv("domains_file", "domains.txt")
CSV_FILE = os.getenv("csv_file", "domain_status.csv")
API_DELAY_SECONDS = float(os.getenv("api_delay_seconds", "1.0"))

api_client = ApiClient(api_url=ApiClient.API_LIVE_URL, debug_mode=False)


class InwxApiError(Exception):
    def __init__(self, code, msg, context=""):
        self.code = code
        self.msg = msg
        self.context = context
        super().__init__(f"API error {context}. Code: {code}, Message: {msg}")


def setup_logging():
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    fmt = logging.Formatter("%(asctime)s %(levelname)s:%(message)s")
    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)
    console = logging.StreamHandler(sys.stderr)
    console.setLevel(logging.WARNING)
    console.setFormatter(fmt)
    root.addHandler(console)


def _call(action, params=None, context=""):
    """Wrapper around api_client.call_api that enforces a successful response."""
    result = api_client.call_api(action, params or {})
    code = result.get("code")
    if code == 1000:
        return result
    msg = result.get("msg", "")
    logging.error("API error %s. Code: %s, Message: %s", context, code, msg)
    raise InwxApiError(code, msg, context)


def login(username, password):
    result = api_client.login(username, password)
    if result.get("code") != 1000:
        raise InwxApiError(result.get("code"), result.get("msg", ""), "during login")
    logging.info("Login successful.")
    return result


def is_domain_free(domain_name):
    result = _call("domain.check", {"domain": domain_name}, "during domain check")
    return bool(result["resData"]["domain"][0].get("avail", False))


def get_account_info():
    result = _call("account.info", context="while fetching account info")
    logging.info("Account info retrieved successfully.")
    return result["resData"]


def buy_domain(buy_params):
    """Buy a domain (returns (success, code, msg))."""
    result = api_client.call_api("domain.create", buy_params)
    code = result.get("code")
    msg = result.get("msg", "")
    if code == 1000:
        logging.info("Domain %s purchased successfully.", buy_params["domain"])
        return True, code, msg
    logging.error(
        "Failed to purchase domain %s. Code: %s, Message: %s",
        buy_params["domain"], code, msg,
    )
    return False, code, msg


def print_live_status(idx, total, domain, status, detail=""):
    prefix = f"[{idx}/{total}] {domain:<40}"
    line = f"{prefix} → {status}"
    if detail:
        line += f" — {detail}"
    print(line)


def load_domains(path):
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"Domain list file not found: {path}")
    with p.open(encoding="utf-8") as f:
        return [d.strip() for d in f.read().splitlines() if d.strip()]


def write_csv(path, statuses):
    try:
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["domain", "available", "action", "detail", "api_code", "api_msg"],
            )
            writer.writeheader()
            writer.writerows(statuses)
        print(f"\nCSV gespeichert: {path}")
    except OSError as e:
        logging.error("Failed to write CSV: %s", e)
        print(f"\nKonnte CSV nicht schreiben: {e}")


def process_domain(idx, total, domain, account_info, ns):
    available = is_domain_free(domain)
    if not available:
        print_live_status(idx, total, domain, "NICHT VERFÜGBAR")
        return {
            "domain": domain,
            "available": False,
            "action": "skipped",
            "detail": "already registered",
            "api_code": 1000,
            "api_msg": "domain not available",
        }

    print_live_status(idx, total, domain, "VERFÜGBAR", "Kaufe…")
    buy_params = {
        "domain": domain,
        "registrant": account_info["defaultRegistrant"],
        "admin": account_info["defaultAdmin"],
        "tech": account_info["defaultTech"],
        "billing": account_info["defaultBilling"],
    }
    if ns:
        buy_params["ns"] = ns

    success, code, msg = buy_domain(buy_params)
    if success:
        print_live_status(idx, total, domain, "GEKAUFT", "Command completed successfully")
        return {
            "domain": domain,
            "available": True,
            "action": "purchased",
            "detail": "success",
            "api_code": code,
            "api_msg": msg,
        }
    print_live_status(idx, total, domain, "KAUF FEHLGESCHLAGEN", f"Code {code}: {msg}")
    return {
        "domain": domain,
        "available": True,
        "action": "purchase_failed",
        "detail": f"Code {code}: {msg}",
        "api_code": code,
        "api_msg": msg,
    }


def print_summary(statuses):
    print("\nZusammenfassung:")
    header = f"{'Domain':40} {'Avail':5} {'Action':16} {'Detail'}"
    print(header)
    print("-" * len(header))
    for s in statuses:
        avail = {True: "yes", False: "no"}.get(s["available"], "-")
        detail = s["detail"] or ""
        print(f"{s['domain']:40} {avail:5} {s['action']:16} {detail}")


def main():
    setup_logging()
    statuses = []
    logged_in = False
    try:
        username = os.getenv("username")
        password = os.getenv("password")
        if not username or not password:
            raise ValueError("Username or password not set in environment variables.")
        login(username, password)
        logged_in = True

        account_info = get_account_info()
        ns = [v for v in (os.getenv("ns1"), os.getenv("ns2")) if v]

        domains = load_domains(DOMAINS_FILE)
        total = len(domains)
        if total == 0:
            print(f"Keine Domains in {DOMAINS_FILE} gefunden.")
            return

        print(f"Prüfe {total} Domains bei INWX …\n")

        for i, domain in enumerate(domains, start=1):
            if i > 1 and API_DELAY_SECONDS > 0:
                time.sleep(API_DELAY_SECONDS)
            try:
                statuses.append(process_domain(i, total, domain, account_info, ns))
            except Exception as e:
                print_live_status(i, total, domain, "FEHLER", str(e))
                statuses.append({
                    "domain": domain,
                    "available": None,
                    "action": "error",
                    "detail": str(e),
                    "api_code": None,
                    "api_msg": None,
                })

    except Exception as e:
        logging.error("An error occurred: %s", e)
        print(f"\nAbbruch: {e}")
    finally:
        if logged_in:
            try:
                api_client.logout()
                logging.info("Logout successful.")
            except Exception as e:
                logging.warning("Logout failed: %s", e)

    if statuses:
        print_summary(statuses)
        write_csv(CSV_FILE, statuses)


if __name__ == "__main__":
    main()
