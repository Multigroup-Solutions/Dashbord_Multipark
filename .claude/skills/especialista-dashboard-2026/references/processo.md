# Processo — passo a passo com auditor até ≥ 90

## Índice
1. Porquê este processo
2. Papéis (coordenador, implementador, auditor)
3. Fluxo completo
4. Modelo do briefing do implementador
5. Modelo do briefing do auditor
6. Rondas seguintes
7. Merge com portões e seguimentos
8. Git, worktrees e Windows (armadilhas reais)
9. Planos
10. Entregáveis sem código
11. Relatório final ao Jorge

---

## 1. Porquê
O Jorge quer qualidade de "nível bancário" (o lançamento é para toda a gente e "não pode ter falhas") mas não quer ficar bloqueado a aprovar cada PR. Por isso: um auditor independente e adversarial dá a nota; ≥ 90 sem Altos entra sozinho; abaixo volta para trás. Ele só vê o resultado final e as decisões que são dele.

## 2. Papéis
- **Coordenador (tu)**: percebe o pedido, escreve os briefings, encaminha entre implementador e auditor, **verifica** o que eles dizem (um relatório de agente é uma afirmação, não uma prova — confirma o hash, o diff, os testes), faz o merge e fala com o Jorge.
- **Implementador**: agente `multipark-dashboard-specialist` com `isolation: "worktree"`, em segundo plano. Um por fase. Quando o auditor responde, mandas as correções ao MESMO implementador (SendMessage para o id dele) — ele tem o contexto.
- **Auditor**: agente `multipark-dashboard-specialist` NOVO, sem `isolation` (cria um worktree temporário só para correr testes), que **não edita nada**. Um por fase; nas rondas seguintes reutiliza-se o mesmo (SendMessage), para comparar com o que já viu.
- Ambos são subagentes: não abrem PR, não fazem merge, não lançam outros agentes (o SKILL.md diz-lhes isso no topo).

Fases independentes podem correr em paralelo (cada uma no seu worktree/ramo). Fases que mexem nos mesmos ficheiros: em série, ou empilhadas (a 2.ª parte do ramo da 1.ª e só entra depois dela; quando a 1.ª entrar por squash, a 2.ª faz merge de `origin/main`, não do ramo antigo — e confirma que não desfez correções do main).

## 3. Fluxo completo
1. Ler o pedido e o código. Fotos → identificar ecrã, separador e elementos.
2. Decidir: tarefa pequena (uma fase) ou grande (plano → fases, §9).
3. Briefing do implementador (§4) → agente em worktree, em segundo plano.
4. Quando ele acabar: confirmar o hash no remoto (`git fetch; git log -1 origin/<ramo>`).
5. Briefing do auditor (§5) → agente novo, em segundo plano.
6. Nota < 90 ou algum Alto aberto → mandar ao implementador os achados (Altos e Médios obrigatórios; Baixos quase sempre). ≥ 90 e zero Altos → §7.
7. Ronda seguinte (§6). Se ao fim da 5.ª ronda não houver ≥ 90 — ou houver um achado que o implementador contesta com prova e o auditor mantém —, pára e leva ao Jorge os pontos em disputa.
8. Merge (§7). Seguimento das notas baixas se valer a pena.
9. Relatório ao Jorge (§11).

Enquanto os agentes trabalham, dá ao Jorge notas curtas de estado; não esperes em silêncio.

## 4. Modelo — briefing do implementador
```
Implementa <fase/tarefa> (<plano ou pedido do Jorge, com citação curta>). Lê <ficheiros/plano> primeiro.
Cria o branch `<ramo>` a partir de origin/main <hash>. PT-PT; segue o estilo do código à volta.
Se o worktree não tiver node_modules: em PowerShell
  cmd /c mklink /J "<wt>\node_modules" "C:\Users\jorge\Dashbord_Multipark\Dashbord_Multipark\node_modules"
No fim, depois do push: tira a junção (`cmd /c rmdir "<wt>\node_modules"`) se o coordenador não precisar do worktree — a limpeza automática do worktree com a junção lá dentro apagaria o node_modules principal.

Âmbito
1. <o quê, com ficheiros e linhas que já conheces>
2. ...
Testes: <casos concretos, incluindo os de abuso/limite>

Regras
- Nada de IA/APIs/envios reais nos testes; BD da Multipark só de leitura.
- NÃO corras scripts/eval-*.ts, export-multis-eval-draft.ts, multipark-db-* nem nada que envie ou leia produção.
- Coisas novas que avisam/publicam/escrevem: atrás de interruptor DESLIGADO.
- O que já existe não muda de comportamento (prova-o num teste quando for sensível).
- Ajuda: docs/ajuda/<ficheiro>.md segundo as regras da árvore (regras.md §8); `pnpm tsx scripts/gen-ajuda.ts`.
- Migração: número livre a seguir ao último no origin/main E nos ramos abertos (comando em processo.md §8).
- `pnpm check` + `npx vitest run` + `pnpm build:api` (+ import, + `git checkout -- api/index.js`);
  commit em LF com "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; adiciona ficheiros por caminho (nunca `git add -A`);
  push do ramo; NÃO abras PR nem faças merge.
- Responde com o resumo, o hash, os ficheiros e o que fica para o Jorge decidir.
```

