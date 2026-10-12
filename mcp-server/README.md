# Multipark Dashboard — MCP Server

Servidor MCP (stdio) que permite ao Claude **controlar a Dashboard Multipark
completamente** — todos os parques e cidades (Lisboa, Faro, Porto) — através da
API REST `/api/v1` da dashboard.

## Como funciona

```
Claude (Desktop/Code)  ──stdio──►  este MCP server  ──HTTPS──►  /api/v1 (Vercel)  ──►  BD + BD Multipark (leitura)
```

A autenticação é por **API key** (header `X-API-Key`). Cada chave tem
**capacidades** que limitam o que pode fazer (ecrã **API Keys** da dashboard):

| Capacidade | Pode |
|---|---|
| Relatórios de operação (`reports:ops`) | Parques, projetos, viaturas, condutores, estatísticas de reservas e de reclamações, resumo |
| Caixa e parceiros (`reports:cash`) | Contagens e correções de caixa, passagens de turno, faturação e fecho de parceiros |
| Marketing (`reports:marketing`) | Campanhas, gasto em anúncios, ROAS, Google Analytics, Search Console |
| Dados pessoais (`pii`) | Reservas com os dados do cliente, reclamações, críticas, colaboradores |
| Reclamações e críticas — escrever (`complaints:write`) | Criar/atualizar reclamações, mensagens e críticas |
| Formulários do site (`site:intake`) | Candidaturas e disponibilidades que chegam do site |
| Administração (`admin`) | Tudo, mais arquivar reclamações, criar projetos e `/admin/*` — **não uses num MCP** |
| MCP pessoal — ler (`owner:read`) | Qualquer **leitura** dos ecrãs (RH, CRM, despesas, WhatsApp, formação, reservas…), **como quem criou a chave** — vê o mesmo que essa pessoa vê na app. Não vem com `admin`: marca-se à parte |
| MCP pessoal — alterar (`owner:write`) | As alterações da lista fechada (faltas, avaliação, juntar/separar, tarefas, críticas, reclamações, perdidos, ocorrências), como quem criou a chave. Não vem com `admin` |

Chaves antigas (`read` / `write` / `admin`) continuam a fazer o que faziam; no
ecrã podes reduzi-las ao que precisam.

## 1. Criar a API key

No ecrã **API Keys** da dashboard (só super admin): **Nova API Key**, dá-lhe um
nome, marca só as capacidades de que o MCP precisa (para relatórios:
Relatórios de operação, Caixa e parceiros, Marketing) e copia a chave — só
aparece uma vez. Não se criam chaves diretamente na base de dados (lá só fica
o hash).

## 2. Pôr o ficheiro na tua máquina

Este servidor **não tem dependências** — só precisa do **Node.js 18+**. Não há
`npm install`. Basta teres o repositório clonado:

```bash
git clone https://github.com/Multigroup-Solutions/Dashbord_Multipark.git
# o servidor é o ficheiro: Dashbord_Multipark/mcp-server/index.mjs
```

Confirma o Node: `node --version` (tem de ser ≥ 18). Anota o **caminho absoluto**
para o `index.mjs` — vais precisar dele a seguir (ex.: no Mac
`/Users/tu/Dashbord_Multipark/mcp-server/index.mjs`, no Windows
`C:\\Users\\tu\\Dashbord_Multipark\\mcp-server\\index.mjs`).

## 3. Registar no Claude

### Claude Code (CLI) — uma linha

```bash
claude mcp add multipark-dashboard \
  --env MULTIPARK_API_URL=https://dashbord-multipark.vercel.app/api/v1 \
  --env MULTIPARK_API_KEY=a-tua-api-key \
  -- node /caminho/absoluto/para/mcp-server/index.mjs
```

Confirma com `claude mcp list` e abre uma sessão — as 36 tools aparecem.

### Claude Desktop — `claude_desktop_config.json`

Abre o ficheiro de config (Settings → Developer → Edit Config, ou):
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

E acrescenta:

```json
{
  "mcpServers": {
    "multipark-dashboard": {
      "command": "node",
      "args": ["/caminho/absoluto/para/Dashbord_Multipark/mcp-server/index.mjs"],
      "env": {
        "MULTIPARK_API_URL": "https://dashbord-multipark.vercel.app/api/v1",
        "MULTIPARK_API_KEY": "a-tua-api-key"
      }
    }
  }
}
```

> No Windows, escapa as barras no caminho (`\\`) como no exemplo acima.

Reinicia o Claude Desktop e as tools aparecem (ícone de ferramentas no chat).

## Tools disponíveis

| Tool | Capacidade | Descrição |
|---|---|---|
| `list_parks` | reports:ops | Todos os parques/cidades |
| `dashboard_summary` | reports:ops | Visão cruzada (reservas + reclamações + por cidade) |
| `list_bookings` | pii | Reservas com filtros (city, parkId, status, datas, search) |
| `booking_stats` | reports:ops | Estatísticas de reservas |
| `get_booking` | pii | Detalhe de reserva (ao vivo da BD Multipark) |
| `list_complaints` | pii | Reclamações |
| `complaint_stats` | reports:ops | Stats de reclamações |
| `get_complaint` | pii | Detalhe (mensagens + fotos) |
| `create_complaint` | complaints:write | Criar reclamação |
| `update_complaint` | complaints:write | Atualizar reclamação |
| `add_complaint_message` | complaints:write | Adicionar mensagem/nota |
| `delete_complaint` | **admin** | Arquivar reclamação (não apaga) |
| `list_reviews` | pii | Avaliações Google |
| `create_review` | complaints:write | Registar avaliação |
| `list_vehicles` | reports:ops | Viaturas |
| `list_employees` | pii | Colaboradores |
| `list_campaigns` | reports:marketing | Campanhas (internas, ad antigas e Google Ads/Meta) |
| `get_campaign_daily` | reports:marketing | Histórico diário de uma campanha Google Ads/Meta |

