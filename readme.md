This project is a bot for [INWX.de](https://github.com/inwx) that checks the availability of domains. If a domain is available, the bot automatically registers it through the INWX API.

There are two ways to run it:

- **CLI script** (this document): a Python script you run on demand or via cron.
- **Cloudflare Worker** (serverless, scheduled): see
  [`cloudflare-worker/`](cloudflare-worker/README.md). It runs on a Cron
  Trigger, stores the domain list and results in Workers KV, and needs no
  server of your own.

## install dependencies
```
pip install -r requirements.txt
```

## change access data
Fill in your access data into `.env.sample` and rename it to `.env`.

Most of the required data to buy a domain will be fetched automatically.
If you want to use custom parameters fill in the data in the `.env` and pass it to the buy function.

## prepare domain list
Copy `domains.txt.sample` to `domains.txt` and add one domain per line:
```
cp domains.txt.sample domains.txt
```

## start script
```
python check_domain.py
```

Output: live status per domain on stdout, a summary table, and a CSV
report (`domain_status.csv` by default). Detailed logs are written to
`log.txt`.

## configuration

The following environment variables are recognised (all optional except
`username` / `password`):

| Variable            | Default              | Description                              |
|---------------------|----------------------|------------------------------------------|
| `username`          | —                    | INWX login                               |
| `password`          | —                    | INWX password                            |
| `ns1`, `ns2`        | —                    | Optional nameservers used on purchase    |
| `domains_file`      | `domains.txt`        | Path to the input domain list            |
| `csv_file`          | `domain_status.csv`  | Path to the result CSV                   |
| `log_file`          | `log.txt`            | Path to the log file                     |
| `api_delay_seconds` | `1.0`                | Delay between API calls (rate limiting)  |

## development

Install dev dependencies and run the tests / linter:
```
pip install -r requirements-dev.txt
pytest
ruff check .
```

## todo
- [ ] Implement the optional arguments for domain registration
