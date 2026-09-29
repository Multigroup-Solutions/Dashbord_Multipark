# Exportar o bookingPrice inicial das reservas

O script `scripts/multipark-initial-booking-price.ts` consulta a base de dados
operacional PostgreSQL da Multipark. Exporta **uma linha por reserva criada
desde 1 de maio de 2026**, em todos os parques e estados, incluindo canceladas.
O filtro usa **Booking.createdAt**, não a entrada no parque.

## Executar

### Usar a ligação existente no servidor da dashboard

```powershell
pnpm export:initial-booking-price --remote https://dashboard.multipark.pt
```

Neste modo, `DATABASE_URL_MULTIPARK` fica no servidor da Vercel. Cada pedido
autenticado lê até 1000 registos (500 por omissão), evitando concentrar toda
a exportação numa função de 60 segundos. O CSV e o resumo são guardados no PC.

O comando usa `BOOKING_PRICE_EXPORT_SECRET` do ambiente ou dos ficheiros de
configuração. Esta credencial só autoriza o endpoint da exportação. Por
compatibilidade, também aceita `CRON_SECRET` quando a credencial dedicada não existe.
`--env-file CAMINHO` permite usar um ficheiro de configuração privado já existente.
Nunca passar o segredo como argumento nem guardá-lo no repositório.

O endpoint `POST /api/exports/initial-booking-price` exige autenticação, recusa
cache e só aceita os filtros e as duas consultas fixas desta exportação.
O servidor remove os restantes campos pessoais de `modifiedFields` antes
de devolver o histórico. Não se publicam CSV ou dados operacionais como
artefactos de GitHub Actions.

Se a credencial só estiver disponível na automação, o workflow manual
**BD Multipark — exportar preço inicial (cifrado)** usa `BOOKING_PRICE_EXPORT_SECRET`
configurado na Vercel e no repositório. Recebe apenas a chave **pública** RSA do destinatário (SPKI DER
em base64). A chave privada fica no PC. O único artefacto publicado contém
o CSV e o resumo cifrados com AES-256-GCM, com a chave protegida por
RSA-OAEP-SHA256; expira ao fim de um dia. `openPriceExport`, em
`server/multiparkDb/priceExportEnvelope.ts`, abre o ficheiro no PC do destinatário.

### Ligação direta local

Na raiz deste repositório, depois de instalar as dependências com `pnpm install --frozen-lockfile`:

```powershell
pnpm export:initial-booking-price
```

A ligação `DATABASE_URL_MULTIPARK` tem de existir no ambiente, em `.env.local`
ou em `.env`, por essa ordem. Usa a ligação à base de dados operacional, que é
diferente da base de dados própria da dashboard. O script reutiliza o cliente
de leitura da dashboard: consulta parametrizada, transação só de leitura,
tempo máximo de 15 segundos por consulta e encerramento da ligação no fim.
Não altera reservas, preços, histórico, tabelas ou índices.

Exemplos:

```powershell
# Verificar filtros sem ligar à base de dados
pnpm export:initial-booking-price --dry-run

# Apenas reservas criadas em maio, incluindo todo o dia 31
pnpm export:initial-booking-price --from 2026-05-01 --to 2026-05-31

# Reduzir o tamanho das consultas
pnpm export:initial-booking-price --page-size 500
```

As datas referem-se a **Europe/Lisbon**. O início corresponde a
`2026-04-30 23:00:00 UTC`. Sem `--to`, o limite superior é o instante de início
da execução. `--to` é inclusivo e limitado ao instante da execução.

## Ficheiros produzidos

Cada execução concluída cria uma pasta própria em
`exports/initial-booking-price/`, com:

- `reservas.csv`: CSV UTF-8 com BOM, separador `;`, decimais com ponto.
- `resumo.json`: filtros, contagens e confirmação de que todas as páginas foram lidas.

A pasta `exports/` está excluída do Git. `--out-dir` permite outro destino,
relativo à raiz do projeto ou absoluto; nesse caso, garante que fica fora do Git.
Nenhuma execução substitui um relatório anterior. Considera o resultado completo
apenas quando existir `resumo.json` com `complete: true`. Uma falha de escrita
pode deixar ficheiros `.partial` ou um CSV sem resumo.

Não são exportados nomes de clientes, contactos, matrículas nem o histórico integral.

## Como o valor é escolhido

1. Percorre todo o histórico disponível das reservas selecionadas, sem o limite
   de 300 eventos usado por algumas vistas da ficha.
2. Encontra o primeiro evento `CREATED`, por `actionTime`.
3. Lê `snapshot.bookingPrice` e/ou o valor `to` de `modifiedFields.bookingPrice`.
   Se ambos existirem e divergirem, assinala conflito e deixa o preço inicial vazio.
4. Sem prova no primeiro `CREATED`, mantém `booking_price_inicial` vazio.
   **Zero é um preço válido**, diferente de vazio.

| Coluna / estado | Significado |
|---|---|
| `booking_price_inicial` | Valor comprovado pelo primeiro `CREATED` |
| `CONFIRMADO_NO_CREATED` | Existe prova do preço no evento de criação |
| `CONFLITO_NO_CREATED` | Fontes do primeiro evento, ou eventos à mesma hora, discordam |
| `CREATED_SEM_PRECO` | Existe criação, mas sem preço numérico recuperável |
| `SEM_REGISTO_CREATED` | Há histórico, mas não há evento de criação |
| `SEM_HISTORICO` | Não se encontrou histórico para a reserva |
| `primeiro_preco_observado` | Primeiro valor histórico recuperável; pode ser anterior a uma alteração (`from`) ou de um estado posterior. **Não garante o preço na criação.** |
| `historico_criacao_id` / `historico_criacao_em_utc` | Referência para verificar a prova de criação |
| `booking_price_atual` / `original_booking_price_campo` | Campos atuais da reserva, apenas para comparação; nunca substituem o histórico |
| `registos_created` | Mais de um evento de criação deve ser revisto |

Os campos `fonte_*` indicam a origem do valor. Em empates, usa o ID para ordenar
de forma determinística; preços diferentes à mesma hora geram conflito.
São aceites números e texto numérico com ponto decimal, JSON com `from/to` e
as variantes já suportadas na ficha (`oldValue/newValue`, pares e listas de
campos), e linhas de texto `bookingPrice: 45 -> 50`. Valores monetários formatados
como `45,50 €`, texto malformado e estruturas desconhecidas não são convertidos
por aproximação. A moeda exportada é a moeda **atual** da reserva.

## Limites da leitura

- Paginação pelo ID, sem `OFFSET` nem uma consulta individual por reserva.
  Só conserva dados mínimos de cada reserva e os candidatos relevantes do histórico.
- Usa as reservas que ainda existem em `Booking`. Reservas e histórico apagados
  não podem ser recuperados por este relatório.
- Limita eventos ao início da execução, mas as páginas não partilham um único
  snapshot transacional. Alterações/apagamentos concorrentes podem afetar a leitura;
  para uma auditoria fechada, executar sobre uma cópia consistente da base de dados.
- O preço é o número guardado no histórico, sem recálculo de IVA, descontos ou
  arredondamento. Não é inferido a partir do valor atual.

## Validar a lógica

```powershell
pnpm exec vitest run server/multiparkDb/initialBookingPrice.test.ts server/multiparkDb/initialBookingPriceRoutes.test.ts
```

Os testes usam exemplos controlados e consultas simuladas; não substituem a
execução na base de dados real.
