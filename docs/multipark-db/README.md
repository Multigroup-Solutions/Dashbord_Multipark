# BD da Multipark como fonte das reservas

Estado (26 set 2026): **mapeado e confirmado, interruptor DESLIGADO.** O esquema
real está em `schema.md` e as consultas em `server/multiparkDb/queries.ts`. A
sonda (workflow em modo `probe`) confirmou: datas em UTC (`DATE_MODE = "utc"`),
os mesmos ids das reservas e dos movimentos, os mesmos preços/estados e as
mesmas 114 reservas num dia de check-ins. A fonte continua a ser a **API** até o
super admin ligar o interruptor nas Definições (passos 5–7).

Pendentes do lado da Multipark: utilizador só de leitura; índices em
`"History"("actionTime")` e `("bookingId")` (a tabela só tem a PK).

## O que é `DATABASE_URL_MULTIPARK`

É a ligação direta à base de dados da aplicação Multipark (be-multipark, sistema
de outra empresa), a que tem sempre tudo atualizado: reservas, todos os
movimentos (check-in, check-out, mudanças de lugar, quem fez e quando),
condutores, etc. Hoje o dashboard só sabe destas coisas pela API
(`/bookings/report` por parque × ação, `/bookings/:id`, `/bookings/:id/history`)
e pelo webhook. Para não perder nada temos três redes de segurança: sync de hora
a hora (`multipark-sync`), janela futura de 2 em 2 h (`multipark-future`) e a
reconciliação diária (no `daily-ops`). Com a BD, estas três podem desaparecer.

- Formato: `postgresql://…` (a be-multipark usa Prisma, por isso é provável que
  seja PostgreSQL) ou `mysql://…`. O motor é detetado pelo esquema do URL.
- SSL: o que o URL pedir (`sslmode=require`, `verify-full`, `disable`, ou
  `ssl-mode=…` no MySQL). Sem indicação: sem SSL em anfitriões locais/privados,
  SSL sem verificação de certificado nos restantes. `MULTIPARK_DB_SSL=off|require|verify`
  sobrepõe-se ao URL.
- O URL e as credenciais nunca são escritos em logs nem em mensagens de erro.

### Recomendação forte: utilizador SÓ DE LEITURA

Pedir a quem administra a BD da Multipark um utilizador próprio para o dashboard,
**só com leitura**, e se possível **restrito por IP** (as funções da Vercel não
têm IP fixo; se a BD estiver atrás de firewall, ver com a Vercel "Static IPs"/
Secure Compute ou um proxy com IP fixo). Exemplo em PostgreSQL (quem administra
a BD é que corre isto, não nós):

```sql
CREATE ROLE dashboard_ro LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE dashboard_ro SET default_transaction_read_only = on;
ALTER ROLE dashboard_ro SET statement_timeout = '15s';
ALTER ROLE dashboard_ro CONNECTION LIMIT 10;
GRANT CONNECT ON DATABASE multipark TO dashboard_ro;
GRANT USAGE ON SCHEMA public TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard_ro;
```

Em MySQL: `CREATE USER 'dashboard_ro'@'<ip>' …; GRANT SELECT ON multipark.* TO 'dashboard_ro'@'<ip>';`

Idealmente só com `SELECT` nas tabelas de que precisamos (reservas, clientes,
veículos, parques, histórico/movimentos, utilizadores/condutores, parceiros,
campanhas, extras) — não nas de pagamentos/cartões ou palavras-passe.

### Como o dashboard garante que só lê (defesa em profundidade)

Mesmo que o utilizador tivesse mais permissões, o cliente
(`server/multiparkDb/client.ts`):

1. passa cada consulta por uma guarda que só aceita **uma** instrução
   `SELECT` / `WITH` / `SHOW` / `EXPLAIN` e recusa palavras de escrita, DDL,
   permissões, bloqueios (`FOR UPDATE`), `SELECT … INTO`, `EXPLAIN ANALYZE`,
   barras invertidas, `$$` e `/*!`;
2. põe cada ligação em modo só de leitura (Postgres `SET SESSION CHARACTERISTICS
   AS TRANSACTION READ ONLY`; MySQL `SET SESSION TRANSACTION READ ONLY`);
3. corre cada consulta dentro de `BEGIN READ ONLY` / `START TRANSACTION READ ONLY`,
   que acaba sempre em `ROLLBACK`;
4. pool minúscula (2 ligações por função), 5 s para ligar, 15 s por instrução.

## Porque é que continuamos a ter uma cópia local (`multipark_bookings`)

A ideia **não** é o dashboard ir à BD deles em cada página. Continuamos a gravar
em `multipark_bookings` (+ `multipark_booking_history`, `multipark_booking_extras`,
`multipark_agents`) e só muda **de onde** vêm os dados. Porquê:

- **Desempenho**: as páginas (reservas, finanças, avaliação, operações,
  parcerias, marketing) fazem agregações e JOINs com as nossas tabelas —
  projetos, parceiros e aliases, fichas dos colaboradores, despesas, campanhas.
  Não é possível fazer JOIN entre duas bases de dados diferentes.
