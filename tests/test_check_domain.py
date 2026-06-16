import csv
import sys
import types
from pathlib import Path

import pytest

# Stub the INWX SDK so that importing check_domain works without the real
# package being installed (it's a network-only dependency).
inwx_module = types.ModuleType("INWX")
domrobot_module = types.ModuleType("INWX.Domrobot")


class _StubApiClient:
    API_LIVE_URL = "https://example.invalid/"

    def __init__(self, *args, **kwargs):
        pass


domrobot_module.ApiClient = _StubApiClient
sys.modules.setdefault("INWX", inwx_module)
sys.modules.setdefault("INWX.Domrobot", domrobot_module)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_domain  # noqa: E402


def test_load_domains_strips_blank_lines(tmp_path):
    path = tmp_path / "domains.txt"
    path.write_text("foo.de\n\n  bar.de  \n\nbaz.de\n", encoding="utf-8")
    assert check_domain.load_domains(path) == ["foo.de", "bar.de", "baz.de"]


def test_load_domains_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        check_domain.load_domains(tmp_path / "missing.txt")


def test_write_csv_roundtrip(tmp_path):
    csv_path = tmp_path / "out.csv"
    statuses = [
        {
            "domain": "foo.de",
            "available": True,
            "action": "purchased",
            "detail": "success",
            "api_code": 1000,
            "api_msg": "ok",
        },
        {
            "domain": "bar.de",
            "available": False,
            "action": "skipped",
            "detail": "already registered",
            "api_code": 1000,
            "api_msg": "domain not available",
        },
    ]
    check_domain.write_csv(csv_path, statuses)

    with csv_path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert [r["domain"] for r in rows] == ["foo.de", "bar.de"]
    assert rows[0]["action"] == "purchased"
    assert rows[1]["available"] == "False"


def test_inwx_api_error_message():
    err = check_domain.InwxApiError(2303, "Object does not exist", "during domain check")
    assert err.code == 2303
    assert "2303" in str(err)
    assert "during domain check" in str(err)


def test_call_raises_on_non_success(monkeypatch):
    monkeypatch.setattr(
        check_domain.api_client,
        "call_api",
        lambda action, params: {"code": 2400, "msg": "boom"},
        raising=False,
    )
    with pytest.raises(check_domain.InwxApiError) as info:
        check_domain._call("domain.check", {"domain": "x.de"}, "ctx")
    assert info.value.code == 2400


def test_call_returns_result_on_success(monkeypatch):
    payload = {"code": 1000, "resData": {"ok": True}}
    monkeypatch.setattr(
        check_domain.api_client,
        "call_api",
        lambda action, params: payload,
        raising=False,
    )
    assert check_domain._call("account.info") is payload