## 5. Modelo — briefing do auditor
```
És o AUDITOR ADVERSARIAL ("nível bancário") de <fase> (<referência ao plano/pedido>). Não editas nada: só lês, corres e reportas. PT-PT.

Alvo: branch `<ramo>` @ <hash> contra origin/main <hash> (`git diff origin/main...origin/<ramo>`). Se a base for antiga, confirma com `git merge-tree --write-tree origin/main origin/<ramo>` se entra limpo e diz que conflitos esperas.

Resumo do implementador (verifica tudo — não acredites): <resumo>

Ataca:
1. Verdade: cada texto/regra/ajuda bate com o que o código FAZ (não só com o valor da constante).
2. Fugas: permissões (requireAccess, PATH_MODULE, assertScopedOperation), cidades (projectScope, missingCostCenter), totais financeiros, PII, papéis (extra, TL de outra cidade, supervisor, admin).
3. O que já existia não muda (v1 igual; hashes; comportamento por omissão).
4. Dados: nada se apaga; reversível; concorrência (duas instâncias, cron + botão); idempotência; migração idempotente e espelhada no drizzle.
5. Envios/publicações/avisos: duplicados, falhas silenciosas, interruptor desligado.
6. Prazos (Vercel 60 s), custos de IA, memória.
7. <pontos específicos desta fase>

Verificações (PowerShell):
  $wt = "<scratchpad>\wt-<fase>"; git worktree add --detach $wt origin/<ramo>
  cmd /c mklink /J "$wt\node_modules" "C:\Users\jorge\Dashbord_Multipark\Dashbord_Multipark\node_modules"
  Push-Location $wt
  npx tsc --noEmit ; npx vitest run ; pnpm build:api ; node -e "import('./api/index.js')" ; git checkout -- api/index.js
  pnpm tsx scripts/gen-ajuda.ts ; if (git status --porcelain) { throw 'gen-ajuda deixou diferenças' }
  Pop-Location
  NUNCA corras evals reais, envios ou leituras de produção.
  No fim: cmd /c rmdir "$wt\node_modules" ; if (Test-Path "$wt\node_modules") { throw 'junção ainda lá' } ; git worktree remove --force $wt

Resposta: achados com severidade (Alto/Médio/Baixo), ficheiro:linha e cenário concreto; o que está bem; última linha `PONTUAÇÃO: N/100` (merge só a partir de 90 e sem Altos).
```

Severidades: **Alto** = perda/fuga de dados, envio/publicação errada, regressão para toda a gente; **Médio** = número ou texto falso que as pessoas vão ver, falha silenciosa, permissão mal calibrada; **Baixo** = robustez, desempenho, texto vago, teste em falta.

## 6. Rondas seguintes
Ao auditor (SendMessage): o hash novo, o que o implementador diz que corrigiu e onde queres atenção especial (sobretudo onde mexeu fora do previsto ou em código partilhado). Se o implementador discordar de um achado com prova do código, pede ao auditor que confirme — ele às vezes erra e corrige-se.

Se um merge do main estragar trabalho já feito (conflito resolvido "ficando com a nossa versão" que desfaz correções do main), **pára o auditor**, confirma com `git diff origin/main origin/<ramo> -- <ficheiros>` e manda repor antes de continuar.

## 7. Merge com portões e seguimentos
```powershell
git fetch origin -q
git merge-base --is-ancestor origin/main origin/<ramo>; "main no ramo: $LASTEXITCODE"   # 0 = contém
git merge-tree --write-tree origin/main origin/<ramo>                                   # conflitos?
```
1. Se o main avançou e há conflitos: merge de `origin/main` no worktree do ramo; gerados (`helpDocs.generated.ts`, `knowledgeTree.generated.ts`, `rulesDocs.generated.ts`, `knowledgeTreeIds.json`) → aceita um lado e corre `pnpm tsx scripts/gen-ajuda.ts`; tsc + vitest; push. **Se o merge mexeu em ficheiros do ramo além dos gerados, a ronda volta ao auditor.**
2. PR com o corpo num ficheiro (PT-PT: O que muda / Auditoria com a nota / Validação; termina com `🤖 Generated with [Claude Code](https://claude.com/claude-code)`):
```powershell
gh pr create --base main --head <ramo> --title "<Fase>: <o que muda, em linguagem do Jorge>" --body-file <scratchpad>\pr.md
gh pr checks <n> --watch --fail-fast          # CI + preview da Vercel verdes (se disser "no checks reported", espera uns segundos e repete)
gh pr merge <n> --squash --delete-branch --match-head-commit <hash auditado (ou o do merge do main já verificado)>
```
3. Depois do merge: Vercel MCP `list_deployments` / `get_deployment` até `READY`, e `get_runtime_errors` nos 10 min seguintes. Se o deploy falhar ou houver erros novos: `request_rollback` e avisar o Jorge. Atenção: depois de um rollback a Vercel desliga a atribuição automática do domínio — os merges seguintes só chegam a produção quando alguém fizer promote do deploy novo (diz-lho).
4. **Hora do deploy**: se a mudança mexe em horários de trabalhos que avisam/enviam (ex.: Extras Dia), confirma antes nas Definições de produção (`settings.values.list`: `isSet`/`value`) se há valores gravados e se o envio automático está ligado, e escolhe a hora do merge em conformidade.
5. Notas baixas que sobram e valem a pena → ramo `<ramo>-seguimento` a partir do main, mesmo processo (ronda curta no mesmo auditor).
6. Limpeza: ramo remoto apagado pelo `--delete-branch` (se falhar a parte local por o ramo estar num worktree: `git push origin --delete <ramo>`); worktrees das tuas fases removidos (com a junção tirada antes, §8). Nunca mexas em worktrees/ramos de outras sessões (`git worktree list` mostra várias).

