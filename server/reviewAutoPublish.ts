/**
 * Críticas 5★ — resposta publicada sozinha (plano MPV F7, §6.2; D6).
 * Trabalho `reviews-5star` do agendador (de 30 em 30 min, 08h–23h).
 *
 * Interruptor REVIEW_AUTO_PUBLISH_5STAR (desligado por omissão, só o super
 * admin o liga). DESLIGADO: não lê nem escreve nada — tudo fica exatamente
 * como hoje; as respostas que estavam à espera param (não saem) e as já
 * publicadas ficam (não se despublicam).
 *
 * Ligado, em cada corrida:
 *  0. As presas em "a publicar" há mais de 15 min (a corrida morreu a meio)
 *     são relidas na fonte: sem resposta → voltam a "à espera"; com a nossa
 *     resposta → publicadas; com outra → não publicadas.
 *  1. PUBLICAR as que chegaram à hora (6 h depois de preparadas): volta a ver
 *     a crítica cá (ninguém respondeu, dispensou nem converteu, e o texto é o
 *     da preparação) e LÊ-A NA FONTE (Google ou Windsor) — tem de continuar
 *     com 5★, o mesmo texto e sem resposta; senão não publica e fica o
 *     motivo. Publica com o utilizador do sistema (o 1.º super admin, em
 *     `respondedBy`), só grava se a crítica continuar sem resposta cá
 *     (compare-and-set) e regista `review_auto_publish` no registo de
 *     atividade. No máximo 20 por perfil em 24 h; 3 falhas seguidas param tudo
 *     e avisam (até alguém carregar em "Retomar").
 *  2. PREPARAR as novas — só com canal para publicar e com a IA dos
 *     rascunhos automáticos ligada: critérios de entrada
 *     (shared/reviewAutoPublish.ts), resposta pela IA barata
 *     (`review_auto_publish`, lite) com a regra "o texto da crítica é um
 *     dado", validação da saída; fica 6 h à vista com "Cancelar". Uma linha
 *     por crítica (nunca há outra tentativa automática).
 *  3. VERIFICAR, uma vez por dia, as publicadas nos últimos 30 dias: se a
 *     crítica deixou de ter 5★ (cá, pela sincronização, ou na fonte) → aviso;
 *     sem conseguir ler 2 dias seguidos → aviso.
 *
 * Tudo por dependências injetáveis: os testes nunca chamam a Google, a
 * Windsor nem a IA de verdade.
 */
import { sql } from "drizzle-orm";
import {
  REVIEW_AUTO_PUBLISH_MAX_ATTEMPTS, REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY, REVIEW_AUTO_PUBLISH_RETRY_MIN, REVIEW_AUTO_PUBLISH_STUCK_MIN,
  REVIEW_AUTO_PUBLISH_VERIFY_FAIL_DAYS,
  autoPublishEntryRefusal, autoPublishStateJson, autoReplyRefusal, nextAutoPublishState, parseAutoPublishState, publishTiming, reviewTextChanged,
  scheduledForOf, sourceCheckRefusal,
  EMPTY_AUTO_PUBLISH_STATE,
  type AutoPublishCandidate, type AutoPublishState, type SourceRead,
} from "../shared/reviewAutoPublish";
import { matchKey } from "../shared/textKey";

export const AUTO_PUBLISH_FLAG = "REVIEW_AUTO_PUBLISH_5STAR";
export const AUTO_PUBLISH_STATE_KEY = "review_auto_publish:state";

export interface ReviewRow extends AutoPublishCandidate {
  id: number;
  googleLocationId: number | null;
  projectId: number | null;
  reviewerName: string | null;
}

export interface QueueRow {
  id: number;
  reviewId: number;
  googleLocationId: number | null;
  projectId: number | null;
  status: string;
  replyText: string | null;
  /** O texto da crítica quando a resposta foi preparada (se mudar, não se publica). */
  reviewTextAtPrepare?: string | null;
  scheduledFor: string | null;
  attempts: number;
  publishedAt?: string | null;
  verifyFailures?: number;
}

export interface QueuePatch {
  status?: string;
  reason?: string | null;
  attempts?: number;
  lastAttemptAt?: string;
  publishedAt?: string;
  channel?: string;
  scheduledFor?: string;
  verifiedAt?: string;
  verifyFailures?: number;
  alertedAt?: string;
  /** 0715: gravado ANTES de enviar à Google/Windsor. */
  sentAt?: string;
}

/** Erro "já tem resposta cá dentro" no publicar (compare-and-set): não é uma falha, é "não se publica". */
export class AlreadyAnsweredError extends Error {
  constructor(message = "a crítica já tem resposta") { super(message); this.name = "AlreadyAnsweredError"; }
}

