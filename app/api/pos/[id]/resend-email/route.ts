import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { buildAndSendPoEmail } from "@/lib/services/allocate-and-email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const schema = z.object({
  // Operator-edited body / subject (optional — falls back to template + stored values).
  bodyHtml: z.string().optional(),
  subject: z.string().optional(),
  // Operator-edited recipients from the resend preview (plain emails). When `to` is
  // provided it OVERRIDES location/global resolution — this is how an operator fixes
  // an undelivered (HELD) PO's recipients before resending.
  to: z.array(z.string().regex(EMAIL_RE, "invalid email")).optional(),
  cc: z.array(z.string().regex(EMAIL_RE, "invalid email")).optional(),
  // Confirm re-sending a PO whose email already went out. Without it, an already-SENT
  // PO is NOT re-mailed (409) — this is the guard against duplicate sends. The UI sets
  // it true only after the operator confirms "this was already emailed, send again".
  force: z.boolean().optional(),
});

/**
 * POST /api/pos/[id]/resend-email
 * Re-send the PO-preparation email for an already-allocated PO WITHOUT re-allocating
 * or re-pushing to the WMS. Reuses the PO's existing reference number. Used to recover
 * sends that failed during a bulk run ("17 sent, 15 received") and to resend POs that
 * were HELD because they resolved to no recipients (operator supplies `to`/`cc`).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/resend-email", async () => {
    const actor = await currentActor();
    const { bodyHtml, subject, to, cc, force } = schema.parse(await req.json().catch(() => ({})));

    const res = await buildAndSendPoEmail(params.id, {
      // The price mismatch was already reviewed at allocation time — don't re-gate.
      acknowledgeMismatch: true,
      emailOverrides: { bodyHtml, subject, to, cc },
      actorLabel: actor.label,
      force,
    });

    // Already delivered and not force-confirmed → block the duplicate and tell the UI
    // when it was originally sent, so it can ask the operator to confirm a real resend.
    if (res.alreadySent) {
      return fail(
        new Error(
          `This PO's email was already sent${res.emailSentAt ? ` at ${new Date(res.emailSentAt).toLocaleString()}` : ""}. Confirm to send it again.`,
        ),
        409,
      );
    }
    // Still no recipients → report the hold so the UI keeps the resend preview open.
    if (res.heldNoRecipients) {
      return fail(new Error(res.emailHoldReason ?? "This email would reach no one — add recipients and resend"), 422);
    }
    if (res.emailFailed) return fail(new Error(res.emailError ?? "Resend failed"), 502);
    return ok({ poId: params.id, emailMessageId: res.emailMessageId, emailRef: res.emailRef });
  });
}
