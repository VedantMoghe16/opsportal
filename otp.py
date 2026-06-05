import imaplib
import email
import re
import time
from datetime import datetime
from email.header import decode_header
from html import unescape

# ─────────────────────────────────────────
#  CONFIGURATION — fill these in
# ─────────────────────────────────────────
EMAIL_ADDRESS = "amritya@moxiebeauty.in"       # The email to monitor
EMAIL_PASSWORD = "ravr ioel ssnf syxc"  # Use App Password (see notes below)
CHECK_INTERVAL = 15                        # Seconds between checks

# IMAP server settings — pick your provider:
IMAP_SERVERS = {
    "gmail":   ("imap.gmail.com",    993),
    "outlook": ("outlook.office365.com", 993),
    "yahoo":   ("imap.mail.yahoo.com",   993),
    "zoho":    ("imap.zoho.com",     993),
    "custom":  ("imap.yourdomain.com",   993),  # replace for custom domains
}
PROVIDER = "gmail"  # Change to your provider key above
IMAP_HOST, IMAP_PORT = IMAP_SERVERS[PROVIDER]

# ─────────────────────────────────────────
#  OTP EXTRACTION PATTERNS
# ─────────────────────────────────────────
# Keywords that typically appear right before the real code. Digits found
# near one of these win over any random number elsewhere in the email.
OTP_KEYWORDS = (
    "otp", "code", "verification", "verify", "passcode",
    "one time password", "one-time password", "security code",
    "login code", "sign in", "sign-in", "token",
)

# A standalone 4–8 digit run (the code itself, not part of a longer number).
CODE_RE = re.compile(r'(?<!\d)(\d{4,8})(?!\d)')

# OTP rendered as separate digit-boxes/spans collapses to single digits split
# by spaces/dashes after tag-stripping, e.g. "3 9 1 4 0 2". Capture & rejoin.
SPACED_CODE_RE = re.compile(r'(?<!\d)(\d(?:[ \t.\- ]+\d){3,7})(?!\d)')

# Numbers we should never treat as an OTP (years, etc.).
def _looks_like_year(s):
    return len(s) == 4 and 1900 <= int(s) <= 2099

# ─────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────
def connect(host, port, user, password):
    mail = imaplib.IMAP4_SSL(host, port)
    mail.login(user, password)
    return mail


def decode_str(value):
    if value is None:
        return ""
    decoded, enc = decode_header(value)[0]
    if isinstance(decoded, bytes):
        return decoded.decode(enc or "utf-8", errors="ignore")
    return decoded


def _html_to_text(html):
    """Strip an HTML body down to readable text (no external deps)."""
    html = re.sub(r'(?is)<(script|style|head)[^>]*>.*?</\1>', ' ', html)
    html = re.sub(r'(?s)<[^>]+>', ' ', html)          # drop all tags
    html = unescape(html)                              # &amp; → & etc.
    return re.sub(r'\s+', ' ', html).strip()


def _part_text(part):
    try:
        payload = part.get_payload(decode=True)
        if payload is None:
            return ""
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="ignore")
    except Exception:
        return ""


def get_body(msg):
    """Return readable text from an email, preferring text/plain but falling
    back to (de-tagged) text/html — many OTP mails are HTML-only."""
    plain, html = "", ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if part.get_content_disposition() == "attachment":
                continue
            if ctype == "text/plain":
                plain += _part_text(part)
            elif ctype == "text/html":
                html += _part_text(part)
    else:
        text = _part_text(msg)
        if msg.get_content_type() == "text/html":
            html = text
        else:
            plain = text

    plain = plain.strip()
    if plain:
        return plain
    return _html_to_text(html)