export interface AutoPublishDeps {
  flagOn(): Promise<boolean>;
  nowMs(): number;
  /** Estado + o texto lido (para o compare-and-set ao gravar). */
  loadState(): Promise<{ state: AutoPublishState; raw: string | null }>;
  /** Grava só se o estado ainda for `prevRaw` (true = gravou). */
  saveState(s: AutoPublishState, prevRaw: string | null): Promise<boolean>;
  /** Candidatas (sem os perfis que já chegaram ao teto das 24 h). */
  candidates(limit: number): Promise<ReviewRow[]>;
  preparedLast24h(googleLocationId: number | null): Promise<number>;
  publishedLast24h(googleLocationId: number | null): Promise<number>;
  aiAvailable(): Promise<boolean>;
  draft(review: ReviewRow): Promise<{ text: string; raw: string }>;
  insertQueue(row: { reviewId: number; googleLocationId: number | null; projectId: number | null; status: "scheduled" | "skipped"; replyText: string | null; reviewTextAtPrepare: string | null; reason: string | null; scheduledFor: string | null }): Promise<boolean>;
  dueRows(limit: number): Promise<QueueRow[]>;
  /** Linhas em "a publicar" há mais de `minutes` min. */
  stuckRows(minutes: number, limit: number): Promise<QueueRow[]>;
  loadReview(id: number): Promise<ReviewRow | null>;
  readAtSource(review: ReviewRow, timeoutMs: number): Promise<SourceRead>;
  replyChannel(): Promise<"google" | "windsor" | "none">;
  /**
   * Publica (compare-and-set: lança AlreadyAnsweredError se a crítica já tiver resposta cá). `stored: false` =
   * enviada, mas uma pessoa respondeu cá ao mesmo tempo (perdeu a corrida depois do envio).
   */
  publish(reviewId: number, text: string): Promise<{ channel: string; stored?: boolean }>;
  /** UPDATE da linha; com `expectStatus`, só se ainda estiver nesse estado (true = mudou). */
  markRow(id: number, patch: QueuePatch, expectStatus?: string): Promise<boolean>;
  verifyRows(limit: number): Promise<QueueRow[]>;
  notify(input: import("./notify").NotifyInput): Promise<unknown>;
  log(entry: { reviewId: number; details: string }): Promise<void>;
}