- **Colunas só nossas**: `projectId` (matcher de parques), campanha/parceiro
  resolvidos, atribuição Google/Meta Ads, estado do lugar (garagem/lugar/km),
  agentes ligados às fichas, "feito" dos extras marcado na app.
- **Carga na BD deles**: é a BD de produção da Multipark. Um sync incremental
  de 5 em 5 min é leve; dezenas de utilizadores a abrir páginas não seriam.
- **Disponibilidade**: se a BD deles (ou a rede) falhar, o dashboard continua a
  funcionar com a cópia local, só um pouco atrasado.

## Como funciona o interruptor `MULTIPARK_SOURCE`

Definições → Automações → **"Reservas: ler da BD da Multipark (em vez da API)"**
(só o super admin muda; env `MULTIPARK_SOURCE=api|db`; a escolha nas Definições
ganha à env). Omissão: **desligado = API**.

Proteção: pedir a BD só tem efeito quando a BD está **pronta** —
`DATABASE_URL_MULTIPARK` definida **e** `MULTIPARK_DB_MAPPED.bookings` e
`.movements` a `true` em `queries.ts`. Até lá a fonte efetiva continua a ser a
API (o `multipark-sync` nunca é desligado sem o substituto a funcionar). Os
condutores são opcionais: por mapear, esse fluxo simplesmente não corre.

| | Fonte = API (omissão) | Fonte = BD |
|---|---|---|
| `multipark-sync` (1 h) | corre como sempre | fora do agendador |
| `multipark-future` (2 h) | corre como sempre | fora do agendador |
| reconciliação (daily-ops) | corre como sempre | saltada |
| `multipark-db-sync` (5 min) | fora do agendador | corre |
| `multipark-deliveries` (webhook, 15 min) | corre | **continua** (até o Jorge o desligar) |
| Estado do sistema | igual a hoje | `multipark-sync/-future` sem alerta de "parado" |

O `multipark-db-sync` (`server/multiparkDb/dbSync.ts`, endpoint manual
`/api/cron/multipark-db-sync`):

- **reservas**: as alteradas desde o cursor (`updatedAt`, `id`) em páginas de 200
  → mesmo código da API (`bookingToRecord` + upsert + extras + detalhe), por isso
  a atribuição de parceiros, projetos e Ads funciona igual;
- **movimentos**: desde o cursor, em páginas de 500 → `multipark_booking_history`
  (a tabela que a avaliação já usa) + resumo na reserva (agente do check-in/out,
  garagem, lugar, km) + ligação agente ↔ ficha por email;
- **condutores**: de hora a hora → `multipark_agents` (nome, email, função,
  ativo; sem telefone) + ligação agente ↔ ficha por email;
- **parceiros**: descoberta de parceiros de hora a hora (era feita pelo
  `multipark-sync`);
- grava o cursor depois de cada página (`multipark_db_cursors`); se não acabar
  no tempo do tick, volta logo no tick seguinte. Primeira corrida: últimos
  `MULTIPARK_DB_INITIAL_DAYS` (3) dias — para recuperar mais, apagar a linha
  do fluxo em `multipark_db_cursors` e pôr a variável maior.
- partilha o trinco da sincronização (`multipark_sync_lock`) com o "Reparar
  período" e o MCP.

Migração **0205**: `multipark_agents` e `multipark_db_cursors`. Os movimentos
**não** têm tabela nova — vão para `multipark_booking_history`.

## Ficheiros

| Ficheiro | O quê |
|---|---|
| `server/multiparkDb/client.ts` | ligação só de leitura (pg / mysql2), guarda, redação, teste de ligação |
| `server/multiparkDb/queries.ts` | **o único sítio com o esquema deles**: consultas + tabela "nosso campo ← tabela.coluna" (TODO) |
| `server/multiparkDb/source.ts` | interface `MultiparkSource`, `ApiSource` (sobre a API atual), `DbSource`, interruptor |
| `server/multiparkDb/dbSync.ts` | trabalho `multipark-db-sync` |
| `server/multiparkDb/schemaDoc.ts` + `scripts/multipark-db-schema.ts` | descoberta do esquema (só estrutura) |
| `server/multiparkDb/multiparkDb.test.ts` | guarda, URL/redação, mapeamento com linhas-exemplo, interruptor |

Integrações → cartão **"BD Multipark (só leitura)"** → **Testar** (só super
admin): diz só se liga, motor e versão, se a sessão ficou só de leitura, a
latência e o número de tabelas.

## Passo a passo da próxima sessão (no PC do Jorge, onde a BD é acessível)

