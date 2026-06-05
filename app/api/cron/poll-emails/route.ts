import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { fetchUnreadEmails, markAsRead } from "@/lib/integrations/gmail";
import { processEmails } from "@/lib/services/email-processor";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  console.log("[cron:poll-emails] starting");
  try {
    const emails = await fetchUnreadEmails();
    console.log(`[cron:poll-emails] fetched ${emails.length} unread emails`);

    const result = await processEmails(emails);

    // Mark processed messages as read so they aren't refetched.
    for (const e of emails) {
      try {
        await markAsRead(e.id);
      } catch (err) {
        console.error(`[cron:poll-emails] failed to mark ${e.id} read`, err);
      }
    }

    console.log("[cron:poll-emails] done", result);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[cron:poll-emails]", error);
    await sendWhatsAppAlert(
      `🚨 Cron failure: poll-emails — ${error instanceof Error ? error.message : "unknown"}`,
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