## 8. Git, worktrees e Windows (armadilhas reais)
- **Shell**: comandos com `cmd /c` correm em **PowerShell**. No Git Bash o `/c` é convertido e o comando não faz nada sem dar erro — lá usa `cmd //c …`.
- **node_modules em junção**: criar com `cmd /c mklink /J "<wt>\node_modules" "<raiz>\node_modules"`; antes de remover um worktree, tirar SEMPRE a junção (`cmd /c rmdir "<wt>\node_modules"` e confirmar com `Test-Path`) — senão a remoção apaga o node_modules principal. Se acontecer: `pnpm install --frozen-lockfile --force`.
- **Ramo preso a um worktree**: `git checkout -B <ramo>` falha ("already used by worktree"). Usa outro nome local e empurra com refspec: `git checkout -B x-merge origin/<ramo>` … `git push origin x-merge:<ramo>`.
- **`git add`**: no checkout principal nunca `git add -A`/`.` — há worktrees, `.codex/` e ficheiros soltos de outras sessões (`.claude/worktrees/` está no `.gitignore` desde a entrada desta skill). Adiciona por caminho.
- **Nunca** `push --force` para o `main`, nunca `--no-verify`, nunca reescrever histórico de um ramo que outra fase usa como base.
- **CRLF**: edições por scripts no Windows metem CRLF; os commits vão em LF. PowerShell: `[IO.File]::WriteAllText(p, s, (New-Object Text.UTF8Encoding $false))`; Python: `open(..., newline='')`. Cuidado com crases dentro de strings em PowerShell (são escape).
- **Heredocs com crases** partem no Bash; para substituições grandes usa um script Python no scratchpad com `assert s.count(a) == 1`.
- **Migrações — número livre** no main e nos ramos abertos:
  `git for-each-ref --format='%(refname:short)' refs/remotes/origin | % { git ls-tree --name-only $_ server/migrations/ } | sort -u | select -Last 5`
- **Testes que falham por tempo** com a máquina carregada (`globalSearch.test`, `migrations/index.test`): repete sozinho; se passar, é carga — diz-o no relatório.
- **Testes correm em UTC** (`vitest.config.ts` fixa `TZ=UTC`, como a produção); código que lê datas da BD em texto tem de usar UTC explícito (`parseDbDate` em `server/payroll/shifts.ts`), senão dá +1 h fora de UTC (#372, #375).
- **`api/index.js`** é gerado pelo build: repõe com `git checkout -- api/index.js` depois de `pnpm build:api`.
- **PR em rascunho** não faz merge: `gh pr ready <n>` primeiro.
- `git stash` é partilhado entre worktrees — evita; usa commits WIP.
- `.codex/agents/multipark-dashboard-specialist.toml` é do Codex e pode estar desatualizado; manda o agente em `.claude/agents/` e esta skill.

## 9. Planos
- `docs/plans/AAAA-MM-DD-<tema>.md`: objetivo, princípios, arquitetura, fases com datas, decisões do Jorge (D1…), o que é reversível (tabela), critérios de lançamento, o que cai se houver atraso.
- O plano vai ao auditor como o código (verdade contra o código, riscos, custos, ordem das fases). **≥ 95** para avançar. O plano aprovado entra no main por PR.
- Depois de aprovado, as fases correm sem perguntar; calendário e decisões ficam no plano.

## 10. Entregáveis sem código
Apanhados, estudo de um PR, estado de produção, respostas com números ou regras: escreve o rascunho e manda-o a um auditor novo ("confirma cada afirmação contra o código / logs / ecrã, lista o que é falso ou falta, `PONTUAÇÃO: N/100`"). ≥ 90 antes de responder. Exceção: "só traz a informação" / "não precisas do auditor".

## 11. Relatório final ao Jorge
```
A <fase> já está no main ([PR #N](link)), com <nota>/100.
O que muda: <bullets curtos, em linguagem dele>.
O que tens de fazer: <passos numerados: ecrã → botão / variável na Vercel>.
Decisões que ficam contigo: <Dx: pergunta (prazo)>.
O que não foi testado: <ex.: dados reais>.
Em curso: <o que está com implementador/auditor>.
```
Nunca afirmes que algo está feito sem ter verificado o hash/testes/deploy.
