# Conjunto A — perguntas reais (por entregar)

**Vazio de propósito.** O conjunto A é escrito pelo **Jorge e por 2 TL** (perguntas reais do dia a dia, **sem olhar para as secções da ajuda**) e entregue até **quarta, 21 out 2026**. Só ele conta para os critérios do go/no-go (plano MPV §8.2) — por isso aqui não se inventam perguntas.

Até lá:

1. `pnpm tsx scripts/export-multis-eval-draft.ts` exporta as perguntas do **/multis/falhas** e do **👎** para `../rascunhoA/` (fora do git; o `--out` só aceita essa pasta). O rascunho é **anonimizado por regras simples** (contactos, matrículas, NIF/IBAN, nomes da equipa, uma lista de nomes e apelidos portugueses comuns, o nome a seguir a Sr./Sra./D./Dr./Dra./Eng., palavras com maiúscula que parecem nomes, ids das páginas) e **TEM de ser revisto à mão** — as regras podem deixar passar um nome raro ou um código.
2. O Jorge revê o rascunho, escolhe as que servem, preenche `seccaoEsperada`, `ferramentaEsperada`, `factosObrigatorios`, `factosProibidos` e as `gravacoes`, e grava-as aqui como `*.json` (formato no `../README.md`).
3. Junta as perguntas dos TL (no mesmo formato) — meta: **≥ 60 perguntas**.

Quando houver perguntas: `pnpm tsx scripts/eval-multis.ts --set A --variant mpv-argon --reps 3`.