export interface AutoPublishReport {
  ok: boolean;
  done: boolean;
  skipped?: string;
  reason?: string;
  paused?: string | null;
  prepared: number;
  notPrepared: string[];
  published: number;
  notPublished: string[];
  failed: number;
  verified: number;
  alerts: number;
  errors: string[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Corre uma vez. Nunca lança (os erros vão no relatório). */
export async function runReviewAutoPublish(o: { deadlineAt?: number } = {}, deps: AutoPublishDeps = realAutoPublishDeps): Promise<AutoPublishReport> {
  const report: AutoPublishReport = { ok: true, done: true, prepared: 0, notPrepared: [], published: 0, notPublished: [], failed: 0, verified: 0, alerts: 0, errors: [] };
  // Desligado: não lê nem escreve nada (o comportamento de hoje, exatamente).
  if (!(await deps.flagOn().catch(() => false))) return { ...report, skipped: "off", reason: `Interruptor ${AUTO_PUBLISH_FLAG} desligado.` };
  const deadlineAt = o.deadlineAt ?? Date.now() + 35_000;
  const timeLeft = (ms: number) => Date.now() + ms < deadlineAt;
  /** Teto de uma leitura na fonte: tem de caber no que resta da corrida. */
  const readBudget = () => Math.max(3_000, Math.min(20_000, deadlineAt - Date.now() - 8_000));
  const loaded = await deps.loadState().catch(() => ({ state: { ...EMPTY_AUTO_PUBLISH_STATE }, raw: null as string | null }));
  let state = loaded.state;
  const stateRaw = loaded.raw;
  report.paused = state.pausedAt;
  const channel = await deps.replyChannel().catch(() => "none" as const);

  // ── 0. Presas em "a publicar" (a corrida morreu a meio) ──
  try {
    for (const row of await deps.stuckRows(REVIEW_AUTO_PUBLISH_STUCK_MIN, 5)) {
      if (!timeLeft(15_000)) { report.done = false; break; }
      const review = await deps.loadReview(row.reviewId);
      if (!review) continue;
      const src = await deps.readAtSource(review, readBudget());
      if (!src.ok) continue; // tenta noutra corrida
      if (!src.hasReply) {
        await deps.markRow(row.id, { status: "scheduled", reason: "estava presa em «a publicar»; relida na fonte, sem resposta — volta à espera" }, "publishing");
      } else if (matchKey(src.replyText ?? review.googleReply) === matchKey(row.replyText)) {
        // A resposta que está na fonte é a que enviámos (a corrida morreu depois de enviar).
        await deps.markRow(row.id, { status: "published", publishedAt: iso(deps.nowMs()), reason: "estava presa em «a publicar»; a resposta na fonte é a nossa" }, "publishing");
      } else {
        await deps.markRow(row.id, { status: "skipped", reason: "estava presa em «a publicar» e a crítica já tem resposta na fonte" }, "publishing");
      }
    }
  } catch (err: any) {
    report.errors.push(`presas: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  // ── 1. Publicar as que chegaram à hora ──
  if (!state.pausedAt) {
    try {
      const rows = await deps.dueRows(10);
      if (rows.length && channel === "none") report.notPublished.push("sem canal para publicar (Google não ligada e GBP_WINDSOR_REPLY desligado) — ficam à espera");
      for (const row of channel === "none" ? [] : rows) {
        if (!timeLeft(15_000)) { report.done = false; break; }
        // Desligado a meio: pára já (as que faltam ficam à espera e não saem).
        if (!(await deps.flagOn().catch(() => false))) { report.notPublished.push("interruptor desligado a meio — parado"); break; }
        const now = deps.nowMs();
        const timing = publishTiming(row.scheduledFor, now);
        if (timing === "early") continue;
        if (timing === "expired") {
          await deps.markRow(row.id, { status: "skipped", reason: "passou o prazo (interruptor desligado ou agendador parado) — não sai" }, "scheduled");
          report.notPublished.push(`#${row.reviewId}: passou o prazo`);
          continue;
        }
        const review = await deps.loadReview(row.reviewId);
        // Cá dentro: alguém respondeu, dispensou, converteu ou marcou entretanto? (a idade conta na preparação)
        const local = !review ? "a crítica já não existe" : autoPublishEntryRefusal({ ...review, reviewDate: null, sourceEmailDate: null, createdAt: new Date(now).toISOString() }, now);
        const prepared = row.reviewTextAtPrepare !== undefined ? row.reviewTextAtPrepare : review?.reviewText ?? null;
        const textChanged = !local && review && reviewTextChanged(prepared, review.reviewText) ? "o texto da crítica mudou desde que a resposta foi preparada" : null;
        const reply = local || textChanged ? null : autoReplyRefusal(row.replyText, { reviewText: review!.reviewText, raw: row.replyText });
        const refusal = local ?? textChanged ?? reply;
        if (refusal) {
          await deps.markRow(row.id, { status: "skipped", reason: refusal.slice(0, 300) }, "scheduled");
          report.notPublished.push(`#${row.reviewId}: ${refusal}`);
          continue;
        }
        if ((await deps.publishedLast24h(row.googleLocationId)) >= REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY) {
          report.notPublished.push(`#${row.reviewId}: perfil com ${REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY} publicadas nas últimas 24 h — fica para depois`);
          continue;
        }
        // Na fonte: 5★, o texto da preparação e sem resposta — senão não se publica.
        const src = await deps.readAtSource(review!, readBudget());
        const changed = sourceCheckRefusal({ reviewText: prepared }, src);
        if (changed && src.ok) {
          await deps.markRow(row.id, { status: "skipped", reason: changed.slice(0, 300) }, "scheduled");
          report.notPublished.push(`#${row.reviewId}: ${changed}`);
          continue;
        }
        // Reserva (duas corridas nunca publicam a mesma).
        if (!(await deps.markRow(row.id, { status: "publishing", lastAttemptAt: iso(now), attempts: row.attempts + 1 }, "scheduled"))) continue;
        let outcome: { ok: boolean; error?: string };
        if (changed) {
          outcome = { ok: false, error: changed };
        } else {
          try {
            // Marcador ANTES de enviar: se a corrida morrer a seguir, a releitura sabe que pode ter saído.
            await deps.markRow(row.id, { sentAt: iso(deps.nowMs()) }, "publishing");
            const r = await deps.publish(row.reviewId, String(row.replyText));
            const lost = r.stored === false;
            await deps.markRow(row.id, { status: "published", publishedAt: iso(deps.nowMs()), channel: r.channel, reason: lost ? "publicada, mas uma pessoa respondeu cá ao mesmo tempo — ver qual ficou no Google" : null });
            await deps.log({ reviewId: row.reviewId, details: lost
              ? `Resposta automática (5★) publicada${r.channel === "windsor" ? " pela Windsor" : " no Google"}, mas uma pessoa respondeu ao mesmo tempo (a de cá não foi gravada por cima) — ver qual ficou no perfil`
              : `Resposta automática (5★) publicada${r.channel === "windsor" ? " pela Windsor" : " no Google"} (6 h à vista; 5★, mesmo texto e sem resposta na fonte antes de publicar)` });
            if (lost) {
              await deps.notify({
                kind: "review_auto_publish", noCityToAll: true, recipientFilter: (c) => c.role === "super_admin",
                title: "Críticas 5★: a resposta automática cruzou-se com uma pessoa",
                body: `A crítica #${row.reviewId} foi respondida por uma pessoa no mesmo instante em que saiu a resposta automática. Cá ficou a da pessoa; no Google fica a última que chegou. Abre a crítica e confirma no perfil Google qual ficou.`,
                link: `/criticas?id=${row.reviewId}`, entity: { type: "review_auto_publish_race", id: row.reviewId },
              }).catch(() => undefined);
              report.alerts++;
            }
            report.published++;
            outcome = { ok: true };
          } catch (err: any) {
            if (err instanceof AlreadyAnsweredError || err?.name === "ReplyAlreadyThereError" || err?.name === "AlreadyAnsweredError") {
              // Alguém respondeu cá entre a leitura e o publicar: não é falha, é "não sai".
              await deps.markRow(row.id, { status: "skipped", reason: "a crítica ganhou resposta entretanto — a automática não a substitui" });
              report.notPublished.push(`#${row.reviewId}: já tinha resposta`);
              continue;
            }
            outcome = { ok: false, error: String(err?.message ?? err).slice(0, 200) };
          }
        }
        if (!outcome.ok) {
          const attempts = row.attempts + 1;
          const last = attempts >= REVIEW_AUTO_PUBLISH_MAX_ATTEMPTS;
          await deps.markRow(row.id, last
            ? { status: "failed", reason: `falhou ${attempts} vezes: ${outcome.error}`.slice(0, 300) }
            : { status: "scheduled", reason: `tentativa ${attempts} falhou: ${outcome.error}`.slice(0, 300), scheduledFor: iso(now + REVIEW_AUTO_PUBLISH_RETRY_MIN * 60_000) });
          report.failed++;
          report.notPublished.push(`#${row.reviewId}: ${outcome.error}`);
        }
        const before = state.pausedAt;
        state = nextAutoPublishState(state, outcome, iso(deps.nowMs()));
        if (!before && state.pausedAt) {
          report.alerts++;
          report.paused = state.pausedAt;
          break;
        }
      }
    } catch (err: any) {
      report.errors.push(`publicar: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    // Compare-and-set: se alguém carregou em "Retomar" entretanto, o "Retomar" ganha.
    if (autoPublishStateJson(state) !== autoPublishStateJson(loaded.state)) {
      const saved = await deps.saveState(state, stateRaw).catch((err: any) => { report.errors.push(`estado: ${String(err?.message ?? err).slice(0, 120)}`); return false; });
      if (!saved) report.notPublished.push("o estado mudou durante a corrida (ex.: «Retomar») — fica o que lá está");
      else if (state.pausedAt && !loaded.state.pausedAt) {
        await deps.notify({
          kind: "review_auto_publish", noCityToAll: true,
          title: "Críticas 5★: a publicação automática parou",
          body: `Falhou ${state.consecutiveFailures} vezes seguidas (última: ${state.pausedReason ?? "erro"}). Nada mais é publicado sozinho até alguém carregar em "Retomar" nas Críticas (ou desligar o interruptor). As respostas à espera ficam à espera.`,
          link: "/criticas", entity: { type: "review_auto_publish_pause", id: state.pausedAt },
        }).catch(() => undefined);
      }
    }
  }

  // ── 2. Preparar as novas (só com canal para publicar e com a IA ligada) ──
  if (!state.pausedAt && timeLeft(20_000)) {
    try {
      if (channel === "none") {
        report.notPrepared.push("sem canal para publicar (Google não ligada e GBP_WINDSOR_REPLY desligado) — não se prepara nada");
      } else if (!(await deps.aiAvailable())) {
        report.notPrepared.push("IA indisponível (AI_REVIEW_AUTO_DRAFTS desligado, sem orçamento ou sem fornecedor) — não se prepara nada");
      } else {
        const perLocation = new Map<string, number>();
        for (const c of await deps.candidates(5)) {
          if (!timeLeft(17_000)) { report.done = false; break; }
          const now = deps.nowMs();
          const refusal = autoPublishEntryRefusal(c, now);
          if (refusal) {
            await deps.insertQueue({ reviewId: c.id, googleLocationId: c.googleLocationId, projectId: c.projectId, status: "skipped", replyText: null, reviewTextAtPrepare: c.reviewText ?? null, reason: refusal, scheduledFor: null });
            report.notPrepared.push(`#${c.id}: ${refusal}`);
            continue;
          }
          const lk = String(c.googleLocationId ?? "?");
          const already = perLocation.get(lk) ?? (await deps.preparedLast24h(c.googleLocationId));
          if (already >= REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY) { report.notPrepared.push(`#${c.id}: perfil já com ${already} em 24 h`); continue; }
          let draft: { text: string; raw: string };
          try {
            draft = await deps.draft(c);
          } catch (err: any) {
            // IA em baixo: tenta na próxima corrida (sem linha — nada fica "gasto").
            report.notPrepared.push(`#${c.id}: a IA falhou (${String(err?.code ?? err?.message ?? err).slice(0, 80)})`);
            break;
          }
          const bad = autoReplyRefusal(draft.text, { reviewText: c.reviewText, raw: draft.raw });
          const ok = await deps.insertQueue({
            reviewId: c.id, googleLocationId: c.googleLocationId, projectId: c.projectId,
            status: bad ? "skipped" : "scheduled", replyText: draft.text.slice(0, 4000) || null, reviewTextAtPrepare: c.reviewText ?? null,
            reason: bad, scheduledFor: bad ? null : scheduledForOf(now),
          });
          if (!ok) continue;
          if (bad) { report.notPrepared.push(`#${c.id}: ${bad}`); continue; }
          perLocation.set(lk, already + 1);
          report.prepared++;
        }
      }
    } catch (err: any) {
      report.errors.push(`preparar: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  // ── 3. Verificação diária das publicadas (estrelas que desceram, leituras que falham) ──
  if (timeLeft(10_000)) {
    try {
      for (const row of await deps.verifyRows(5)) {
        if (!timeLeft(10_000)) { report.done = false; break; }
        const review = await deps.loadReview(row.reviewId);
        if (!review) continue;
        const now = iso(deps.nowMs());
        const first = String(review.reviewerName ?? "um cliente").split(/\s+/)[0];
        // 1.º a classificação de cá (a sincronização já a atualizou?); só depois a fonte.
        const localStars = Number(review.rating ?? 5);
        const src: SourceRead = localStars < 5 ? { ok: true, rating: localStars, text: review.reviewText ?? null, hasReply: true } : await deps.readAtSource(review, readBudget());
        if (!src.ok) {
          const fails = (row.verifyFailures ?? 0) + 1;
          await deps.markRow(row.id, { verifiedAt: now, verifyFailures: fails });
          if (fails === REVIEW_AUTO_PUBLISH_VERIFY_FAIL_DAYS) {
            await deps.notify({
              kind: "review_auto_publish", projectId: review.projectId ?? row.projectId,
              title: "Crítica respondida sozinha: não deu para a confirmar",
              body: `Há ${fails} dias seguidos que não se consegue ler no Google a crítica de ${first} (respondida sozinha): ${src.reason}. Vê-a no perfil Google.`,
              link: "/criticas", entity: { type: "google_review_verify", id: review.id },
            }).catch(() => undefined);
            report.alerts++;
          }
          continue;
        }
        if (src.rating < 5) {
          await deps.notify({
            kind: "review_auto_publish", projectId: review.projectId ?? row.projectId,
            title: `Crítica respondida sozinha desceu para ${src.rating}★`,
            body: `A crítica de ${first} tinha 5★ quando a resposta automática foi publicada e agora tem ${src.rating}★. Vê se é preciso responder outra vez ou abrir uma reclamação.`,
            link: "/criticas", entity: { type: "google_review", id: review.id },
          }).catch(() => undefined);
          await deps.markRow(row.id, { verifiedAt: now, verifyFailures: 0, alertedAt: now });
          report.alerts++;
        } else {
          await deps.markRow(row.id, { verifiedAt: now, verifyFailures: 0 });
        }
        report.verified++;
      }
    } catch (err: any) {
      report.errors.push(`verificar: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  } else {
    report.done = false;
  }
  report.ok = report.errors.length === 0;
  return report;
}

