"""Authenticated HTTP client for the Blinkit partnersbiz API.

Wraps httpx with the five headers Blinkit's report endpoints require:
    access_token, token (duplicate), x-api-key, x-entity-id, x-entity-type

Plus a `run_report()` orchestrator: trigger → poll → download → save. Both
SOH and Bulk PO share that flow; only the trigger path/body and output dir differ.
"""

from __future__ import annotations

import mimetypes
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
import structlog

from blinkit_scraper.settings import Settings
from blinkit_scraper.tokens import BlinkitTokens

log = structlog.get_logger(__name__)

# Status values observed on partnersbiz that indicate "ready to download"
READY_STATUSES = {"completed", "complete", "success", "finished", "ready", "done"}
FAILED_STATUSES = {"failed", "error", "errored"}


class BlinkitAPIError(RuntimeError):
    """An authenticated Blinkit API call returned an unexpected status."""


class ReportTimeout(RuntimeError):
    """A report didn't reach a terminal status within the wait budget."""


class BlinkitClient:
    def __init__(
        self,
        settings: Settings,
        tokens: BlinkitTokens,
        http: httpx.Client | None = None,
    ) -> None:
        self._settings = settings
        self._tokens = tokens
        self._http = http or httpx.Client(base_url=settings.blinkit_base_url, timeout=60.0)

    def _auth_headers(self, content_type: str = "application/json") -> dict[str, str]:
        s = self._settings
        return {
            "accept": "application/json, text/plain, */*",
            "app_client": "partnersbiz-web",
            "content-type": content_type,
            "origin": s.blinkit_base_url,
            "referer": f"{s.blinkit_base_url}/",
            "service": "partnersbiz",
            "user-agent": "Mozilla/5.0 (compatible; niche-scraper/0.1)",
            "x-api-key": s.blinkit_api_key.get_secret_value(),
            "x-entity-id": s.blinkit_entity_id,
            "x-entity-type": s.blinkit_entity_type,
            "access_token": self._tokens.access_token,
            "token": self._tokens.access_token,
        }

    # --- report endpoints -------------------------------------------------

    def trigger_report(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        log.info("report.trigger", path=path)
        resp = self._http.post(path, headers=self._auth_headers(), json=body)
        if resp.status_code != 200:
            raise BlinkitAPIError(
                f"trigger {path} failed: HTTP {resp.status_code} body={resp.text[:300]}"
            )
        try:
            payload = resp.json()
        except Exception:
            payload = {}
        inner = _peel_envelope(payload)
        log.info(
            "report.trigger_response",
            keys=list(inner.keys()) if isinstance(inner, dict) else type(inner).__name__,
        )
        return inner if isinstance(inner, dict) else {}

    def list_report_requests(self) -> list[dict[str, Any]]:
        resp = self._http.post(
            "/v1/report-requests/", headers=self._auth_headers(), json={}
        )
        if resp.status_code != 200:
            raise BlinkitAPIError(
                f"list report-requests failed: HTTP {resp.status_code} body={resp.text[:300]}"
            )
        inner = _peel_envelope(resp.json())
        if isinstance(inner, list):
            return inner
        # partnersbiz returns {"reports": [...]}; tolerate a few other shapes too
        for k in ("reports", "results", "report_requests", "items", "data"):
            if isinstance(inner, dict) and isinstance(inner.get(k), list):
                return inner[k]
        return []

    def download_request(self, request_id: str) -> tuple[bytes, str | None]:
        # Step 1: partnersbiz returns a JSON envelope with a pre-signed S3 URL.
        # The path genuinely has a double-slash — confirmed in CLAUDE.md endpoint table.
        path = f"/v1/report-requests/download//{request_id}/"
        resp = self._http.get(path, headers=self._auth_headers())
        if resp.status_code != 200:
            raise BlinkitAPIError(
                f"download {request_id} failed: HTTP {resp.status_code} body={resp.text[:300]}"
            )
        inner = _peel_envelope(resp.json())
        download_url = inner.get("download_url") if isinstance(inner, dict) else None
        if not isinstance(download_url, str) or not download_url:
            raise BlinkitAPIError(
                f"download {request_id}: no download_url in response: {str(inner)[:300]}"
            )

        # Step 2: fetch the pre-signed S3 URL with a plain GET (no partnersbiz auth headers).
        log.info("report.s3_fetch", request_id=request_id)
        s3_resp = httpx.get(download_url, timeout=120.0)
        if s3_resp.status_code != 200:
            raise BlinkitAPIError(
                f"s3 download {request_id} failed: HTTP {s3_resp.status_code} "
                f"body={s3_resp.text[:300]}"
            )

        # Prefer Content-Disposition, fall back to the path component of the URL.
        filename = _parse_content_disposition(s3_resp.headers.get("content-disposition", ""))
        if not filename:
            filename = Path(urlparse(download_url).path).name or None
        return s3_resp.content, filename

    # --- high-level orchestrator -----------------------------------------

    def run_report(
        self,
        trigger_path: str,
        trigger_body: dict[str, Any],
        out_dir: Path,
        snapshot_label: str,
        report_kind: str,
        poll_interval_seconds: int = 10,
        max_wait_seconds: int = 300,
    ) -> Path:
        """Trigger → poll → download → save. Returns the saved file path."""
        triggered_at = datetime.now(timezone.utc)
        trigger_response = self.trigger_report(trigger_path, trigger_body)

        request_id = _extract_request_id(trigger_response)
        if request_id:
            log.info("report.request_id_from_trigger", id=request_id)
        else:
            log.info("report.discovering_request_id", triggered_at=triggered_at.isoformat())

        deadline = time.monotonic() + max_wait_seconds
        last_status: str | None = None

        while True:
            requests_list = self.list_report_requests()
            entry = _find_entry(requests_list, request_id, triggered_at, report_kind)

            if entry is None:
                if request_id is None:
                    log.info(
                        "report.no_match_yet",
                        list_len=len(requests_list),
                        sample_keys=list(requests_list[0].keys()) if requests_list else [],
                    )
            else:
                if request_id is None:
                    request_id = _extract_request_id(entry)
                    log.info("report.matched", id=request_id)

                status = _normalize_status(entry)
                if status != last_status:
                    log.info("report.status", status=status, id=request_id)
                    last_status = status

                if status in READY_STATUSES:
                    break
                if status in FAILED_STATUSES:
                    raise BlinkitAPIError(f"report {request_id} failed: status={status} entry={entry}")

            if time.monotonic() > deadline:
                raise ReportTimeout(
                    f"{report_kind} report not ready after {max_wait_seconds}s "
                    f"(last_status={last_status}, request_id={request_id})"
                )
            time.sleep(poll_interval_seconds)

        assert request_id is not None
        content, filename_hint = self.download_request(request_id)

        ext = _pick_extension(filename_hint, content)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{snapshot_label}{ext}"
        out_path.write_bytes(content)
        log.info(
            "report.saved",
            path=str(out_path),
            bytes=len(content),
            filename_hint=filename_hint,
        )
        return out_path


# --- helpers ---------------------------------------------------------------


def _peel_envelope(payload: Any) -> Any:
    """partnersbiz wraps responses as {status, instance_name, data, git_branch}.
    Return the `data` field when that shape is present; otherwise return as-is.
    """
    if (
        isinstance(payload, dict)
        and {"status", "data"}.issubset(payload.keys())
        and "instance_name" in payload
    ):
        return payload["data"]
    return payload


_REQUEST_ID_KEYS = ("id", "request_id", "report_request_id", "uuid")
_STATUS_KEYS = ("status", "state", "report_status")
_CREATED_KEYS = ("created_at", "created", "requested_at", "createdAt", "timestamp")
_TYPE_KEYS = ("report_type", "type", "report_name", "name")


def _extract_request_id(obj: dict[str, Any]) -> str | None:
    if not isinstance(obj, dict):
        return None
    # Sometimes nested in {"data": {...}} or {"result": {...}}
    for k in _REQUEST_ID_KEYS:
        v = obj.get(k)
        if isinstance(v, (str, int)) and str(v):
            return str(v)
    for wrapper in ("data", "result", "report_request"):
        nested = obj.get(wrapper)
        if isinstance(nested, dict):
            for k in _REQUEST_ID_KEYS:
                v = nested.get(k)
                if isinstance(v, (str, int)) and str(v):
                    return str(v)
    return None


def _normalize_status(entry: dict[str, Any]) -> str:
    for k in _STATUS_KEYS:
        v = entry.get(k)
        if isinstance(v, str):
            return v.strip().lower()
    return ""


def _entry_created_at(entry: dict[str, Any]) -> datetime | None:
    for k in _CREATED_KEYS:
        v = entry.get(k)
        if not v:
            continue
        if isinstance(v, (int, float)):
            # Heuristic: ms vs s
            secs = v / 1000 if v > 10**11 else v
            return datetime.fromtimestamp(secs, tz=timezone.utc)
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError:
                continue
    return None


def _entry_type_matches(entry: dict[str, Any], report_kind: str) -> bool:
    """Loose match: does any of the type-ish fields contain a substring of report_kind?"""
    needle = report_kind.lower().replace("_", "")
    for k in _TYPE_KEYS:
        v = entry.get(k)
        if isinstance(v, str) and needle in v.lower().replace("_", "").replace("-", ""):
            return True
    return False


def _find_entry(
    listing: list[dict[str, Any]],
    request_id: str | None,
    triggered_at: datetime,
    report_kind: str,
) -> dict[str, Any] | None:
    if request_id is not None:
        for e in listing:
            if str(_extract_request_id(e)) == str(request_id):
                return e
        return None

    # No id yet — pick the newest entry of this report_kind created at/after triggered_at
    candidates: list[tuple[datetime, dict[str, Any]]] = []
    for e in listing:
        if not _entry_type_matches(e, report_kind):
            continue
        ts = _entry_created_at(e)
        if ts is None:
            continue
        if ts >= triggered_at:
            candidates.append((ts, e))
    if not candidates:
        return None
    candidates.sort(key=lambda p: p[0], reverse=True)
    return candidates[0][1]


_CD_FILENAME_RE = re.compile(r'filename\*?=(?:"([^"]+)"|([^;]+))', re.IGNORECASE)


def _parse_content_disposition(header: str) -> str | None:
    if not header:
        return None
    m = _CD_FILENAME_RE.search(header)
    if not m:
        return None
    raw = m.group(1) or m.group(2) or ""
    raw = raw.strip()
    # filename*=UTF-8''<urlencoded>
    if raw.lower().startswith("utf-8''"):
        raw = unquote(raw[7:])
    return raw or None


def _pick_extension(filename_hint: str | None, content: bytes) -> str:
    """Best-effort extension picker. Trusts Content-Disposition first."""
    if filename_hint:
        ext = Path(filename_hint).suffix
        if ext:
            return ext
    # XLSX files are zip archives; .xls is OLE; .csv is text.
    if content[:4] == b"PK\x03\x04":
        return ".xlsx"
    if content[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return ".xls"
    # Default to .csv since the sample SOH "excel" report actually arrived as CSV.
    guessed = mimetypes.guess_extension("text/csv") or ".csv"
    return guessed
