import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { buildAndSendPoEmail } from "@/lib/services/allocate-and-email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  // Operator-edited body / subject (optional — falls back to template + stored values).
  bodyHtml: z.string().optional(),
  subject: z.string().optional(),
});

/**
 * POST /api/pos/[id]/resend-email
 * Re-send the PO-preparation email for an already-allocated PO WITHOUT re-allocating
 * or re-pushing to the WMS. Reuses the PO's existing reference number. Used to recover
 * sends that failed during a bulk run ("17 sent, 15 received").
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/resend-email", async () => {
    const actor = await currentActor();
    const { bodyHtml, subject } = schema.parse(await req.json().catch(() => ({})));

    const res = await buildAndSendPoEmail(params.id, {
      // The price mismatch was already reviewed at allocation time — don't re-gate.
      acknowledgeMismatch: true,
      emailOverrides: { bodyHtml, subject },
      actorLabel: actor.label,
    });

    if (res.emailFailed) return fail(new Error(res.emailError ?? "Resend failed"), 502);
    return ok({ poId: params.id, emailMessageId: res.emailMessageId, emailRef: res.emailRef });
  });
}