// ─── Dependências reais (BD, IA, Google/Windsor) ────────────────────────────

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const affected = (res: unknown): number => Number((Array.isArray(res) ? res[0] : res as any)?.affectedRows ?? 0);
const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : String(v));

async function db() {
  const { getDb } = await import("./db");
  const d = await getDb();
  if (!d) throw new Error("Base de dados indisponível.");
  return d;
}

const REVIEW_COLS = sql`r.id, r.rating, r.googleReviewName, r.googleLocationId, r.projectId, r.complaintId, r.status, r.googleReply,
  DATE_FORMAT(r.respondedAt, '%Y-%m-%d %H:%i:%s') AS respondedAt, r.notAReview, r.duplicateOf, r.reviewText, r.reviewerName,
  DATE_FORMAT(r.reviewDate, '%Y-%m-%d %H:%i:%s') AS reviewDate, DATE_FORMAT(r.sourceEmailDate, '%Y-%m-%d %H:%i:%s') AS sourceEmailDate,
  DATE_FORMAT(r.createdAt, '%Y-%m-%d %H:%i:%s') AS createdAt`;

function toReview(r: any): ReviewRow {
  return {
    id: Number(r.id), rating: num(r.rating), googleReviewName: str(r.googleReviewName), googleLocationId: num(r.googleLocationId), projectId: num(r.projectId),
    complaintId: num(r.complaintId), status: str(r.status), googleReply: str(r.googleReply), respondedAt: str(r.respondedAt),
    notAReview: num(r.notAReview), duplicateOf: num(r.duplicateOf), reviewText: str(r.reviewText), reviewerName: str(r.reviewerName),
    reviewDate: str(r.reviewDate), sourceEmailDate: str(r.sourceEmailDate), createdAt: str(r.createdAt),
  };
}