def find_candidates(text):
    """All plausible OTP codes in `text`, best guesses first.

    Codes sitting next to an OTP keyword rank above loose numbers, and
    obvious non-codes (years) are dropped."""
    low = text.lower()
    keyworded, loose = [], []

    def add(code, start):
        if _looks_like_year(code):
            return
        # Is an OTP keyword within ~40 chars before this number?
        window = low[max(0, start - 40):start]
        (keyworded if any(k in window for k in OTP_KEYWORDS) else loose).append(code)

    for m in CODE_RE.finditer(text):
        add(m.group(1), m.start())
    # Digit-box style: "3 9 1 4 0 2" → "391402"
    for m in SPACED_CODE_RE.finditer(text):
        add(re.sub(r'\D', '', m.group(1)), m.start())
    # Prefer keyword-adjacent, then 6-digit codes (the common OTP length).
    loose.sort(key=lambda c: (len(c) != 6, len(c)))
    # De-dupe, keep order.
    seen, ordered = set(), []
    for c in keyworded + loose:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def extract_otp(text):
    """Best single OTP guess, or None."""
    cands = find_candidates(text)
    return cands[0] if cands else None


def print_otp_alert(sender, subject, otp, candidates, body_snippet):
    print("\n" + "═" * 55)
    print("  🔔  NEW OTP DETECTED")
    print("═" * 55)
    print(f"  From    : {sender}")
    print(f"  Subject : {subject}")
    print(f"  🔑 OTP  : {otp}")
    if len(candidates) > 1:
        print(f"  Others  : {', '.join(candidates[1:])}  (if the top guess is wrong)")
    print(f"  Time    : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if body_snippet:
        print(f"  Snippet : {body_snippet[:160].strip()}")
    print("═" * 55)


# ─────────────────────────────────────────
#  MAIN MONITOR LOOP
# ─────────────────────────────────────────
def get_baseline_uid(mail):
    """Highest UID currently in the inbox — anything <= this is 'the past'."""
    mail.select("INBOX")
    _, data = mail.uid("search", None, "ALL")
    uids = data[0].split() if data[0] else []
    return int(uids[-1]) if uids else 0


def monitor(email_addr, password, host, port, interval):
    print(f"[*] Connecting to {host} as {email_addr}...")

    mail = connect(host, port, email_addr, password)
    last_uid = get_baseline_uid(mail)
    print(f"[*] Listening for NEW OTPs from now on (baseline UID = {last_uid}).")
    print(f"[*] Past emails are ignored. Checking every {interval}s. Ctrl+C to stop.\n")

    while True:
        try:
            # Re-select keeps the view fresh so newly-arrived mail is visible.
            mail.select("INBOX")

            # Only messages strictly newer than the last one we've handled.
            _, data = mail.uid("search", None, f"UID {last_uid + 1}:*")
            uids = data[0].split() if data[0] else []

            for raw_uid in uids:
                uid = int(raw_uid)
                # 'UID n:*' always returns the highest existing UID even if it's
                # not actually new, so guard against re-processing it.
                if uid <= last_uid:
                    continue

                _, raw = mail.uid("fetch", raw_uid, "(RFC822)")
                if not raw or raw[0] is None:
                    last_uid = uid
                    continue

                msg = email.message_from_bytes(raw[0][1])

                subject = decode_str(msg.get("Subject", ""))
                sender  = msg.get("From", "")
                body    = get_body(msg)

                # Search subject + body together; subject text first so a code
                # in the subject line ("Your OTP is 123456") ranks highest.
                candidates = find_candidates(subject + "\n" + body)

                if candidates:
                    print_otp_alert(sender, subject, candidates[0], candidates, body)
                else:
                    ts = datetime.now().strftime("%H:%M:%S")
                    print(f"[{ts}] Email from {sender[:40]} — no OTP found.")

                last_uid = uid

        except (imaplib.IMAP4.error, OSError) as e:
            print(f"[!] Connection error: {e} — reconnecting in {interval}s")
            try:
                mail.logout()
            except Exception:
                pass
            time.sleep(interval)
            try:
                mail = connect(host, port, email_addr, password)
                mail.select("INBOX")
            except Exception as e2:
                print(f"[!] Reconnect failed: {e2}")
            continue
        except Exception as e:
            print(f"[!] Unexpected error: {e} — retrying in {interval}s")

        time.sleep(interval)


# ─────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────
if __name__ == "__main__":
    try:
        monitor(EMAIL_ADDRESS, EMAIL_PASSWORD, IMAP_HOST, IMAP_PORT, CHECK_INTERVAL)
    except KeyboardInterrupt:
        print("\n[*] Stopped.")