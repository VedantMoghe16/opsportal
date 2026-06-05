"""Blinkit OTP login orchestrator.

Pure-HTTP login flow against partnersbiz.com (no browser):

    1. POST /auth/api/v1/email/send_otp      → triggers OTP email
    2. <Gmail poll via GmailOTPReader>        → reads OTP from inbox
    3. POST /auth/api/v1/email/verify_otp    → returns access + refresh tokens

Public surface:
    BlinkitAuth(settings, gmail).get_tokens(force_refresh=False) -> BlinkitTokens

Run as a CLI to test end-to-end:
    python -m blinkit_scraper.auth
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog

from blinkit_scraper.gmail_otp import GmailOTPReader, OTPNotFoundError
from blinkit_scraper.settings import Settings, get_settings
from blinkit_scraper.tokens import BlinkitTokens

log = structlog.get_logger(__name__)


class BlinkitAuthError(RuntimeError):
    """The Blinkit auth API returned an unexpected status / shape."""


def _public_headers(settings: Settings) -> dict[str, str]:
    """Headers for unauthenticated calls (send_otp, verify_otp)."""
    headers = {
        "accept": "application/json, text/plain, */*",
        "app_client": "partnersbiz-web",
        "content-type": "application/x-www-form-urlencoded",
        "origin": settings.blinkit_base_url,
        "referer": f"{settings.blinkit_base_url}/",
        "service": "partnersbiz",
        "user-agent": "Mozilla/5.0 (compatible; niche-scraper/0.1)",
    }
    api_key = settings.blinkit_api_key.get_secret_value()
    if api_key:
        headers["x-api-key"] = api_key
    return headers


class BlinkitAuth:
    def __init__(
        self,
        settings: Settings,
        gmail: GmailOTPReader,
        http: httpx.Client | None = None,
    ) -> None:
        self._settings = settings
        self._gmail = gmail
        self._http = http or httpx.Client(base_url=settings.blinkit_base_url, timeout=30.0)

    def get_tokens(self, force_refresh: bool = False) -> BlinkitTokens:
        """Return cached tokens if present (and not forcing refresh), else run full OTP login."""
        if not force_refresh:
            cached = BlinkitTokens.load(self._settings.blinkit_token_file)
            if cached is not None:
                log.info("auth.using_cached_tokens", saved_at=cached.saved_at.isoformat())
                return cached
        return self.login()

    def login(self) -> BlinkitTokens:
        """Full OTP login: send → poll Gmail → verify → persist + return."""
        sent_at = datetime.now(timezone.utc)
        self._send_otp()
        code = self._gmail.wait_for_otp(sent_after=sent_at)
        tokens = self._verify_otp(code)
        tokens.save(self._settings.blinkit_token_file)
        log.info("auth.login_complete", token_file=str(self._settings.blinkit_token_file))
        return tokens

    def _send_otp(self) -> None:
        email = self._settings.blinkit_email
        log.info("auth.send_otp", email=email)
        resp = self._http.post(
            "/auth/api/v1/email/send_otp",
            headers=_public_headers(self._settings),
            data={"email_id": email},
        )
        if resp.status_code != 200:
            raise BlinkitAuthError(f"send_otp failed: HTTP {resp.status_code} body={resp.text[:200]}")

    def _verify_otp(self, code: str) -> BlinkitTokens:
        email = self._settings.blinkit_email
        log.info("auth.verify_otp", email=email)
        resp = self._http.post(
            "/auth/api/v1/email/verify_otp",
            headers=_public_headers(self._settings),
            data={"email_id": email, "verify_code": code},
        )
        if resp.status_code != 200:
            raise BlinkitAuthError(f"verify_otp failed: HTTP {resp.status_code} body={resp.text[:200]}")

        data: dict[str, Any] = resp.json()
        if not data.get("success") or not data.get("access_token"):
            raise BlinkitAuthError(f"verify_otp returned no tokens: keys={list(data.keys())}")

        return BlinkitTokens(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token", ""),
            user=data.get("user"),
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
    settings = get_settings()
    _configure_logging(settings.log_level)

    gmail = GmailOTPReader(settings)
    auth = BlinkitAuth(settings, gmail)

    try:
        tokens = auth.login()
    except OTPNotFoundError as exc:
        log.error("auth.otp_missing", error=str(exc))
        return 1
    except BlinkitAuthError as exc:
        log.error("auth.failed", error=str(exc))
        return 1
    except FileNotFoundError as exc:
        log.error("auth.gmail_token_missing", error=str(exc))
        return 1

    log.info(
        "auth.ok",
        token_file=str(settings.blinkit_token_file),
        saved_at=tokens.saved_at.isoformat(),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
