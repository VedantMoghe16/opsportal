import "server-only";
import PDFDocument from "pdfkit";
import { env } from "@/lib/env";
import { amountInWords, formatDate } from "@/lib/utils";

const INK = "#1a1a1a";
const MUTED = "#6b6b60";
const LIME = "#bfe045";

function docToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function moneyStr(n: number): string {
  return "INR " + new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2 }).format(n);
}

export interface InvoiceLine {
  internalCode: string;
  name: string;
  hsnCode: string;
  qty: number;
  rate: number;
  gstRate: number;
}

export async function generateInvoicePdf(input: {
  invoiceNumber: string;
  invoiceDate: Date;
  channelPoNumber: string;
  channelGrnNumber: string;
  channel: { name: string; gstin: string; address: string };
  lines: InvoiceLine[];
}): Promise<{ buffer: Buffer; totalAmount: number; gstAmount: number }> {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const bufferPromise = docToBuffer(doc);

  // Header band
  doc.rect(0, 0, doc.page.width, 90).fill(INK);
  doc.fillColor(LIME).fontSize(22).font("Helvetica-Bold").text("MOXIE", 48, 30, { characterSpacing: 4 });
  doc.fillColor("#ffffff").fontSize(10).font("Helvetica").text("TAX INVOICE", 48, 58);
  doc.fillColor("#ffffff").fontSize(9).text(env.COMPANY_NAME, 320, 32, { width: 230, align: "right" });
  doc.fillColor("#cfcabc").fontSize(8).text(`GSTIN: ${env.COMPANY_GSTIN}`, 320, 48, { width: 230, align: "right" });
  doc.text(env.COMPANY_ADDRESS, 320, 60, { width: 230, align: "right" });

  doc.fillColor(INK);
  let y = 110;
  doc.fontSize(9).font("Helvetica");
  doc.fillColor(MUTED).text("Invoice No", 48, y);
  doc.fillColor(INK).font("Helvetica-Bold").text(input.invoiceNumber, 48, y + 12);
  doc.font("Helvetica").fillColor(MUTED).text("Invoice Date", 200, y);
  doc.fillColor(INK).font("Helvetica-Bold").text(formatDate(input.invoiceDate), 200, y + 12);
  doc.font("Helvetica").fillColor(MUTED).text("PO / GRN", 360, y);
  doc.fillColor(INK).font("Helvetica-Bold").text(`${input.channelPoNumber} / ${input.channelGrnNumber}`, 360, y + 12, { width: 190 });

  y += 44;
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("Bill To", 48, y);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(input.channel.name, 48, y + 12);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
    .text(`GSTIN: ${input.channel.gstin}`, 48, y + 28)
    .text(input.channel.address, 48, y + 40, { width: 300 });

  // Table
  y += 72;
  const cols = [48, 90, 240, 300, 335, 390, 450, 510];
  doc.rect(48, y, doc.page.width - 96, 20).fill("#f1ecdd");
  doc.fillColor(INK).fontSize(8).font("Helvetica-Bold");
  doc.text("Code", cols[0]! + 4, y + 6);
  doc.text("Description", cols[1]!, y + 6);
  doc.text("HSN", cols[2]!, y + 6);
  doc.text("Qty", cols[3]!, y + 6);
  doc.text("Rate", cols[4]!, y + 6);
  doc.text("Taxable", cols[5]!, y + 6);
  doc.text("GST", cols[6]!, y + 6);
  doc.text("Total", cols[7]!, y + 6);
  y += 24;

  let subtotal = 0;
  let gstTotal = 0;
  doc.font("Helvetica").fontSize(8);
  for (const l of input.lines) {
    const taxable = l.qty * l.rate;
    const gst = (taxable * l.gstRate) / 100;
    subtotal += taxable;
    gstTotal += gst;
    doc.fillColor(INK);
    doc.text(l.internalCode, cols[0]! + 4, y, { width: 42 });
    doc.text(l.name, cols[1]!, y, { width: 145 });
    doc.text(l.hsnCode, cols[2]!, y, { width: 56 });
    doc.text(String(l.qty), cols[3]!, y, { width: 30 });
    doc.text(l.rate.toFixed(0), cols[4]!, y, { width: 50 });
    doc.text(taxable.toFixed(0), cols[5]!, y, { width: 56 });
    doc.text(gst.toFixed(0), cols[6]!, y, { width: 56 });
    doc.text((taxable + gst).toFixed(0), cols[7]!, y, { width: 40 });
    y += 18;
    doc.moveTo(48, y - 4).lineTo(doc.page.width - 48, y - 4).strokeColor("#eee").stroke();
  }

  const total = subtotal + gstTotal;
  y += 10;
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text("Subtotal", 380, y).fillColor(INK).text(moneyStr(subtotal), 460, y, { width: 90, align: "right" });
  y += 16;
  doc.fillColor(MUTED).text("Total GST", 380, y).fillColor(INK).text(moneyStr(gstTotal), 460, y, { width: 90, align: "right" });
  y += 20;
  doc.rect(370, y - 4, 180, 22).fill(LIME);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("TOTAL PAYABLE", 380, y + 2);
  doc.text(moneyStr(total), 460, y + 2, { width: 84, align: "right" });

  y += 36;
  doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED)
    .text(`Amount in words: ${amountInWords(total)}`, 48, y, { width: 500 });

  y += 28;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Bank Details", 48, y);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(`Account Name: ${env.COMPANY_BANK_ACCOUNT_NAME}`, 48, y + 14)
    .text(`Account No: ${env.COMPANY_BANK_ACCOUNT_NO}`, 48, y + 26)
    .text(`IFSC: ${env.COMPANY_BANK_IFSC}   Bank: ${env.COMPANY_BANK_NAME}`, 48, y + 38);

  doc.fontSize(8).fillColor(MUTED).text("This is a computer-generated invoice.", 48, doc.page.height - 60);

  const buffer = await bufferPromise;
  return { buffer, totalAmount: total, gstAmount: gstTotal };
}

