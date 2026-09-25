/**
 * Google Business Profile — gestão (escrita): horário normal e horários
 * especiais (feriados) por perfil ou em vários de uma vez, e publicações
 * ("Novidades", ofertas, eventos) num ou em vários perfis.
 *
 * Quem chama (profileRouter) já confirmou "Marketing → gerir" e o âmbito de
 * cidade; aqui cada alteração é validada antes de sair para a rede e fica no
 * registo de atividade (quem, que perfil, o quê — nunca o token).
 * Sem Perguntas & Respostas: a Google descontinuou a API.
 */
import {
  POST_TOPIC_LABELS, buildHoursPatch, buildLocalPost, mergeSpecialDays, parsePosts, parseRegularHours, parseSpecialHours,
  type DayHours, type PostInput, type SpecialDay,
} from "../../../shared/googleBusinessProfile";
import { GbpApiError } from "./diagnostics";
import { safeError } from "./domain";
import type { BusinessClient } from "./client";
import type { GbpLocationRow } from "./insightsStore";

export interface ManageLocation { id: number; locationName: string; accountName: string; title: string }
type Log = (details: string, entityId: number) => Promise<void>;

export async function clientFor(): Promise<BusinessClient> {
  const { accessToken, connection } = await import("./oauth");
  const { BusinessClient } = await import("./client");
  const { config } = await import("./config");
  const { projectNumberOfClientId } = await import("./diagnostics");
  const conn = await connection();
  return new BusinessClient(await accessToken(), { deadlineAt: Date.now() + 50_000, context: { projectNumber: projectNumberOfClientId(config().clientId), accountEmail: conn?.accountEmail ?? null } });
}

/** Horário atual (lido na hora) de um perfil. */
export async function readHours(client: Pick<BusinessClient, "getHours">, loc: ManageLocation) {
  const r = await client.getHours(loc.locationName);
  return {
    regular: parseRegularHours(r.regularHours),
    special: parseSpecialHours(r.specialHours),
    hasPendingEdits: r.metadata?.hasPendingEdits ?? null,
    hasGoogleUpdated: r.metadata?.hasGoogleUpdated ?? null,
  };
}

export interface ApplyHoursInput {
  regular?: DayHours[] | null;
  /** Datas a definir/substituir (as outras datas de cada perfil ficam). */
  special?: SpecialDay[] | null;
  /** Datas a retirar. */
  removeSpecial?: string[];
  today: string;
}
export interface ApplyResult { locationId: number; title: string; ok: boolean; error: string | null }

/**
 * Aplica horário normal e/ou especiais a vários perfis. Valida TUDO antes de
 * mexer (um erro de formato não deixa metade aplicada); cada perfil é um
 * pedido próprio e o resultado vem por perfil.
 */
export async function applyHours(client: Pick<BusinessClient, "getHours" | "patchLocation">, locs: readonly ManageLocation[], i: ApplyHoursInput, log: Log): Promise<ApplyResult[]> {
  const hasSpecial = !!(i.special?.length || i.removeSpecial?.length);
  // Validação prévia (lança GbpValidationError com a mensagem PT-PT).
  buildHoursPatch({ regular: i.regular ?? null, special: hasSpecial ? (i.special ?? []) : null, today: i.today });
  const out: ApplyResult[] = [];
  for (const loc of locs) {
    try {
      let special: SpecialDay[] | null = null;
      if (hasSpecial) {
        const current = parseSpecialHours((await client.getHours(loc.locationName)).specialHours);
        special = mergeSpecialDays(current, i.special ?? [], i.removeSpecial ?? [], i.today);
      }
      const patch = buildHoursPatch({ regular: i.regular ?? null, special, today: i.today });
      await client.patchLocation(loc.locationName, patch.updateMask, patch.body);
      const what = [i.regular ? "horário normal" : null, hasSpecial ? `horários especiais (${(i.special ?? []).map((d) => d.date).join(", ") || "—"}${i.removeSpecial?.length ? `; retirados ${i.removeSpecial.join(", ")}` : ""})` : null].filter(Boolean).join(" + ");
      await log(`Google Business: ${what} atualizado em "${loc.title}" (${loc.locationName})`, loc.id);
      out.push({ locationId: loc.id, title: loc.title, ok: true, error: null });
    } catch (err) {
      out.push({ locationId: loc.id, title: loc.title, ok: false, error: err instanceof GbpApiError ? err.message : safeError(err) });
    }
  }
  return out;
}

