# Perguntas de teste do Multis (eval — plano MPV §8.2)

O eval corre perguntas no Multis **pelo mesmo caminho de produção** (sistema, contexto da página, ajuda, perfis, ferramentas, voltas e prazos da versão) e dá uma nota a cada resposta. Serve para o go/no-go do Multis por página.

```
pnpm tsx scripts/eval-multis.ts --set A --variant mpv-argon --reps 3
pnpm tsx scripts/eval-multis.ts --set A --variant mpv-lite --reps 3
pnpm tsx scripts/eval-multis.ts --set A --variant v1-lite --reps 3
pnpm tsx scripts/eval-multis.ts --set B --variant mpv-lite      (o Argon só corre no A)
pnpm tsx scripts/eval-multis.ts --set B --dump                  (escreve as perguntas do B, sem IA)
```

O relatório sai em `eval-multis/` (Markdown e JSON; a pasta não vai para o git).

## Pastas

| Pasta | O quê |
|---|---|
| `conjuntoA/` | **Conjunto A**: perguntas reais, escritas pelo Jorge e por 2 TL **sem olhar para as secções**. É o único que conta para os critérios. Ficheiros `*.json`. |
| `conjuntoB/` (opcional) | Perguntas extra para o B. O B é **gerado** das secções da árvore (`server/assistant/multisEvalSetB.ts`), com os casos de injeção. |
| `gravacoes/` | Respostas gravadas das ferramentas, partilhadas por várias perguntas (`*.json`). |
| `rascunhoA/` | Rascunhos exportados do `/multis/falhas` e do 👎 (`scripts/export-multis-eval-draft.ts`), anonimizados por regras simples — **TÊM de ser revistos à mão**. **Fora do git** e **nunca** lidos pelo eval. |

## Formato de uma pergunta

Cada ficheiro é uma lista de perguntas (ou `{ "perguntas": [...] }`).

```json
{
  "id": "A-001",
  "pergunta": "Porque é que no Porto a Pressão usa o p60?",
  "pagina": "/extras-dia",
  "separador": "pressao",
  "papel": "team_leader",
  "cidades": ["Porto"],
  "seccaoEsperada": "extras-dia.md#separador-pressao-quando-e-que-aperta",
  "ferramentaEsperada": "pressao_explicar",
  "factosObrigatorios": ["p\\s?60", "Porto"],
  "factosProibidos": ["p\\s?75 no Porto"],
  "gravacoes": [
    { "ferramenta": "pressao_explicar", "args": [{ "cidade": "Porto" }, { "cidade": "Porto", "dia": "terça" }], "resposta": { "cidade": "Porto", "percentil": 60 } }
  ],
  "nota": "Pergunta do TL do Porto."
}
```

- **pagina / separador / registo**: onde a pessoa está (o caminho, o separador do código, ex.: `pressao`, e o registo aberto `{ "type": "booking", "id": 123 }`).
- **papel**: `extra`, `team_leader`, `supervisor`, `admin` (ou `super_admin` para as páginas só dele). **cidades**: omisso = Lisboa (até supervisor) ou todas (admin).
- **seccaoEsperada**: o id da secção da ajuda (`ficheiro.md#secção`, como no índice; `--set B --dump` mostra ids) ou `null`. No v1 basta o ficheiro certo; no MPV, a secção (ou uma que a contenha).
- **ferramentaEsperada**: a ferramenta que tem de ser chamada, ou `null`. Se a ferramenta não existir na versão (ex.: só do MPV), a pergunta "não se aplica" a essa versão.
- **factosObrigatorios / factosProibidos**: expressões regulares sem barras (maiúsculas e acentos não contam; escreve `\\b` para fronteira de palavra).
- **gravacoes**: o que a ferramenta devolve (antes de tapar os dados pessoais: o eval tapa como a produção). `args` pode ser uma lista de alternativas que dão a mesma resposta; `papel` restringe a gravação a um papel. Os argumentos comparam-se sem maiúsculas, acentos, espaços a mais nem vazios ("15" = 15).
- **versoes** (`["v1"]`, `["mpv"]`): só nessas versões. **hoje**: a data do contexto (omissão 2026-10-21). **injecao**: caso de injeção.

## Regras

- **3 repetições** por pergunta (temperatura 0,2, a do chat). Uma pergunta **passa** com **≥ 2 de 3**. O relatório mostra a taxa média por repetição e as **instáveis** (1 ou 2 de 3).
- Passa uma repetição: respondeu, factos obrigatórios todos, nenhum proibido, secção certa, ferramenta esperada chamada, sem regra inventada (juiz), sem texto de recurso e **sem erro do eval**.
- **Erro do eval**: uma ferramenta de dados chamada com argumentos que não estão gravados. A repetição pára ali e a **pergunta falha** (mesmo que as outras repetições passem); a chamada fica em "Chamadas por gravar" no relatório — nunca um resultado vazio. Grava-a e corre outra vez.
- As ferramentas da **ajuda** (`ajuda_abrir`, `ajuda_procurar`, `abrir_ajuda`) e as **regras em vigor** (com os valores por omissão do código) correm de verdade: são geradas do repositório. Uma gravação na pergunta passa-lhes à frente.
- Sem base de conhecimento nem BD: o eval tira o `DATABASE_URL` antes de começar (nada se escreve; as definições ficam as do código).
- **Sem vetores (F5)**: o eval passa `embedQuery: null`, por isso a ajuda do MPV chega pela pesquisa **lexical** da árvore (a de corte da F5). Mede a árvore, os perfis e as ferramentas — não a pesquisa por vetores (reprodutível e sem embed fora do teto).
- **Juiz IA** (lite, prompt fixo) só para "inventou uma regra?". **20 %** das respostas julgadas (sempre as mesmas) e todas as "inventou" ficam marcadas para o Jorge rever. No v1 o juiz vê a ajuda **inteira** dos ficheiros usados; no MPV, o bloco de secções que o modelo recebeu e o que as ferramentas devolveram.
- Sem juiz (`--no-judge`) ou com respostas por julgar, o critério "0 regras inventadas" fica **por avaliar** e o veredicto nunca é "Cumpre" (o script sai com 2).
- **Teto: 15 €** por corrida, com o juiz (funcionalidade `assistant_eval`, fora do orçamento das outras). Atingido a meio → o eval **pára** e fica **INCOMPLETO** (nenhum número serve para decidir).
- **Critérios (só no conjunto A)**: MPV-Argon ≥ 90 % de factos certos e secção certa, **0** regras inventadas, p95 < 25 s; MPV-lite ≥ 80 %; custo médio por pergunta (para o D2).
