import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { sendTestPoEmail } from "@/lib/integrations/po-test-email";

export const dynamic = "force-dynamic";

/** Send a fixed sample PO-preparation email via Gmail SMTP (amritya→abhisekh). */
export async function POST() {
  return handler("POST /api/blinkit/test-email", async () => {
    await currentActor();
    const result = await sendTestPoEmail();
    return ok(result);
  });
}
