# Agentes com interações desde maio de 2026

O script `scripts/multipark-active-agents.ts` exporta os agentes com pelo menos um evento em `History` ou `ActivityEvent`, em qualquer cidade. O filtro incide na **data da interação**, incluindo reservas criadas antes do período. Por omissão começa em 1 de maio de 2026, às 00:00 de Lisboa (30 de abril, 23:00 UTC), e termina no início da execução.

```powershell
pnpm export:active-agents --dry-run
pnpm export:active-agents --remote https://dashboard.multipark.pt --env-file exports/configuracao-privada.env
# Ou diretamente, com DATABASE_URL_MULTIPARK configurada:
pnpm export:active-agents --from 2026-05-01 --to 2026-09-30
```

O modo remoto usa `AGENT_ACTIVITY_EXPORT_SECRET`, guardado no servidor e num ficheiro local ignorado pelo Git. Nunca colocar a credencial no comando, no código ou num relatório. O endpoint `/api/exports/active-agents` aceita apenas cinco consultas predefinidas, confirma a ligação só de leitura e recusa credenciais de outras exportações. Os dados chegam diretamente ao computador por HTTPS; não são publicados como artefactos do repositório.

## Ficheiros

Cada execução completa cria uma pasta única em `exports/active-agents/`:

- `agentes.csv`: nome, e-mail e cidade nas primeiras colunas; identificador e evidências nas restantes.
- `outros-autores.csv`: autores com atividade sem ficha Agent atual nem papel explícito de agente no histórico, para revisão de contas apagadas, clientes e sistemas.
- `agentes-sem-email.csv`: subconjunto de agentes cujo e-mail não foi encontrado nas fontes consultadas.
- `reservas-condutores.csv`: condutores da receção e entrega ao cliente nos campos atuais da reserva. Este ficheiro suplementar usa a **data de criação da reserva**, para cruzar por `id` com a exportação anterior de preços. A presença do campo não prova a data da entrega.
- `resumo.json`: filtros, contagens, conflitos e limitações. Só é marcado completo depois de ler todos os lotes.

As linhas são reunidas por `Agent.userId`. Um agente com fichas em vários parques aparece uma vez. Contas com o mesmo nome continuam separadas. Inclui perfis inativos e todas as funções, mas uma ficha sem qualquer evento no período não entra no resultado. Contas sem ficha atual com papel explícito de agente no histórico entram com a identificação `AGENTE_NO_HISTORICO`.

O e-mail vem de `ActivityEvent.actorEmail` ou de um convite ligado por `acceptedBy`/`createdAgentId`, independentemente do estado atual do convite. Não é inferido a partir do nome. Endereços diferentes ficam visíveis e assinalados. Convites sem ligação explícita ou com identidades contraditórias não são usados.

As cidades vêm dos parques associados às interações; na ausência destes, usam-se os parques da ficha atual, com essa origem explícita. Várias cidades ficam na mesma linha. Não se infere a cidade pelo e-mail nem se afirma a localização física do agente. Todos os horários de evidência nos CSV são UTC.

Os dois históricos podem registar a mesma ação, por isso as contagens são separadas. Leituras ou logins sem evento guardado e histórico apagado não podem ser recuperados. As páginas usam um limite temporal fixo, mas não partilham uma única transação: alterações concorrentes ou retroativas são uma limitação. A exportação não altera dados.
