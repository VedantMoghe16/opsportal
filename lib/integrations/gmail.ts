import "server-only";
import { google, type gmail_v1 } from "googleapis";
import { env, requireEnv } from "@/lib/env";

let gmailClient: gmail_v1.Gmail | null = null;

function getGmail(): gmail_v1.Gmail {
  requireEnv("gmail", [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "GMAIL_USER_EMAIL",
  ]);
  if (gmailClient) return gmailClient;
  const oauth2 = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
  );
  oauth2.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  gmailClient = google.gmail({ version: "v1", auth: oauth2 });
  return gmailClient;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  fromDomain: string;
  subject: string;
  body: string;
  date: Date;
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }
  if (part.parts) {
    // Prefer text/plain, fall back to text/html
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain) return decodeBody(plain);
    const html = part.parts.find((p) => p.mimeType === "text/html");
    if (html) return decodeBody(html).replace(/<[^>]+>/g, " ");
    return part.parts.map(decodeBody).join("\n");
  }
  return "";
}

function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}

/** Fetch all unread emails from the ops inbox. */
export async function fetchUnreadEmails(maxResults = 50): Promise<ParsedEmail[]> {
  const gmail = getGmail();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults,
  });
  const messages = list.data.messages ?? [];
  const results: ParsedEmail[] = [];

  for (const m of messages) {
    if (!m.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: m.id,
      format: "full",
    });
    const payload = full.data.payload;
    const headers = payload?.headers;
    const from = header(headers, "From");
    const address = extractEmailAddress(from);
    results.push({
      id: m.id,
      threadId: full.data.threadId ?? "",
      from: address,
      fromDomain: address.split("@")[1] ?? "",
      subject: header(headers, "Subject"),
      body: decodeBody(payload),
      date: new Date(Number(full.data.internalDate ?? Date.now())),
    });
  }
  return results;
}

/** Mark an email as read (remove UNREAD label) so it isn't reprocessed. */
export async function markAsRead(messageId: string): Promise<void> {
  await getGmail().users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
}

export class OtpNotFoundError extends Error {}

/**
 * Poll the ops inbox for a one-time-passcode email and extract the code.
 * Used by the Blinkit/partnersbiz login flow.
 */
export async function waitForOtp(opts: {
  query: string; // Gmail search, e.g. 'from:partnersbiz.com newer_than:1h'
  sentAfter: Date; // ignore emails older than this
  regex?: RegExp; // capture group 1 = the code; default 4–8 digit run
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string> {
  const gmail = getGmail();
  const regex = opts.regex ?? /\b(\d{4,8})\b/;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const pollMs = opts.pollMs ?? 4_000;
  const afterMs = opts.sentAfter.getTime() - 30_000; // small clock skew

  while (Date.now() < deadline) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: opts.query,
      maxResults: 5,
    });
    for (const m of list.data.messages ?? []) {
      if (!m.id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
      if (Number(full.data.internalDate ?? 0) < afterMs) continue;
      const subject = header(full.data.payload?.headers, "Subject");
      const body = decodeBody(full.data.payload);
      // Prefer a code adjacent to "OTP"/"code", else first numeric run.
      const near = (subject + "\n" + body).match(
        /(?:otp|code|passcode|verification)[^\d]{0,20}(\d{4,8})/i,
      );
      const m2 = near ?? (subject + "\n" + body).match(regex);
      if (m2?.[1]) return m2[1];
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new OtpNotFoundError(`No OTP email matched "${opts.query}" within the wait window`);
}
