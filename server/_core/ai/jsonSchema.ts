/**
 * zod → JSON Schema no subconjunto aceite pelo `responseJsonSchema` do Gemini
 * (type, properties, required, items, enum, description, anyOf, nullable via
 * `type: [..., "null"]`, min/max de números e arrays). O resto (minLength,
 * pattern, $schema…) é retirado: a validação a sério é SEMPRE o zod, depois
 * de a resposta chegar.
 */
import { z } from "zod";

const KEEP = new Set([
  "type", "properties", "required", "items", "prefixItems", "enum", "description", "title", "format",
  "anyOf", "additionalProperties", "minItems", "maxItems", "minimum", "maximum", "propertyOrdering",
]);
const FORMATS = new Set(["date-time", "date", "time"]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;

  // anyOf [X, {type:null}] → X com type [X.type, "null"] (forma que o Gemini documenta).
  if (Array.isArray(src.anyOf)) {
    const nonNull = src.anyOf.filter((s: any) => !(s && s.type === "null"));
    const hasNull = nonNull.length !== src.anyOf.length;
    if (hasNull && nonNull.length === 1 && typeof (nonNull[0] as any)?.type === "string") {
      const inner = clean(nonNull[0]) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...inner, type: [inner.type, "null"] };
      if (typeof src.description === "string" && !merged.description) merged.description = src.description;
      if (Array.isArray(merged.enum)) merged.enum = [...(merged.enum as unknown[])];
      return merged;
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!KEEP.has(k)) continue;
    if (k === "format" && !(typeof v === "string" && FORMATS.has(v))) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, clean(pv)]));
      continue;
    }
    if (k === "additionalProperties" && typeof v === "object") continue;
    out[k] = clean(v);
  }
  return out;
}

/** JSON Schema pronto para o Gemini (e para o json_schema do caminho antigo). */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  return clean(raw) as Record<string, unknown>;
}