## MCP pessoal — o que os ecrãs leem e fazem

Com as capacidades **MCP pessoal**, quatro tools usam os próprios
procedimentos do Dashboard (tRPC), sem uma rota por cada dado. O que entrar de
novo no Dashboard aparece sozinho, sem mexer na API nem no MCP.

| Tool | Capacidade | Rota | O que faz |
|---|---|---|---|
| `dashboard_procedures` | owner:read | `GET /procedures?search=&withInput=1` | Lista as leituras (~450; ex.: `search=rh`), com o input de cada uma em JSON Schema |
| `dashboard_query` | owner:read | `POST /procedures/call {path, input}` | Corre a leitura |
| `dashboard_actions` | owner:write | `GET /procedures/actions?search=&withInput=1` | Lista as alterações abertas ao MCP, por área |
| `dashboard_action` | owner:write | `POST /procedures/action {path, input, confirmExternal?}` | Faz a alteração |

- Corre **como a pessoa que criou a chave** (ou a conta que ficou, se foram
  juntas): as mesmas permissões e o mesmo alcance de cidade da app. As
  alterações ficam nos Logs em nome dessa pessoa, e cada uma também como
  `mcp_action` da chave (para se ver tudo o que o MCP fez).
- **Alterações: só uma lista fechada** (`MCP_ACTIONS` em
  `server/mcpProceduresApi.ts`, 61 hoje): faltas e ponto, pontos da avaliação,
  juntar/separar utilizadores, colaboradores e clientes, tarefas, críticas,
  reclamações, perdidos e achados, ocorrências. Nada de apagar, ficheiros ou
  salários. Para abrir outra, acrescenta-se o caminho à lista.
- O que **sai para fora** (publicar resposta no Google, email ao cliente) só
  passa com `confirmExternal: true`.
- `apiKeys.*` e tudo o que tenha "token" no caminho ficam sempre de fora.
- Datas no input podem ir em texto (`2026-10-01`); se o procedimento pedir
  `Date`, o servidor converte e tenta outra vez.
- Resultado acima de 4 MB → `413` (usa filtros/paginação). O MCP corta o texto
  a 200 000 caracteres.
- Código: `server/mcpProceduresApi.ts` (testes em `server/mcpProceduresApi.test.ts`).

## Notas de segurança

- A API key dá acesso programático à operação. **Guarda-a como um segredo**
  (não a metas em repositórios). Se for comprometida, **revoga-a** no ecrã
  API Keys — deixa de funcionar logo.
- Dá a cada chave só as capacidades de que precisa. Sem a capacidade, a rota
  responde `403`. Limite: 240 pedidos por minuto por chave (`429`).
- O que uma chave escreve fica nos Logs com a etiqueta da chave (nome e
  prefixo), como "Sistema" — não em nome de quem a criou.

## Relatórios (só leitura)

Rotas e tools para a skill `multipark-relatorios` (nada escreve na BD). Capacidades: caixa, parceiros e passagens de turno → `reports:cash`; condutores → `reports:ops`; marketing e web → `reports:marketing`.

| Tool | Rota | O que devolve |
|---|---|---|
| `cash_counts` | `GET /cash/counts?from&to[&parkId][&city]` | Contagens de caixa por parque e dia: recebido em dinheiro, gastos, previsto, contado, diferença (contado − previsto), quem contou; totais por dia e por cidade |
| `cash_count_detail` | `GET /cash/counts/:parkId/:day` | Gastos e cada versão gravada (quem e quando) |
| `cash_cases` | `GET /cash/cases` | Fila da "Correção de caixa" |
| `cash_case_detail` | `GET /cash/cases/:id` | Caso com linha do tempo (quem abriu, analisou, fechou, explicação) |
| `drivers_daily` | `GET /drivers/daily?from&to[&employeeId]` | Km, horas trabalhadas e paradas, velocidades, excessos, bateria; resumo por condutor |
| `partners_billing` | `GET /partners/billing?from&to` | A faturar por parceiro (comissão ou avença) |
| `partners_close` | `GET /partners/close?month=AAAA-MM` | Fecho de parceiros do mês |
| `shift_handovers` | `GET /shift-handovers?from&to[&city]` | Passagens de turno: caixa no cofre, bolsas, gastos, quem preencheu e confirmou |
| `marketing_stats` | `GET /marketing/stats?from&to[&projectId]` | Gasto em anúncios (Google Ads, Meta), reservas, custo por reserva, ROAS |
| `marketing_channels` | `GET /marketing/channels?from&to[&projectId]` | Mix de canais: origem das reservas + gasto |
| `marketing_brands` | `GET /marketing/brands?from&to[&projectId]` | Gasto e reservas por marca |
| `marketing_campaign_roas` | `GET /marketing/campaign-roas?from&to[&projectId]` | ROAS por campanha (utm_campaign / código de desconto) |
| `web_overview` | `GET /web/overview?from&to[&brand][&compare]` | Google Analytics + Search Console: totais e por dia, com comparação |
| `web_list` | `GET /web/list?source=ga\|sc&dim&from&to[&brand][&compare][&sort][&pageSize][&search]` | Canais, páginas, países, pesquisas... |

Intervalos: `from` e `to` (AAAA-MM-DD) obrigatórios, máximo 366 dias. Código: `server/mcpReportsApi.ts` (testes em `server/mcpReportsApi.test.ts`).
