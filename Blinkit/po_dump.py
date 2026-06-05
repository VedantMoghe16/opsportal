"""Bulk PO report — trigger, wait, download, save locally.

Body shape per CLAUDE.md endpoint table:
    {filters: {issue_date__gte: "YYYY-MM-DD", issue_date__lte: "YYYY-MM-DD"}}

Run as a CLI (default range = last 30 days, IST):
    python -m blinkit_scraper.reports.po_dump
    python -m blinkit_scraper.reports.po_dump --since 2026-04-01 --until 2026-05-15

Lands a single file at:
    <DOWNLOAD_DIR>/po_dump/<YYYY-MM-DD>.<csv|xlsx>
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import structlog

from blinkit_scraper.auth import BlinkitAuth
from blinkit_scraper.client import BlinkitClient
from blinkit_scraper.gmail_otp import GmailOTPReader
from blinkit_scraper.settings import Settings, get_settings

log = structlog.get_logger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))


def download_po_dump(
    settings: Settings,
    client: BlinkitClient,
    since: date,
    until: date,
) -> Path:
    snapshot_label = datetime.now(IST).strftime("%Y-%m-%d")
    out_dir = settings.download_dir / "po_dump"
    body = {
        "filters": {
            "issue_date__gte": since.isoformat(),
            "issue_date__lte": until.isoformat(),
        }
    }
    return client.run_report(
        trigger_path="/v1/reports/bulk-po-excel/",
        trigger_body=body,
        out_dir=out_dir,
        snapshot_label=snapshot_label,
        report_kind="po",
    )


def _configure_logging(level: str) -> None:
    logging.basicConfig(format="%(message)s", level=level)
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
    )


def main() -> int:
    today_ist = datetime.now(IST).date()
    default_since = today_ist - timedelta(days=30)

    parser = argparse.ArgumentParser(prog="blinkit_scraper.reports.po_dump")
    parser.add_argument(
        "--since",
        type=date.fromisoformat,
        default=default_since,
        help="issue_date__gte (YYYY-MM-DD). Default: 30 days ago (IST).",
    )
    parser.add_argument(
        "--until",
        type=date.fromisoformat,
        default=today_ist,
        help="issue_date__lte (YYYY-MM-DD). Default: today (IST).",
    )
    args = parser.parse_args()

    settings = get_settings()
    _configure_logging(settings.log_level)

    auth = BlinkitAuth(settings, GmailOTPReader(settings))
    tokens = auth.get_tokens()

    client = BlinkitClient(settings, tokens)
    log.info("po.range", since=args.since.isoformat(), until=args.until.isoformat())
    path = download_po_dump(settings, client, args.since, args.until)
    log.info("po.done", path=str(path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
