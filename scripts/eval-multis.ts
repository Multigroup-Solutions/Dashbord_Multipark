// Eval do Multis (plano MPV §8.2, F8): corre um conjunto de perguntas numa
// versão do Multis e escreve o relatório em Markdown e JSON.
//
//   pnpm tsx scripts/eval-multis.ts --set A --variant mpv-argon --reps 3
//   pnpm tsx scripts/eval-multis.ts --set B --variant mpv-lite
//   pnpm tsx scripts/eval-multis.ts --set B --dump            (só escreve as perguntas do B, sem IA)
//
// Opções: --set A|B · --variant v1-lite|mpv-lite|mpv-argon (o Argon só no A) ·
// --reps 3 · --budget 15 (€, com o juiz) · --concurrency 2 · --limit N ·
// --only ID,ID · --no-judge · --out DIR (omissão: eval-multis/ na raiz).
//
// Usa a IA configurada no ambiente (GEMINI_API_KEY ou o Vertex; para o
// Argon, AI_MODEL_SMART=gemini-4-argon) — nunca ponhas chaves no código.
// NÃO usa a base de dados: o DATABASE_URL é retirado antes de tudo (nada se
// escreve, as definições ficam as do código, a resposta não depende da BD).
//
// Sai com 0 se o eval acabou e cumpre os critérios (ou não há critérios), 1
// se acabou e NÃO cumpre, 2 se ficou incompleto, com critérios por avaliar
// (ex.: --no-judge), se a IA não respondeu ou se os ficheiros têm erros.
delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_MULTIPARK;

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};

async function main() {
  const [{ isEvalSet, isEvalVariant, EVAL_BUDGET_EUR, EVAL_VARIANT_DEFS, evalReportMarkdown, eurText }, { loadEvalInputs, runMultisEval }, fs, path] = await Promise.all([
    import("../shared/multisEval"), import("../server/assistant/multisEval"), import("node:fs"), import("node:path"),
  ]);
  const set = opt("--set");
  if (!isEvalSet(set)) { console.error("--set tem de ser A ou B."); process.exit(2); }
  const outDir = path.resolve(opt("--out") ?? "eval-multis");
  const inputs = await loadEvalInputs(set);
  if (inputs.errors.length) {
    console.error("Erros nos ficheiros das perguntas (corrige antes de correr):");
    for (const e of inputs.errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  if (args.includes("--dump")) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `conjunto-${set}-perguntas.json`);
    fs.writeFileSync(file, JSON.stringify(inputs.questions, null, 2) + "\n");
    console.log(`${inputs.questions.length} perguntas do conjunto ${set} em ${file}`);
    process.exit(0);
  }
  const variant = opt("--variant");
  if (!isEvalVariant(variant)) { console.error("--variant tem de ser v1-lite, mpv-lite ou mpv-argon."); process.exit(2); }
  if (!EVAL_VARIANT_DEFS[variant].sets.includes(set)) { console.error(`A versão ${variant} só corre no conjunto ${EVAL_VARIANT_DEFS[variant].sets.join("/")}.`); process.exit(2); }
  if (!inputs.questions.length) {
    console.error(`O conjunto ${set} está vazio${set === "A" ? " (o Jorge e 2 TL entregam-no; ver server/fixtures/multisEval/conjuntoA/README.md)" : ""}.`);
    process.exit(2);
  }
  const reps = Number(opt("--reps") ?? 3);
  const budgetEur = Number(opt("--budget") ?? EVAL_BUDGET_EUR);
  if (!(budgetEur > 0) || budgetEur > EVAL_BUDGET_EUR) { console.error(`--budget entre 0 e ${EVAL_BUDGET_EUR} €.`); process.exit(2); }
  const only = opt("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const limit = Number(opt("--limit")) || undefined;
  const count = only?.length ? inputs.questions.filter((q) => only.includes(q.id)).length : Math.min(inputs.questions.length, limit ?? Infinity);
  console.log(`Eval do Multis: conjunto ${set}, ${variant}, ${count} perguntas × ${reps} · teto ${eurText(budgetEur)}`);
  const report = await runMultisEval({
    set, variant, reps, budgetEur,
    concurrency: Number(opt("--concurrency") ?? 2) || 2,
    limit,
    only,
    judge: !args.includes("--no-judge"),
    onProgress: (line) => console.log(`  ${line}`),
  }, inputs);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[: ]/g, "-");
  const base = path.join(outDir, `eval-${set}-${variant}-${stamp}`);
  fs.writeFileSync(`${base}.md`, evalReportMarkdown(report));
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
  const s = report.summary;
  console.log("");
  console.log(`${report.complete ? "COMPLETO" : `INCOMPLETO (${report.incompleteReason})`} · passam ${s.passed}/${s.questions} · factos+secção ${s.factsSectionPassed}/${s.questions} · p95 ${s.p95Ms == null ? "—" : `${Math.round(s.p95Ms / 100) / 10} s`} · gasto ${eurText(report.spentEur)}`);
  for (const w of report.warnings) console.log(`Aviso: ${w}`);
  if (report.criteria.applies && report.criteria.ok != null) console.log(report.criteria.ok ? "Cumpre os critérios." : "NÃO cumpre os critérios.");
  else if (report.criteria.pending) console.log("Por avaliar: há critérios que não se avaliaram (ex.: sem juiz) — não conta como «Cumpre».");
  else if (report.criteria.why) console.log(report.criteria.why);
  console.log(`Relatório: ${base}.md e ${base}.json`);
  if (!report.complete || !s.questions || s.costPerAnswerEur == null) process.exit(2);
  if (report.criteria.ok === false) process.exit(1);
  process.exit(report.criteria.pending ? 2 : 0);
}

main().catch((err) => {
  console.error("Falhou:", String(err?.message ?? err));
  process.exit(2);
});