export interface DebitNoteLine {
  internalCode: string;
  name: string;
  dispatchedQty: number;
  receivedQty: number;
  rate: number;
}

export async function generateDebitNotePdf(input: {
  debitNoteNumber: string;
  date: Date;
  channelPoNumber: string;
  channel: { name: string; gstin: string; address: string };
  lines: DebitNoteLine[];
}): Promise<{ buffer: Buffer; totalShortage: number }> {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const bufferPromise = docToBuffer(doc);

  doc.rect(0, 0, doc.page.width, 90).fill(INK);
  doc.fillColor(LIME).fontSize(22).font("Helvetica-Bold").text("MOXIE", 48, 30, { characterSpacing: 4 });
  doc.fillColor("#ffffff").fontSize(10).font("Helvetica").text("DEBIT NOTE", 48, 58);
  doc.fillColor("#ffffff").fontSize(9).text(env.COMPANY_NAME, 320, 36, { width: 230, align: "right" });
  doc.fillColor("#cfcabc").fontSize(8).text(`GSTIN: ${env.COMPANY_GSTIN}`, 320, 52, { width: 230, align: "right" });

  doc.fillColor(INK);
  let y = 110;
  doc.fontSize(9).fillColor(MUTED).font("Helvetica").text("Debit Note No", 48, y);
  doc.fillColor(INK).font("Helvetica-Bold").text(input.debitNoteNumber, 48, y + 12);
  doc.font("Helvetica").fillColor(MUTED).text("Date", 220, y);
  doc.fillColor(INK).font("Helvetica-Bold").text(formatDate(input.date), 220, y + 12);
  doc.font("Helvetica").fillColor(MUTED).text("Against PO", 360, y);
  doc.fillColor(INK).font("Helvetica-Bold").text(input.channelPoNumber, 360, y + 12);

  y += 44;
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("To", 48, y);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(input.channel.name, 48, y + 12);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
    .text(`GSTIN: ${input.channel.gstin}`, 48, y + 28)
    .text(input.channel.address, 48, y + 40, { width: 320 });

  y += 72;
  const cols = [48, 90, 250, 320, 390, 470];
  doc.rect(48, y, doc.page.width - 96, 20).fill("#f1ecdd");
  doc.fillColor(INK).fontSize(8).font("Helvetica-Bold");
  doc.text("Code", cols[0]! + 4, y + 6);
  doc.text("Product", cols[1]!, y + 6);
  doc.text("Dispatched", cols[2]!, y + 6);
  doc.text("Received", cols[3]!, y + 6);
  doc.text("Shortage", cols[4]!, y + 6);
  doc.text("Amount", cols[5]!, y + 6);
  y += 24;

  let total = 0;
  doc.font("Helvetica").fontSize(8);
  for (const l of input.lines) {
    const shortage = l.dispatchedQty - l.receivedQty;
    const amt = shortage * l.rate;
    total += amt;
    doc.fillColor(INK);
    doc.text(l.internalCode, cols[0]! + 4, y, { width: 42 });
    doc.text(l.name, cols[1]!, y, { width: 155 });
    doc.text(String(l.dispatchedQty), cols[2]!, y, { width: 60 });
    doc.text(String(l.receivedQty), cols[3]!, y, { width: 60 });
    doc.text(String(shortage), cols[4]!, y, { width: 60 });
    doc.text(moneyStr(amt), cols[5]!, y, { width: 80 });
    y += 18;
    doc.moveTo(48, y - 4).lineTo(doc.page.width - 48, y - 4).strokeColor("#eee").stroke();
  }

  y += 12;
  doc.rect(330, y - 4, 220, 22).fill(LIME);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("Total Shortage Amount", 340, y + 2);
  doc.text(moneyStr(total), 470, y + 2, { width: 72, align: "right" });

  y += 36;
  doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED)
    .text(`Amount in words: ${amountInWords(total)}`, 48, y, { width: 500 });

  const buffer = await bufferPromise;
  return { buffer, totalShortage: total };
}
