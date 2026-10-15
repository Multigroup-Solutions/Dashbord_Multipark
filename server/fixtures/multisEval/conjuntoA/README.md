# Conjunto A — perguntas reais (por entregar)

**Vazio de propósito.** O conjunto A é escrito pelo **Jorge e por 2 TL** (perguntas reais do dia a dia, **sem olhar para as secções da ajuda**) e entregue até **quarta, 21 out 2026**. Só ele conta para os critérios do go/no-go (plano MPV §8.2) — por isso aqui não se inventam perguntas.

Até lá:

1. `pnpm tsx scripts/export-multis-eval-draft.ts` exporta as perguntas do **/multis/falhas** e do **👎**, anonimizadas, para `../rascunhoA/` (fora do git).
2. O Jorge revê o rascunho, escolhe as que servem, preenche `seccaoEsperada`, `ferramentaEsperada`, `factosObrigatorios`, `factosProibidos` e as `gravacoes`, e grava-as aqui como `*.json` (formato no `../README.md`).
3. Junta as perguntas dos TL (no mesmo formato) — meta: **≥ 60 perguntas**.

Quando houver perguntas: `pnpm tsx scripts/eval-multis.ts --set A --variant mpv-argon --reps 3`.
