import "server-only";
import nodemailer from "nodemailer";
import { env, requireEnv } from "@/lib/env.js";

export interface PoTestEmailResult {
  messageId: string;
  to: string;
}

interface PoTestEmailData {
  poNumber: string;
  sku: string;
  qty: number;
  location: string;
  channel: string;
  dispatchFrom: string;
  senderName: string;
}

const SAMPLE: PoTestEmailData = {
  poNumber: "P4466354",
  sku: "CVSD10",
  qty: 192,
  location: "LKO-DRY-MH-SOHRAMAU",
  channel: "Zepto",
  dispatchFrom: "RGL NCR",
  senderName: "Rishabh Kumar",
};

function buildHtml(d: PoTestEmailData): string {
  const thBase = "padding:6px 10px;border:1px solid #ccc;";
  const skuTh = `${thBase}background:#F6E199;`;
  const qtyTh = `${thBase}background:#C6E0B4;`;
  const td = "padding:6px 10px;border:1px solid #ccc;";
  return `
<p>Hi Team,</p>
<p>Please prepare the mention PO:-</p>
<table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
  <thead>
    <tr>
      <th style="${skuTh}">SKU</th>
      <th style="${qtyTh}">Qty</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="${td}">${d.sku}</td>
      <td style="${td}">${d.qty}</td>
    </tr>
  </tbody>
</table>
<ul>
  <li>PO No. - ${d.poNumber}</li>
  <li>Location/WH: - ${d.location}</li>
  <li>Channel: ${d.channel}</li>
  <li>Dispatch From: ${d.dispatchFrom}</li>
</ul>
<p>--<br>Regards,<br>${d.senderName}.</p>
`.trim();
}

function buildText(d: PoTestEmailData): string {
  return `Hi Team,

Please prepare the mention PO:-

SKU    | Qty
${d.sku} | ${d.qty}

- PO No. - ${d.poNumber}
- Location/WH: - ${d.location}
- Channel: ${d.channel}
- Dispatch From: ${d.dispatchFrom}

--
Regards,
${d.senderName}.`;
}

export async function sendTestPoEmail(): Promise<PoTestEmailResult> {
  requireEnv("po-test-email", ["PO_TEST_EMAIL_SMTP_PASS"]);

  const user = env.PO_TEST_EMAIL_SMTP_USER;
  const pass = env.PO_TEST_EMAIL_SMTP_PASS!.replace(/\s+/g, "");
  const to = env.PO_TEST_EMAIL_TO;

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const d = SAMPLE;
  const info = await transport.sendMail({
    from: `"Moxie Ops" <${user}>`,
    to,
    subject: `Please prepare the mentioned PO - ${d.poNumber}`,
    html: buildHtml(d),
    text: buildText(d),
  });

  return { messageId: info.messageId as string, to };
}