function toQueue(r: any): QueueRow {
  return {
    id: Number(r.id), reviewId: Number(r.reviewId), googleLocationId: num(r.googleLocationId), projectId: num(r.projectId), status: String(r.status),
    replyText: str(r.replyText), reviewTextAtPrepare: str(r.reviewTextAtPrepare), scheduledFor: str(r.scheduledFor), attempts: Number(r.attempts ?? 0),
    publishedAt: str(r.publishedAt), verifyFailures: Number(r.verifyFailures ?? 0),
  };
}

const QUEUE_COLS = sql`id, reviewId, googleLocationId, projectId, status, replyText, reviewTextAtPrepare, DATE_FORMAT(scheduledFor, '%Y-%m-%d %H:%i:%s') AS scheduledFor,
  attempts, DATE_FORMAT(publishedAt, '%Y-%m-%d %H:%i:%s') AS publishedAt, verifyFailures`;

export const realAutoPublishDeps: AutoPublishDeps = {
  flagOn: async () => {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides(true);
    return isFeatureEnabled(AUTO_PUBLISH_FLAG, { defaultEnabled: automationFlagDefault(AUTO_PUBLISH_FLAG) });
  },
  nowMs: () => Date.now(),
  loadState: async () => {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT \`value\` FROM web_analytics_state WHERE stateKey = ${AUTO_PUBLISH_STATE_KEY} LIMIT 1`))[0];
    const raw = r?.value == null ? null : String(r.value);
    return { state: parseAutoPublishState(raw), raw };
  },
  saveState: async (s, prevRaw) => {
    const d = await db();
    const value = autoPublishStateJson(s);
    if (prevRaw == null) {
      const ins = await d.execute(sql`INSERT IGNORE INTO web_analytics_state (stateKey, \`value\`) VALUES (${AUTO_PUBLISH_STATE_KEY}, ${value})`);
      if (affected(ins) > 0) return true;
      const upd = await d.execute(sql`UPDATE web_analytics_state SET \`value\` = ${value} WHERE stateKey = ${AUTO_PUBLISH_STATE_KEY} AND \`value\` IS NULL`);
      return affected(upd) > 0;
    }
    const upd = await d.execute(sql`UPDATE web_analytics_state SET \`value\` = ${value} WHERE stateKey = ${AUTO_PUBLISH_STATE_KEY} AND \`value\` = ${prevRaw}`);
    return affected(upd) > 0;
  },
  candidates: async (limit) => {
    const d = await db();
    const { REVIEW_AUTO_PUBLISH_MAX_AGE_DAYS } = await import("../shared/reviewAutoPublish");
    // Pré-filtro no SQL (a regra pura volta a ver tudo): 5★ ligadas ao Google, sem resposta nem reclamação, não marcadas,
    // recentes, ainda não na fila — e fora os perfis que já chegaram ao teto das 24 h (não tapam os outros).
    const res = await d.execute(sql`
      SELECT ${REVIEW_COLS} FROM google_reviews r
        LEFT JOIN review_auto_publish q ON q.reviewId = r.id
       WHERE q.id IS NULL AND r.rating = 5 AND r.googleReviewName IS NOT NULL AND r.complaintId IS NULL
         AND r.googleReply IS NULL AND r.respondedAt IS NULL AND r.notAReview = 0 AND r.duplicateOf IS NULL
         AND r.status IN ('pending_response', 'ai_responded')
         AND r.reviewDate >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${REVIEW_AUTO_PUBLISH_MAX_AGE_DAYS} DAY)
         AND (r.googleLocationId IS NULL OR r.googleLocationId NOT IN (
           SELECT x.googleLocationId FROM (
             SELECT googleLocationId FROM review_auto_publish
              WHERE googleLocationId IS NOT NULL AND status IN ('scheduled', 'publishing', 'published') AND createdAt >= NOW() - INTERVAL 24 HOUR
              GROUP BY googleLocationId HAVING COUNT(*) >= ${REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY}) x))
       ORDER BY r.id DESC LIMIT ${Math.max(1, Math.min(20, limit))}`);
    return rowsOf(res).map(toReview);
  },
  preparedLast24h: async (loc) => {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM review_auto_publish
      WHERE googleLocationId <=> ${loc} AND status IN ('scheduled', 'publishing', 'published') AND createdAt >= NOW() - INTERVAL 24 HOUR`))[0];
    return Number(r?.n ?? 0) || 0;
  },
  publishedLast24h: async (loc) => {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM review_auto_publish
      WHERE googleLocationId <=> ${loc} AND status = 'published' AND publishedAt >= UTC_TIMESTAMP() - INTERVAL 24 HOUR`))[0];
    return Number(r?.n ?? 0) || 0;
  },
  aiAvailable: async () => (await import("./_core/ai/status")).aiFeatureAvailableFresh("review_auto_publish"),
  draft: async (review) => (await import("./_core/ai/reviewReply")).draftAutoPublishReply(
    { rating: review.rating, reviewerName: review.reviewerName, reviewText: review.reviewText }, { reviewId: review.id },
  ),
  insertQueue: async (row) => {
    const d = await db();
    const res = await d.execute(sql`
      INSERT IGNORE INTO review_auto_publish (reviewId, googleLocationId, projectId, status, replyText, reviewTextAtPrepare, reason, scheduledFor)
      VALUES (${row.reviewId}, ${row.googleLocationId}, ${row.projectId}, ${row.status}, ${row.replyText}, ${row.reviewTextAtPrepare}, ${row.reason ? row.reason.slice(0, 300) : null}, ${row.scheduledFor})`);
    return affected(res) > 0;
  },
  dueRows: async (limit) => {
    const d = await db();
    const res = await d.execute(sql`SELECT ${QUEUE_COLS} FROM review_auto_publish
      WHERE status = 'scheduled' AND scheduledFor <= UTC_TIMESTAMP() ORDER BY scheduledFor, id LIMIT ${Math.max(1, Math.min(20, limit))}`);
    return rowsOf(res).map(toQueue);
  },
  stuckRows: async (minutes, limit) => {
    const d = await db();
    const res = await d.execute(sql`SELECT ${QUEUE_COLS} FROM review_auto_publish
      WHERE status = 'publishing' AND lastAttemptAt < UTC_TIMESTAMP() - INTERVAL ${minutes} MINUTE ORDER BY lastAttemptAt, id LIMIT ${Math.max(1, Math.min(20, limit))}`);
    return rowsOf(res).map(toQueue);
  },
  loadReview: async (id) => {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT ${REVIEW_COLS} FROM google_reviews r WHERE r.id = ${id} LIMIT 1`))[0];
    return r ? toReview(r) : null;
  },
  readAtSource: async (review, timeoutMs) => (await import("./integrations/googleBusiness/sourceRead")).readReviewAtSource(
    { googleReviewName: review.googleReviewName, reviewDate: (review.reviewDate as string | null) ?? null }, undefined, Date.now(), timeoutMs,
  ),
  replyChannel: async () => (await import("./integrations/googleBusiness/service")).currentReplyChannel(),
  publish: async (reviewId, text) => {
    const [{ publishReply }, { getSystemUserId }] = await Promise.all([import("./integrations/googleBusiness/service"), import("./db")]);
    // O "utilizador do sistema" é o 1.º super admin (getSystemUserId). Compare-and-set: só se continuar sem resposta.
    const r = await publishReply(reviewId, text, await getSystemUserId(), { onlyIfNoReply: true });
    return { channel: r.channel, stored: r.stored };
  },
  markRow: async (id, patch, expectStatus) => {
    const d = await db();
    const sets: ReturnType<typeof sql>[] = [];
    if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
    if (patch.reason !== undefined) sets.push(sql`reason = ${patch.reason}`);
    if (patch.attempts !== undefined) sets.push(sql`attempts = ${patch.attempts}`);
    if (patch.lastAttemptAt !== undefined) sets.push(sql`lastAttemptAt = ${patch.lastAttemptAt}`);
    if (patch.publishedAt !== undefined) sets.push(sql`publishedAt = ${patch.publishedAt}`);
    if (patch.channel !== undefined) sets.push(sql`channel = ${patch.channel}`);
    if (patch.scheduledFor !== undefined) sets.push(sql`scheduledFor = ${patch.scheduledFor}`);
    if (patch.verifiedAt !== undefined) sets.push(sql`verifiedAt = ${patch.verifiedAt}`);
    if (patch.verifyFailures !== undefined) sets.push(sql`verifyFailures = ${patch.verifyFailures}`);
    if (patch.alertedAt !== undefined) sets.push(sql`alertedAt = ${patch.alertedAt}`);
    if (patch.sentAt !== undefined) sets.push(sql`sentAt = ${patch.sentAt}`);
    if (!sets.length) return false;
    const res = await d.execute(sql`UPDATE review_auto_publish SET ${sql.join(sets, sql`, `)} WHERE id = ${id}${expectStatus ? sql` AND status = ${expectStatus}` : sql``}`);
    return affected(res) > 0;
  },
  verifyRows: async (limit) => {
    const d = await db();
    const res = await d.execute(sql`SELECT ${QUEUE_COLS} FROM review_auto_publish
      WHERE status = 'published' AND alertedAt IS NULL AND publishedAt >= UTC_TIMESTAMP() - INTERVAL 30 DAY
        AND (verifiedAt IS NULL OR verifiedAt < UTC_TIMESTAMP() - INTERVAL 20 HOUR)
      ORDER BY (verifiedAt IS NULL) DESC, verifiedAt, id LIMIT ${Math.max(1, Math.min(20, limit))}`);
    return rowsOf(res).map(toQueue);
  },
  notify: async (input) => (await import("./notify")).notify(input),
  log: async (e) => {
    const { getSystemUserId, logActivity } = await import("./db");
    await logActivity({ userId: await getSystemUserId(), action: "review_auto_publish", entity: "google_review", entityId: e.reviewId, details: e.details.slice(0, 500) });
  },
};

// ─── Página das Críticas: estado, cancelar, retomar ─────────────────────────

/** Interruptor para mostrar na página (cache de 30 s; o trabalho lê-o sempre fresco). */
async function flagOnCached(): Promise<boolean> {
  try {
    const [{ ensureFeatureFlagOverrides, isFeatureEnabled }, { automationFlagDefault }] = await Promise.all([import("./_core/featureFlags"), import("../shared/appSettings")]);
    await ensureFeatureFlagOverrides();
    return isFeatureEnabled(AUTO_PUBLISH_FLAG, { defaultEnabled: automationFlagDefault(AUTO_PUBLISH_FLAG) });
  } catch { return false; }
}

export interface AutoPublishView {
  status: string;
  replyText: string | null;
  reason: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  cancelledAt: string | null;
  /** O interruptor está ligado agora? (desligado: as que estão à espera não saem). */
  flagOn: boolean;
}

/** A linha da fila de uma crítica (null = nunca entrou). Sem a tabela (0705 por aplicar) → null. */
export async function autoPublishFor(reviewId: number): Promise<AutoPublishView | null> {
  try {
    const d = await db();
    const r = rowsOf(await d.execute(sql`SELECT status, replyText, reason, DATE_FORMAT(scheduledFor, '%Y-%m-%d %H:%i:%s') AS scheduledFor,
        DATE_FORMAT(publishedAt, '%Y-%m-%d %H:%i:%s') AS publishedAt, DATE_FORMAT(cancelledAt, '%Y-%m-%d %H:%i:%s') AS cancelledAt
      FROM review_auto_publish WHERE reviewId = ${reviewId} LIMIT 1`))[0];
    if (!r) return null;
    const flag = await flagOnCached();
    return { status: String(r.status), replyText: str(r.replyText), reason: str(r.reason), scheduledFor: str(r.scheduledFor), publishedAt: str(r.publishedAt), cancelledAt: str(r.cancelledAt), flagOn: flag };
  } catch { return null; }
}

/** "Cancelar": a resposta à espera não sai (fica registada como cancelada; nada se apaga). */
export async function cancelAutoPublish(reviewId: number, userId: number): Promise<{ cancelled: boolean }> {
  const d = await db();
  const res = await d.execute(sql`UPDATE review_auto_publish SET status = 'cancelled', cancelledById = ${userId}, cancelledAt = UTC_TIMESTAMP(), reason = 'cancelada à mão'
    WHERE reviewId = ${reviewId} AND status = 'scheduled'`);
  return { cancelled: affected(res) > 0 };
}

/**
 * O que falta para as respostas automáticas saírem (para a página dizer em
 * vez de "ligadas"): canal de publicação e a IA dos rascunhos automáticos.
 */
async function autoPublishMissing(): Promise<string[]> {
  const out: string[] = [];
  try {
    if ((await realAutoPublishDeps.replyChannel()) === "none") out.push("um canal para publicar (ligar a Google em Integrações, ou a Windsor com o interruptor «Críticas: publicar respostas no Google pela Windsor»)");
  } catch { out.push("um canal para publicar (não deu para ver a ligação à Google)"); }
  try {
    if (!(await realAutoPublishDeps.aiAvailable())) out.push("a IA dos rascunhos automáticos (interruptor «IA: rascunho automático para cada crítica nova», orçamento ou fornecedor)");
  } catch { out.push("a IA dos rascunhos automáticos"); }
  return out;
}

/** Estado geral (parado? o que falta?) para a página. */
export async function autoPublishStatus(): Promise<{ flagOn: boolean; state: AutoPublishState; waiting: number; missing: string[] }> {
  const flag = await flagOnCached();
  let state = { ...EMPTY_AUTO_PUBLISH_STATE };
  let waiting = 0;
  if (!flag) return { flagOn: false, state, waiting, missing: [] };
  try { state = (await realAutoPublishDeps.loadState()).state; } catch { /* sem estado */ }
  try {
    const d = await db();
    waiting = Number(rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM review_auto_publish WHERE status = 'scheduled'`))[0]?.n ?? 0) || 0;
  } catch { /* sem tabela */ }
  return { flagOn: flag, state, waiting, missing: await autoPublishMissing() };
}

/** "Retomar" depois de parar por falhas seguidas (compare-and-set: só se continuar parado como foi lido). */
export async function resumeAutoPublish(): Promise<{ resumed: boolean; state: AutoPublishState }> {
  const { state, raw } = await realAutoPublishDeps.loadState();
  if (!state.pausedAt) return { resumed: false, state };
  const next = { ...EMPTY_AUTO_PUBLISH_STATE };
  const ok = await realAutoPublishDeps.saveState(next, raw);
  return { resumed: ok, state: ok ? next : state };
}