1. **Esquema.** **Via online (recomendado — a `DATABASE_URL_MULTIPARK` está na
   Vercel como variável "sensível" e não dá para a puxar):** GitHub → Actions →
   **"BD Multipark — descobrir esquema (manual)"** → Run workflow (ou
   `gh workflow run multipark-db-schema.yml` e depois `gh run download <id> -n multipark-db-schema`).
   Chama `GET /api/cron/multipark-db-schema` em produção (token dos cron; só
   estrutura; recusa se a sessão não ficar só de leitura) e guarda o
   `schema.md` como artefacto → copiar para `docs/multipark-db/schema.md`.

   **Via local** (num PC que chegue à BD): pôr `DATABASE_URL_MULTIPARK` no `.env.local` e correr:
   ```bash
   pnpm tsx scripts/multipark-db-schema.ts
   # opções: --out <ficheiro.md>  --schema public  --json /tmp/esquema.json  --print
   ```
   Escreve `docs/multipark-db/schema.md` (só estrutura e contagens aproximadas,
   sem dados — pode ir para o git). Se disser que a sessão não ficou só de
   leitura, **parar** e pedir o utilizador só de leitura.
2. **Mapear** em `server/multiparkDb/queries.ts`:
   - `BOOKING_QUERY.from` (tabela das reservas + JOINs a parque, cliente,
     veículo, parceiro, campanha) e a expressão de cada alias (ou `null`);
   - `cursorAt` = coluna de última alteração (Prisma: `"updatedAt"`, com
     índice!) e `cursorId` = chave primária;
   - `BOOKING_PERIOD_COLUMNS` (que data usa cada ação do report);
   - `MOVEMENT_QUERY` (histórico/movimentos + utilizador que fez) e
     `CHANGE_TYPE_MAP` se os tipos não forem `CHECK_IN`, `CHECK_OUT`, `MOVEMENT`…;
   - `DRIVER_QUERY` + `DRIVER_FILTER` (só condutores/agentes);
   - `extra_services` (ex.: subconsulta `json_agg`) se quisermos os extras;
   - aspas: Postgres/Prisma usa `"camelCase"`, MySQL `` `acentos` ``. Colunas com
     nomes como `set`, `start`, `lock`… têm de ir entre aspas (a guarda recusa-as
     sem aspas).
3. **Confirmar duas coisas antes de ligar** (comparar 5–10 reservas conhecidas):
   - **datas** (`DATE_MODE`): o `checkIn` de uma reserva em `multipark_bookings`
     (vindo da API) é igual ao da BD em UTC (`"utc"`) ou em hora de Lisboa
     (`"lisbon_wallclock"`)? Com o modo errado as reservas mudam 1–2 h — e o
     `sourceUpdatedAt` (que impede uma versão antiga de sobrepor uma nova)
     deixa de bater certo entre API/webhook e BD;
   - **ids**: o `id` da reserva é o mesmo `externalId` que já temos (senão
     duplicava tudo) e o `id` dos movimentos é o mesmo `historyId` que a API dá
     em `/bookings/:id/history` (senão os check-ins ficam duplicados na
     avaliação enquanto a fila do webhook ainda for buscar o histórico à API).
4. Pôr `MULTIPARK_DB_MAPPED.bookings/movements/drivers = true`, ajustar as
   linhas-exemplo dos testes se preciso e correr `pnpm check && pnpm test`.
5. **Preview**: numa deployment de preview (com a mesma BD nossa ou uma cópia),
   definir `DATABASE_URL_MULTIPARK` e ligar o interruptor (ou
   `MULTIPARK_SOURCE=db` só no ambiente Preview). Integrações → Testar. Chamar
   `/api/cron/multipark-db-sync` à mão e ver o resultado.
6. **Comparar durante alguns dias** com a API (em produção continua a API):
   contagens por dia × parque × ação (criação, check-in, check-out,
   cancelamento), estados, valores, check-ins por condutor na avaliação.
   O `createApiSource()` e o `createDbSource()` têm a mesma interface
   (`listBookingsByPeriod`) — dá para um script de comparação curto (correr com
   `TZ=UTC`: o `pg` lê `timestamp without time zone` no fuso do processo; na
   Vercel já é UTC).
7. **Produção**: ligar o interruptor nas Definições (super admin). Seguir
   "Estado do sistema" → `multipark-db-sync` verde de 5 em 5 min.
8. **Retirar** (quando estável): o `multipark-sync`, o `multipark-future` e a
   reconciliação já não correm com a fonte = BD; depois de algumas semanas,
   apagar o código deles e, se o Jorge quiser, desligar a fila do webhook
   (`multipark-deliveries`) e o próprio webhook.

## Checklist dos dados que o Jorge disse que já existem na BD

- [ ] **Reservas** — todos os campos que hoje vêm do `/bookings/report` e do
  `/bookings/:id` (cliente, veículo, voos, preços, pagamento, parceiro,
  campanha, origem/URL, extras, cancelamento).
- [ ] **Todos os movimentos** — check-in, check-out, mudanças de
  garagem/lugar/km, com **quem fez** (utilizador) e **quando**.
- [ ] **Condutores** — lista de utilizadores/condutores (nome, email, função,
  ativo, parque/cidade se houver).
- [ ] Parques (id, nome, cidade) para o `projectId`.
- [ ] Parceiros e campanhas (nome real — a API mascara como "Unknown User").
- [ ] Coluna de "última alteração" com índice nas reservas e nos movimentos
  (para o sync incremental não varrer tabelas inteiras).
