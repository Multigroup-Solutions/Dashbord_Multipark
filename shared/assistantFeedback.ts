/**
 * 👍/👎 do Multis e "Perguntas que falharam" (Jorge, 8 out 2026 — "Multis 2").
 * Regras PARTILHADAS servidor ↔ cliente. PURAS.
 *
 *  - Cada pessoa avalia as respostas das SUAS conversas; mudar de ideias
 *    atualiza a mesma linha.
 *  - Depois de cada resposta, o servidor marca sozinho (auto) as que dizem que
 *    não sabe / não tem acesso / não encontrou nos manuais, e as em que uma
 *    ferramenta devolveu erro — `detectUnanswered`.
 *  - A lista "Perguntas que falharam" é só de admin/super_admin; guarda cópia
 *    da pergunta e da resposta (as conversas apagam-se aos 30 dias). Nada se
 *    apaga desta tabela.
 */

export const FEEDBACK_REASONS = ["errada", "incompleta", "nao_percebeu", "sem_dados", "outro"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];
export const FEEDBACK_REASON_LABELS: Record<FeedbackReason, string> = {
  errada: "Resposta errada",
  incompleta: "Incompleta",
  nao_percebeu: "Não percebeu a pergunta",
  sem_dados: "Não sabia / sem dados",
  outro: "Outro",
};

export const FEEDBACK_COMMENT_MAX = 500;
export const FEEDBACK_ANSWER_MAX = 4000;
export const FEEDBACK_QUESTION_MAX = 4000;
export const FEEDBACK_PERIODS = [7, 30, 90] as const;
export type FeedbackPeriod = (typeof FEEDBACK_PERIODS)[number];
export const FEEDBACK_STATUSES = ["open", "resolved", "all"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = { open: "Por tratar", resolved: "Tratadas", all: "Todas" };

export interface ToolErrorNote { tool: string; error: string }

const norm = (s: string) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Frases (já sem acentos, minúsculas) de uma resposta que não respondeu.
 * Escolhidas para NÃO apanhar respostas normais: "não há reservas", "não
 * encontrei reservas para amanhã" ou "não tens tarefas" são respostas certas.
 */
const UNANSWERED: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\bnao sei\b/, why: "diz que não sabe" },
  { re: /\bnao tenho (acesso|permissao)\b/, why: "diz que não tem acesso" },
  { re: /\bsem (acesso|permissao) (a|aos|para) (esses|estes|ver) /, why: "diz que não tem acesso" },
  { re: /\bnao tenho (essa |esta |nenhuma )?(informacao|informacoes|dados (sobre|para|de|dess)|forma de|maneira de|ferramenta)/, why: "diz que não tem a informação" },
  { re: /\bnao ha (nenhuma )?ferramenta\b/, why: "diz que não tem ferramenta" },
  { re: /\bnao (consigo|consegui) (ver|consultar|aceder|obter|responder|encontrar|confirmar|saber|ajudar)\b/, why: "diz que não conseguiu" },
  { re: /\bnao foi possivel (obter|consultar|carregar|aceder|ler|confirmar)\b/, why: "diz que não conseguiu obter os dados" },
  { re: /\bnao encontrei (nada sobre|nos manuais|na ajuda|essa informacao|esta informacao|informacao|resposta|nenhuma informacao)\b/, why: "diz que não encontrou nos manuais/ajuda" },
  { re: /\b(a ajuda|os manuais|o manual|a base de conhecimento) nao (cobre|cobrem|fala|falam|explica|explicam|diz|dizem|refere|referem|menciona|mencionam)\b/, why: "diz que a ajuda/os manuais não cobrem" },
  { re: /\bnao (esta|vem|aparece) (na ajuda|nos manuais|no manual)\b/, why: "diz que não está na ajuda/manuais" },
  { re: /\berro temporario\b/, why: "fala de erro temporário" },
];

/**
 * A resposta deve ser marcada sozinha como "falhou"? Devolve o motivo em texto
 * (para o comentário da linha) ou null. PURA.
 */
export function detectUnanswered(answer: string, toolErrors: readonly ToolErrorNote[] = []): string | null {
  const why: string[] = [];
  if (toolErrors.length) {
    const seen = new Set<string>();
    for (const e of toolErrors) {
      const k = `${e.tool}:${e.error}`;
      if (seen.has(k)) continue;
      seen.add(k);
      why.push(`Erro da ferramenta ${e.tool}: ${String(e.error).slice(0, 160)}`);
    }
  }
  const a = ` ${norm(answer)} `;
  const hit = UNANSWERED.find((p) => p.re.test(a));
  if (hit) why.push(`A resposta ${hit.why}.`);
  return why.length ? why.join(" · ").slice(0, 500) : null;
}

export interface FailedRow {
  id: number;
  messageId: number;
  auto: boolean;
  [k: string]: unknown;
}

/**
 * Uma linha por resposta na lista: a avaliação da pessoa (manual) ganha à
 * marca automática da mesma resposta, que fica indicada em `alsoAuto`. A
 * ordem de entrada mantém-se. PURA.
 */
export function mergeFailedRows<T extends FailedRow>(rows: readonly T[]): Array<T & { alsoAuto: boolean }> {
  const byMsg = new Map<number, T & { alsoAuto: boolean }>();
  const order: number[] = [];
  for (const r of rows) {
    const cur = byMsg.get(r.messageId);
    if (!cur) {
      byMsg.set(r.messageId, { ...r, alsoAuto: false });
      order.push(r.messageId);
    } else if (cur.auto && !r.auto) {
      byMsg.set(r.messageId, { ...r, alsoAuto: true });
    } else if (!cur.auto && r.auto) {
      cur.alsoAuto = true;
    }
  }
  return order.map((m) => byMsg.get(m)!);
}

/** Data de início do período (UTC "AAAA-MM-DD HH:MM:SS.mmm"). PURA. */
export function feedbackSince(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 23).replace("T", " ");
}
