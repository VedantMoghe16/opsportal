import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env, requireEnv } from "@/lib/env";

const MODEL = "claude-opus-4-6";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  requireEnv("claude", ["ANTHROPIC_API_KEY"]);
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/** Strip ```json fences and parse, validating against a Zod schema. */
function parseJson<T>(raw: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const json = JSON.parse(cleaned);
  return schema.parse(json);
}

async function complete(system: string, user: string, maxTokens = 2048): Promise<string> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

// ── Schemas ───────────────────────────────────────────────
export const poParseSchema = z.object({
  channel_po_number: z.string().nullable(),
  po_date: z.string().nullable(),
  requested_delivery_date: z.string().nullable(),
  line_items: z.array(
    z.object({
      channel_sku_code: z.string(),
      requested_qty: z.number().int().nonnegative(),
      unit_price: z.number().nullable(),
    }),
  ),
  special_instructions: z.string().nullable().optional(),
});
export type ParsedPo = z.infer<typeof poParseSchema>;

export const dispatchParseSchema = z.object({
  awb_number: z.string().nullable(),
  carrier_name: z.string().nullable(),
  dispatched_at: z.string().nullable(),
  line_items: z.array(
    z.object({
      channel_sku_code: z.string().nullable(),
      internal_code: z.string().nullable().optional(),
      dispatched_qty: z.number().int().nonnegative(),
    }),
  ),
});
export type ParsedDispatch = z.infer<typeof dispatchParseSchema>;

export const grnParseSchema = z.object({
  channel_grn_number: z.string().nullable(),
  line_items: z.array(
    z.object({
      channel_sku_code: z.string().nullable(),
      internal_code: z.string().nullable().optional(),
      received_qty: z.number().int().nonnegative(),
      rejected_qty: z.number().int().nonnegative().default(0),
      rejection_reason: z.string().nullable().optional(),
    }),
  ),
});
export type ParsedGrn = z.infer<typeof grnParseSchema>;

export const deliveryParseSchema = z.object({
  awb_number: z.string().nullable(),
  delivered_at: z.string().nullable(),
  delivery_status: z.string().nullable(),
});
export type ParsedDelivery = z.infer<typeof deliveryParseSchema>;

// ── Parsers ───────────────────────────────────────────────
export async function parsePurchaseOrderEmail(emailBody: string): Promise<ParsedPo> {
  const system = `You are parsing a purchase order email from a channel partner into structured JSON.
Extract: channel_po_number, po_date (ISO), requested_delivery_date (ISO),
line_items (array of { channel_sku_code, requested_qty, unit_price }),
and any special instructions.
Respond ONLY with valid JSON matching this schema. No explanation, no markdown.
If a field is not found, use null.`;
  return parseJson(await complete(system, emailBody), poParseSchema);
}

export async function parseDispatchEmail(emailBody: string): Promise<ParsedDispatch> {
  const system = `You are parsing a warehouse dispatch confirmation email into structured JSON.
Extract: awb_number, carrier_name, dispatched_at (ISO),
line_items (array of { channel_sku_code, internal_code, dispatched_qty }).
Respond ONLY with valid JSON. No markdown. Use null for missing fields.`;
  return parseJson(await complete(system, emailBody), dispatchParseSchema);
}

export async function parseGrnEmail(emailBody: string): Promise<ParsedGrn> {
  const system = `You are parsing a Goods Received Note (GRN) email into structured JSON.
Extract: channel_grn_number,
line_items (array of { channel_sku_code, internal_code, received_qty, rejected_qty, rejection_reason }).
Respond ONLY with valid JSON. No markdown. Use null for missing fields, 0 for missing quantities.`;
  return parseJson(await complete(system, emailBody), grnParseSchema);
}

export async function parseDeliveryEmail(emailBody: string): Promise<ParsedDelivery> {
  const system = `You are parsing a logistics delivery confirmation email into structured JSON.
Extract: awb_number, delivered_at (ISO), delivery_status.
Respond ONLY with valid JSON. No markdown. Use null for missing fields.`;
  return parseJson(await complete(system, emailBody), deliveryParseSchema);
}

// ── Priority scoring ──────────────────────────────────────
const priorityScoreSchema = z.object({
  priority_score: z.number().int().min(1).max(100),
  priority: z.enum(["P1", "P2", "P3"]),
  rationale: z.string(),
});
export type PriorityResult = z.infer<typeof priorityScoreSchema>;

export async function scorePriority(input: {
  channelName: string;
  channelTier: string;
  fillRateCommitment: number;
  deliverySlaHours: number;
  totalValue: number;
  requestedDeliveryDate: string | null;
  today: string;
}): Promise<PriorityResult> {
  const system = `You score the urgency of a purchase order from 1 to 100 (100 = most urgent).
Weigh channel tier (A>B>C), order value, and delivery urgency relative to today.
Map the score to a priority bucket: P1 (>=80), P2 (50-79), P3 (<50).
Respond ONLY with JSON: { "priority_score": int, "priority": "P1"|"P2"|"P3", "rationale": string }.`;
  const user = JSON.stringify(input);
  return parseJson(await complete(system, user, 512), priorityScoreSchema);
}

// ── Allocation suggestion ─────────────────────────────────
const allocationSuggestionSchema = z.object({
  allocations: z.array(
    z.object({
      po_id: z.string(),
      sku_id: z.string(),
      suggested_qty: z.number().int().nonnegative(),
    }),
  ),
});
export type AllocationSuggestion = z.infer<typeof allocationSuggestionSchema>;

export async function suggestAllocations(input: {
  atp: { sku_id: string; internal_code: string; atp_qty: number; case_pack_size: number }[];
  pos: {
    po_id: string;
    channel: string;
    priority: string | null;
    lines: { sku_id: string; requested_qty: number }[];
  }[];
}): Promise<AllocationSuggestion> {
  const system = `You allocate available-to-promise (ATP) inventory across purchase orders.
Rules:
- Honour priority order: fill all P1 demand first, then P2, then P3.
- Never allocate more than the ATP for a SKU across all POs combined.
- Round each allocation UP to the SKU's case_pack_size, but never exceed requested_qty or remaining ATP.
- Prefer full fills for higher-priority POs; partially fill lower-priority POs when ATP runs short.
Respond ONLY with JSON: { "allocations": [ { "po_id", "sku_id", "suggested_qty" } ] }.`;
  const user = JSON.stringify(input);
  return parseJson(await complete(system, user, 4096), allocationSuggestionSchema);
}
