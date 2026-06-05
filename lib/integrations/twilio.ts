import "server-only";
import twilio from "twilio";
import { env } from "@/lib/env";

let client: ReturnType<typeof twilio> | null = null;

function getClient() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  if (!client) {
    client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

/**
 * Send a WhatsApp alert to the ops group. No-ops (logs) when Twilio isn't
 * configured so callers never crash a cron job over a missing credential.
 */
export async function sendWhatsAppAlert(message: string): Promise<void> {
  const c = getClient();
  if (!c || !env.TWILIO_WHATSAPP_FROM || !env.OPS_WHATSAPP_GROUP) {
    console.log("[twilio] (skipped, not configured) →", message);
    return;
  }
  try {
    await c.messages.create({
      from: env.TWILIO_WHATSAPP_FROM,
      to: env.OPS_WHATSAPP_GROUP,
      body: message,
    });
    console.log("[twilio] sent WhatsApp alert");
  } catch (err) {
    console.error("[twilio] failed to send alert", err);
  }
}