export async function listPosts(client: Pick<BusinessClient, "listPosts">, loc: ManageLocation) {
  return parsePosts(await client.listPosts(loc.accountName, loc.locationName, 20));
}

/** Publica o mesmo post em vários perfis (valida uma vez antes). */
export async function createPosts(client: Pick<BusinessClient, "createPost">, locs: readonly ManageLocation[], input: PostInput, log: Log): Promise<Array<ApplyResult & { name: string | null }>> {
  const body = buildLocalPost(input);
  const out: Array<ApplyResult & { name: string | null }> = [];
  for (const loc of locs) {
    try {
      const r = await client.createPost(loc.accountName, loc.locationName, body);
      const name = typeof r?.name === "string" ? r.name : null;
      await log(`Google Business: publicação (${POST_TOPIC_LABELS[(body.topicType as keyof typeof POST_TOPIC_LABELS)] ?? body.topicType}) criada em "${loc.title}"${name ? ` — ${name}` : ""}`, loc.id);
      out.push({ locationId: loc.id, title: loc.title, ok: true, error: null, name });
    } catch (err) {
      out.push({ locationId: loc.id, title: loc.title, ok: false, error: err instanceof GbpApiError ? err.message : safeError(err), name: null });
    }
  }
  return out;
}

export async function deletePost(client: Pick<BusinessClient, "deletePost">, loc: ManageLocation, postName: string, log: Log) {
  if (!postName.startsWith(`${loc.accountName}/${loc.locationName}/localPosts/`)) throw new Error("A publicação não pertence a este perfil.");
  await client.deletePost(postName);
  await log(`Google Business: publicação apagada em "${loc.title}" — ${postName}`, loc.id);
}

// ─── Rascunho com IA (lite) ─────────────────────────────────────────────────

const POST_SYSTEM = [
  "Escreves publicações curtas para os perfis Google (Google Business Profile) da Multipark — parques de estacionamento e valet nos aeroportos de Lisboa, Porto e Faro (marcas Multipark, Redpark, Skypark, Airpark, Multibags, Multidriver).",
  "Português de Portugal (PT-PT), tom simpático e profissional, 2 a 4 frases, no máximo 600 caracteres, sem hashtags, sem emojis, sem preços nem promessas que não estejam no tema.",
  "Termina com um convite à ação coerente com o botão pedido (reservar, saber mais, ligar). Devolve só o texto da publicação.",
].join(" ");

export async function draftPost(i: { topic: string; topicType: string; brand?: string | null; city?: string | null; cta?: string | null; userId: number }): Promise<{ text: string | null; skipped: string | null }> {
  const { tryAi } = await import("../../aiOps/aiCall");
  const input = [
    `Tipo: ${i.topicType}`, i.brand ? `Marca: ${i.brand}` : null, i.city ? `Cidade: ${i.city}` : null, i.cta ? `Botão: ${i.cta}` : null,
    `Tema: ${i.topic.slice(0, 800)}`,
  ].filter(Boolean).join("\n");
  const r = await tryAi({ feature: "gbp_post_draft", system: POST_SYSTEM, input, maxTokens: 300, userId: i.userId, entity: "gbp_post" });
  if (!r.ok) return { text: null, skipped: r.skipped };
  const text = String(r.output ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 1500);
  return { text: text || null, skipped: text ? null : "error" };
}

export const manageLocationOf = (l: GbpLocationRow): ManageLocation => ({ id: l.id, locationName: l.locationName, accountName: l.accountName, title: l.title });
