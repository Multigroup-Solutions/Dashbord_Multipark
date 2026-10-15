// Avalia a triagem das reclamações (tipo + prioridade) — plano MPV F6b, T1.
//
// Corre as reclamações rotuladas (server/fixtures/complaintTriageCorpus.ts)
// pelo MESMO pedido de produção (server/complaintTriageEval.ts), com o
// fornecedor de IA configurado no ambiente (o mesmo do servidor), e mostra as
// contas e os casos que falhou. Não escreve nada nas reclamações.
//
// Uso:
//   pnpm tsx scripts/eval-complaint-triage.ts                    (como a produção, Definições incluídas)
//   pnpm tsx scripts/eval-complaint-triage.ts --thinking minimal (com raciocínio "minimal"; "env" = o de hoje)
//   pnpm tsx scripts/eval-complaint-triage.ts --compare          (o de hoje vs "minimal" e o veredicto)
//   pnpm tsx scripts/eval-complaint-triage.ts --json
//
// Sai com 0 se passar (no --compare: se o "minimal" puder ligar-se), 1 se não
// passar e 2 se a IA não estiver configurada (nenhum caso lido).
import { COMPLAINT_TRIAGE_TARGETS, evalComplaintTriage, type ComplaintEvalMetrics, type ComplaintEvalRow } from "../server/complaintTriageEval";
import { suggestedThinkingSetting, thinkingLevelVerdict } from "../shared/aiThinkingEval";

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const json = args.includes("--json");
const compare = args.includes("--compare");
const thinkingArg = opt("--thinking");
if (thinkingArg && !["minimal", "low", "medium", "high", "default", "env"].includes(thinkingArg)) {
  console.error("--thinking tem de ser minimal, low, medium, high, default ou env.");
  process.exit(2);
}
const limit = Number(opt("--limit")) || undefined;
const pct = (v: number) => `${String(Math.round(v * 100)).padStart(3)} %`;

function print(label: string, r: { rows: ComplaintEvalRow[]; metrics: ComplaintEvalMetrics; model: string | null }) {
  const m = r.metrics;
  console.log(`== ${label}: ${m.total} reclamações · modelo ${r.model ?? "—"}`);
  console.log(`Tipo certo ${pct(m.typeAccuracy)} (meta ${pct(COMPLAINT_TRIAGE_TARGETS.type)}) · prioridade certa ${pct(m.priorityAccuracy)} (meta ${pct(COMPLAINT_TRIAGE_TARGETS.priority)})`);
  console.log(`Urgentes abaixo de "alta" ${m.missedUrgent} (máx. ${COMPLAINT_TRIAGE_TARGETS.maxMissedUrgent}) · a IA falhou ${m.failed}`);
  const wrong = r.rows.filter((x) => !x.typeOk || !x.priorityOk);
  for (const w of wrong) console.log(`  ${w.id.padEnd(6)} devia ser ${w.expectedTypes.join("/")} · ${w.expectedPriorities.join("/")} → ${w.type ?? "falhou"} · ${w.priority ?? "—"}${w.error ? ` (erro: ${w.error})` : ""}`);
  console.log(m.passes ? "PASSA\n" : "NÃO PASSA\n");
}

async function main() {
  if (compare) {
    const today = await evalComplaintTriage({ thinkingLevel: "env", limit });
    const minimal = await evalComplaintTriage({ thinkingLevel: "minimal", limit });
    if (!today.metrics.total || today.metrics.failed === today.metrics.total) {
      console.error("A IA não leu nenhum caso (não configurada, desligada ou sem orçamento?).");
      process.exit(2);
    }
    const v = thinkingLevelVerdict(today.metrics, minimal.metrics);
    if (json) console.log(JSON.stringify({ today, minimal, verdict: v }, null, 2));
    else {
      print("Raciocínio de hoje (env)", today);
      print("Raciocínio minimal", minimal);
      console.log(v.ok
        ? `O "minimal" pode ligar-se na triagem das reclamações (${v.why}). Em Definições → Parâmetros → IA, ai.thinkingLevels: ${JSON.stringify(suggestedThinkingSetting(["complaint_triage"]))} (junta às linhas que já lá estejam).`
        : `O "minimal" NÃO deve ligar-se na triagem das reclamações: ${v.why}.`);
    }
    process.exit(v.ok ? 0 : 1);
  }
  const r = await evalComplaintTriage({ ...(thinkingArg ? { thinkingLevel: thinkingArg as any } : {}), limit });
  if (json) console.log(JSON.stringify(r, null, 2));
  else print(thinkingArg ? `Raciocínio ${thinkingArg}` : "Como a produção", r);
  if (!r.metrics.total || r.metrics.failed === r.metrics.total) {
    console.error("A IA não leu nenhum caso (não configurada, desligada ou sem orçamento?). Configura o fornecedor no ambiente — nunca coloques chaves no código.");
    process.exit(2);
  }
  process.exit(r.metrics.passes ? 0 : 1);
}

main().catch((err) => {
  console.error("Falhou:", String(err?.message ?? err));
  process.exit(2);
});
