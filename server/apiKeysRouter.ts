/**
 * tRPC: apiKeys — ecrã "API Keys" (só super admin, módulo api_keys/manage).
 *
 * P3 lote 20a:
 * - cada chave tem CAPACIDADES (shared/apiKeyCapabilities.ts); as antigas
 *   (read/write/admin/device) mantêm o que faziam até alguém as reduzir aqui;
 * - "Eliminar" passa a REVOGAR (nunca DELETE): fica quem, quando e porquê e
 *   a chave nunca mais funciona nem se reativa;
 * - cada mudança fica nos logs com o nome e o prefixo da chave (antes → depois).
 * A chave completa só sai em `create`, uma vez; na BD fica só o hash + prefixo.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import {
  API_KEY_CAPABILITIES, capabilitiesFor, capabilitiesLabel, isLegacyPermissions, normalizeCapabilities,
} from "../shared/apiKeyCapabilities";
import { addDays, lisbonDayOf, lisbonMidnightUtcMs } from "../shared/lisbonDay";

const capsInput = z.array(z.enum(API_KEY_CAPABILITIES)).min(1, "Escolhe pelo menos uma capacidade.").max(API_KEY_CAPABILITIES.length);

/** "YYYY-MM-DD" → último segundo desse dia em Lisboa, em UTC ("YYYY-MM-DD HH:MM:SS"). PURA. */
export function lisbonEndOfDayUtc(day: string): string {
  return new Date(lisbonMidnightUtcMs(addDays(day, 1)) - 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** "#3 «Site» (mp_ab12cd…)" para os logs. PURA. */
export function apiKeyLogName(k: { id: number; name?: string | null; keyPrefix?: string | null }): string {
  return `#${k.id}${k.name ? ` «${k.name}»` : ""}${k.keyPrefix ? ` (${k.keyPrefix}…)` : ""}`;
}

async function log(userId: number, action: string, entityId: number | null, details: string) {
  // Um log que falha não desfaz uma chave já criada/alterada.
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action, entity: "api_key", entityId, details: details.slice(0, 1000) });
  } catch (err) {
    console.warn("[apiKeys] log falhou:", String((err as any)?.message ?? err).slice(0, 160));
  }
}

async function loadKey(id: number) {
  const { getApiKeyById } = await import("./db");
  const k = await getApiKeyById(id);
  if (!k) throw new TRPCError({ code: "NOT_FOUND", message: "API key não encontrada." });
  if (k.revokedAt) throw new TRPCError({ code: "CONFLICT", message: "Esta API key foi revogada — já não se altera nem reativa. Cria uma nova." });
  return k;
}

export const apiKeysRouter = router({
  list: protectedProcedure
    .input(z.object({ includeRevoked: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireAccess(ctx.user, "api_keys", "manage");
      const { getApiKeys } = await import("./db");
      const rows = await getApiKeys({ includeRevoked: input?.includeRevoked === true });
      // D53: a chave de quem ficou inativo não funciona — a lista diz porquê.
      const { creatorStillActive, loadApiKeyCreator } = await import("./apiKeyAuth");
      // Falha a ler a conta = desconhecido (null): a lista mostra-se na mesma.
      const cache = new Map<number, Promise<boolean | null>>();
      const creatorActive = (id: number) => {
        if (!cache.has(id)) cache.set(id, creatorStillActive(id, loadApiKeyCreator).catch(() => null));
        return cache.get(id)!;
      };
      return Promise.all(rows.map(async (k) => ({
        ...k,
        capabilities: API_KEY_CAPABILITIES.filter((c) => capabilitiesFor(k.permissions).has(c)),
        legacy: isLegacyPermissions(k.permissions),
        creatorActive: k.createdById == null ? true : await creatorActive(k.createdById),
      })));
    }),

  create: protectedProcedure.input(z.object({
    name: z.string().trim().min(1).max(100),
    capabilities: capsInput,
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "api_keys", "manage");
    const { generateApiKey, hashApiKey, apiKeyPrefix } = await import("./apiKeyAuth");
    const { createApiKey } = await import("./db");
    const key = generateApiKey();
    const caps = normalizeCapabilities(input.capabilities);
    const expiresAt = input.expiresInDays
      ? lisbonEndOfDayUtc(addDays(lisbonDayOf(Date.now()), input.expiresInDays))
      : null;
    const id = await createApiKey({
      name: input.name,
      apiKey: null,
      keyHash: hashApiKey(key),
      keyPrefix: apiKeyPrefix(key),
      expiresAt,
      permissions: JSON.stringify(caps),
      active: 1,
      createdById: ctx.user.id,
    });
    await log(ctx.user.id, "create", id,
      `API key ${apiKeyLogName({ id, name: input.name, keyPrefix: apiKeyPrefix(key) })} criada — pode: ${capabilitiesLabel(caps)}${expiresAt ? `; válida até ${expiresAt.slice(0, 10)}` : "; sem validade"}`);
    return { id, key, keyPrefix: apiKeyPrefix(key) };
  }),

  /** Mudar o que a chave pode fazer (reduzir uma chave antiga, por exemplo). */
  setCapabilities: protectedProcedure.input(z.object({
    id: z.number().int().positive(),
    capabilities: capsInput,
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "api_keys", "manage");
    const k = await loadKey(input.id);
    const before = capabilitiesFor(k.permissions);
    const wasLegacy = isLegacyPermissions(k.permissions);
    const caps = normalizeCapabilities(input.capabilities);
    const { setApiKeyPermissions } = await import("./db");
    if (!(await setApiKeyPermissions(k.id, JSON.stringify(caps)))) {
      throw new TRPCError({ code: "CONFLICT", message: "A chave mudou entretanto (revogada?). Atualiza a página." });
    }
    await log(ctx.user.id, "update", k.id,
      `API key ${apiKeyLogName(k)}: capacidades ${capabilitiesLabel(before)}${wasLegacy ? " (chave antiga)" : ""} → ${capabilitiesLabel(caps)}`);
    return { success: true, capabilities: caps };
  }),

  toggle: protectedProcedure.input(z.object({
    id: z.number().int().positive(),
    active: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "api_keys", "manage");
    const k = await loadKey(input.id);
    const { toggleApiKey } = await import("./db");
    if (!(await toggleApiKey(k.id, input.active))) {
      throw new TRPCError({ code: "CONFLICT", message: "A chave mudou entretanto (revogada?). Atualiza a página." });
    }
    await log(ctx.user.id, "update", k.id, `API key ${apiKeyLogName(k)}: ${k.active ? "ativa" : "desativada"} → ${input.active ? "ativa" : "desativada"}`);
    return { success: true };
  }),

  /** Revogar em vez de apagar (0405): nunca mais funciona, fica o rasto. */
  revoke: protectedProcedure.input(z.object({
    id: z.number().int().positive(),
    reason: z.string().trim().min(3, "Diz porquê (3 letras no mínimo).").max(255),
  })).mutation(async ({ ctx, input }) => {
    requireAccess(ctx.user, "api_keys", "manage");
    const { getApiKeyById, revokeApiKey } = await import("./db");
    const k = await getApiKeyById(input.id);
    if (!k) throw new TRPCError({ code: "NOT_FOUND", message: "API key não encontrada." });
    if (k.revokedAt) return { success: true, alreadyRevoked: true };
    const done = await revokeApiKey(k.id, ctx.user.id, input.reason);
    if (done) await log(ctx.user.id, "revoke", k.id, `API key ${apiKeyLogName(k)} revogada: ${input.reason}`);
    return { success: true, alreadyRevoked: !done };
  }),
});
