import "server-only";
import { env } from "@/lib/env";
import { listSkuMaster, addChannelCodeToMaster, channelCodeColumn } from "@/lib/services/sku-master";
import { writeAudit } from "@/lib/services/audit";

/** Confidence at/above which a Gemini match is auto-applied to the master. */
const AUTO_APPLY_CONFIDENCE = 0.85;

export interface UnmappedItem {
  source: string; // channel name/source, e.g. "Blinkit"
  channelSkuCode: string;
  name: string;
}

export interface AutoMapResult {
  source: string;
  channelSkuCode: string;
  name: string;
  matchedInternal: string | null;
  confidence: number;
  applied: boolean;
  reasoning?: string;
}

interface GeminiMatch {
  index: number;
  code: string | null;
  confidence: number;
  reasoning?: string;
}

/**
 * Ask Gemini to match each unmapped channel item to ONE internal master SKU by
 * product meaning. Returns matches keyed by input index. Batched into one call.
 */
async function geminiMatch(
  items: UnmappedItem[],
  candidates: { code: string; name: string }[],
): Promise<Map<number, GeminiMatch>> {
  const out = new Map<number, GeminiMatch>();
  if (!env.GEMINI_API_KEY || items.length === 0 || candidates.length === 0) return out;

  const candidateList = candidates.map((c) => `${c.code} | ${c.name}`).join("\n");
  const itemList = items
    .map((it, i) => `${i} | ${it.source} | ${it.channelSkuCode} | ${it.name}`)
    .join("\n");

  const prompt = `You are a SKU-matching assistant for Moxie Beauty, a hair-care brand.
Match each channel purchase-order item to exactly ONE internal SKU code from the
master list below, by product meaning (name + size/pack). Different channels list
the same product under different ids, so rely on the product name, not the id.

Internal SKUs (code | name):
${candidateList}

Items to match (index | channel | channelCode | productName):
${itemList}

Reply ONLY with JSON:
{"matches":[{"index":0,"code":"INTERNAL_CODE","confidence":0.0,"reasoning":"brief"}]}
confidence: 0.9+ = same product AND size, 0.75-0.89 = same product, size ambiguous,
0.5-0.74 = same product family, <0.5 = weak. Use code null when there is no good
match. Include every index exactly once.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.1 },
    }),
  });
  if (!res.ok) {
    console.warn(`[sku-auto-mapper] Gemini ${res.status}: ${await res.text()}`);
    return out;
  }
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return out;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { matches?: GeminiMatch[] };
    for (const m of parsed.matches ?? []) {
      if (typeof m.index === "number") out.set(m.index, m);
    }
  } catch {
    /* malformed — return what we have */
  }
  return out;
}

/**
 * Auto-map unmapped channel SKU codes to existing internal SKUs using Gemini,
 * then PERSIST each high-confidence match into the SKU master (appended to the
 * channel's code column, multi-code). Lower-confidence matches are returned for
 * a human to confirm. De-dupes by source+code. Skips channels with no master
 * code column. Every applied mapping is audited.
 */
export async function autoMapUnmappedChannelSkus(
  items: UnmappedItem[],
  actorLabel: string,
): Promise<{ results: AutoMapResult[]; appliedCount: number }> {
  // De-dupe by source+code; keep the first (longest) name seen.
  const byKey = new Map<string, UnmappedItem>();
  for (const it of items) {
    const code = (it.channelSkuCode ?? "").trim();
    if (!code || !channelCodeColumn(it.source)) continue;
    const key = `${it.source.toLowerCase()}::${code}`;
    const existing = byKey.get(key);
    if (!existing || (it.name?.length ?? 0) > (existing.name?.length ?? 0)) {
      byKey.set(key, { source: it.source, channelSkuCode: code, name: it.name ?? "" });
    }
  }
  const unique = [...byKey.values()];
  if (unique.length === 0) return { results: [], appliedCount: 0 };

  const master = await listSkuMaster();
  const candidates = master.map((m) => ({ code: m.internalCode, name: m.name || m.internalCode }));
  const masterCodes = new Set(candidates.map((c) => c.code));

  const matches = await geminiMatch(unique, candidates);

  const results: AutoMapResult[] = [];
  let appliedCount = 0;
  for (let i = 0; i < unique.length; i++) {
    const it = unique[i]!;
    const m = matches.get(i);
    const code = m?.code && masterCodes.has(m.code) ? m.code : null;
    const confidence = m?.confidence ?? 0;
    let applied = false;
    if (code && confidence >= AUTO_APPLY_CONFIDENCE) {
      applied = await addChannelCodeToMaster(code, it.source, it.channelSkuCode, actorLabel);
      if (applied) {
        appliedCount++;
        await writeAudit({
          entityType: "SkuMaster",
          entityId: code,
          action: "SKU_AUTO_MAPPED",
          performedBy: actorLabel,
          changes: { source: it.source, channelSkuCode: it.channelSkuCode, name: it.name, confidence, via: "gemini" },
        });
      }
    }
    results.push({
      source: it.source,
      channelSkuCode: it.channelSkuCode,
      name: it.name,
      matchedInternal: code,
      confidence,
      applied,
      reasoning: m?.reasoning,
    });
  }
  return { results, appliedCount };
}
