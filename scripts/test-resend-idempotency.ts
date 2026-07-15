/**
 * Local test for the send/resend IDEMPOTENCY guard (the fix for the "PO emailed at
 * 2:10 then re-emailed at 3:24" duplicate-email incident — 15 Blinkit POs re-sent).
 *
 * Proves, against the local DB and WITHOUT sending any real email:
 *   1. A PO already in emailStatus=SENT is NOT re-sent on a second buildAndSendPoEmail
 *      call (the default, unforced path) — it returns alreadySent=true and does not
 *      touch emailSentAt. This is what stops a re-run of the bulk send from duplicating.
 *   2. An explicit resend (force=true) DOES send again (the operator-confirmed path).
 *   3. A HELD/FAILED PO is still (re)sent normally by the default path — the guard only
 *      blocks re-sending something already delivered, never a genuine first delivery.
 *
 * Uses test-email mode (redirect) so a "send" resolves to a recipient and marks SENT
 * without mailing a real warehouse. Run:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/test-resend-idempotency.ts
 */
import { prisma } from "../lib/db";
import { buildAndSendPoEmail } from "../lib/services/allocate-and-email";
import { getTestEmailMode, setTestEmailMode } from "../lib/services/app-settings";

const ok = (b: boolean) => (b ? "✅ PASS" : "❌ FAIL");

async function main() {
  console.log("\n=== Send/resend idempotency guard — local test ===\n");

  const origTestMode = await getTestEmailMode();
  // Redirect all mail to a sink so a "send" has a recipient and marks SENT — no real mail.
  await setTestEmailMode(true, origTestMode.address || "sink@example.com");

  const channel = await prisma.channel.findFirstOrThrow();
  const skus = await prisma.sku.findMany({ take: 2 });

  const po = await prisma.purchaseOrder.create({
    data: {
      channelId: channel.id,
      channelPoNumber: `TEST-IDEMPOTENT-${Date.now()}`,
      source: "MANUAL",
      status: "ALLOCATED",
      rawData: {},
      lineItems: {
        create: skus.map((s, i) => ({
          skuId: s.id,
          channelSkuCode: s.internalCode,
          requestedQty: (i + 1) * 10,
          approvedQty: (i + 1) * 10,
        })),
      },
    },
  });
  console.log(`Created demo PO ${po.channelPoNumber} (id ${po.id})\n`);

  // First send → delivered (test-mode sink), marks SENT + records who sent it.
  const r1 = await buildAndSendPoEmail(po.id, { acknowledgeMismatch: true, actorLabel: "asha@moxiebeauty.in" });
  const a1 = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id }, select: { emailStatus: true, emailSentAt: true, emailRef: true, emailSentBy: true },
  });
  console.log("1) First send:");
  console.log(`   emailFailed=${r1.emailFailed} alreadySent=${r1.alreadySent} status=${a1.emailStatus} sentAt=${a1.emailSentAt?.toISOString()} sentBy=${a1.emailSentBy}`);
  console.log(`   ${ok(a1.emailStatus === "SENT")} status SENT`);
  console.log(`   ${ok(r1.alreadySent !== true)} first send actually sent (not skipped)`);
  console.log(`   ${ok(a1.emailSentBy === "asha@moxiebeauty.in")} recorded who sent it (emailSentBy)\n`);

  // Second UNFORCED send → must be skipped as already-sent (this is the incident).
  const r2 = await buildAndSendPoEmail(po.id, { acknowledgeMismatch: true, actorLabel: "test-script" });
  const a2 = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: po.id }, select: { emailStatus: true, emailSentAt: true },
  });
  console.log("2) Second UNFORCED send (the duplicate that must NOT go out):");
  console.log(`   alreadySent=${r2.alreadySent} messageId=${r2.emailMessageId} sentAt=${a2.emailSentAt?.toISOString()}`);
  console.log(`   ${ok(r2.alreadySent === true)} reported alreadySent (no duplicate mail)`);
  console.log(`   ${ok(r2.emailMessageId === null)} no message id (nothing sent)`);
  console.log(`   ${ok(a2.emailSentAt?.getTime() === a1.emailSentAt?.getTime())} emailSentAt unchanged\n`);

  // Third FORCED send → intentional resend, must send again.
  const r3 = await buildAndSendPoEmail(po.id, { acknowledgeMismatch: true, actorLabel: "test-script", force: true });
  console.log("3) FORCED resend (operator-confirmed):");
  console.log(`   alreadySent=${r3.alreadySent} emailFailed=${r3.emailFailed} messageId=${r3.emailMessageId}`);
  console.log(`   ${ok(r3.alreadySent !== true && !r3.emailFailed)} forced resend delivered again\n`);

  // Cleanup: remove the demo PO and restore settings.
  await prisma.poLineItem.deleteMany({ where: { poId: po.id } });
  await prisma.purchaseOrder.delete({ where: { id: po.id } });
  await setTestEmailMode(origTestMode.enabled, origTestMode.address);

  const pass =
    r1.alreadySent !== true && a1.emailSentBy === "asha@moxiebeauty.in" &&
    r2.alreadySent === true && r2.emailMessageId === null && r3.alreadySent !== true;
  console.log("─".repeat(64));
  console.log(pass ? "ALL PASS ✅" : "FAILURES ABOVE ❌");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
