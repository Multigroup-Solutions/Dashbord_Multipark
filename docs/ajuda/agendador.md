---
modulo: definicoes
titulo: Agendador (tarefas automáticas)
rotas: /definicoes
palavras: agendador, tarefas automáticas, cron, crons, cron-job.org, tick, api/cron/tick, cron_secret, automático, sincronização automática, parado, falhou, a meio, retoma, próxima corrida, github actions, recolha diária, zello, gps, services-tasks, serviços, tarefas dos serviços, cash-sweep, cash-close, ops-presence, sem pda, zello desligado, cash-external, invoicexpress, stripe, correção de caixa, varredura da caixa
---
# Agendador (tarefas automáticas)

Todas as tarefas automáticas da app (sincronizar o Gmail, reservas Multipark, extras, recolha GPS do Zello, relatórios, Google Ads…) correm a partir de **um só endereço**, `/api/cron/tick`. Um serviço externo gratuito, o **cron-job.org**, chama-o de **5 em 5 minutos**; em cada chamada a app vê, pela hora de Lisboa, o que está na altura e corre essas tarefas uma a uma. O que não couber nessa chamada fica para a seguinte.

Antes eram os workflows do GitHub a chamar cada tarefa, mas o GitHub atrasava-os horas (o Gmail chegou a sincronizar só 8 vezes num dia). O GitHub ficou apenas como **rede de segurança** (1 vez por hora) e para corridas manuais.

## Configurar o cron-job.org (dono / super admin, uma vez)

1. Cria uma conta em **cron-job.org** e carrega em **Create cronjob**.
2. **Title**: `Multipark — agendador`.
3. **URL**: `https://dashboard.multipark.pt/api/cron/tick`
4. **Execution schedule**: **Every 5 minutes** (a cada 5 minutos). O fuso horário não interessa — a app usa sempre a hora de Lisboa.
5. Separador **Advanced**:
   - **Request method**: `GET`.
   - **Headers** → **Add header**: nome `Authorization`, valor `Bearer ` seguido do segredo `CRON_SECRET` (o mesmo que está no Vercel, em Settings → Environment Variables). Cola o segredo **só no cron-job.org** — nunca o escrevas em conversas, emails ou tarefas.
   - **Timeout**: `30` segundos (o máximo do plano gratuito chega: a app responde logo, em 1–2 s, com **202 Accepted** e a lista do que vai correr, e continua o trabalho em segundo plano).
   - **Treat redirects with HTTP 3xx status code as success**: desligado.
6. **Notifications**: liga **Notify me when… execution of the cronjob fails** e **…the cronjob will be disabled because of too many failures**. Assim recebes um email se a app deixar de responder (ex.: segredo errado → 401, app em baixo → 5xx).
7. Guarda e carrega em **Test run**: tem de dar **202** (ou **401** se o segredo estiver mal colado — corrige o header).

Pronto. Não é preciso mais nada no GitHub.

## O que corre e quando (hora de Lisboa)

| Tarefa | Quando |
| --- | --- |
| Gmail (Comunicação — todo o email recebido, pipelines por alias, renovação do push) | de 5 em 5 min; **1× por dia** (rede de segurança e renovação do push) quando o push do Gmail está ligado (MAIL_PUSH) e chegou um push nas últimas 24 h — sem push volta sozinho aos 5 min |
| Fila do webhook Multipark · IA na comunicação · Google: alterações por enviar/receber que falharam (repetição) | de 15 em 15 min |
| Serviços das reservas → tarefas (lê ao vivo da BD da Multipark as saídas das próximas 48 h com serviços extra e cria/atualiza/fecha as tarefas, pelas regras de Definições → Parâmetros → **Serviços → tarefas**). À mão: `/api/cron/services-tasks` (trabalho `services-tasks`) | de 15 em 15 min |
| Operacional: a trabalhar sem PDA ou Zello ligado (ponto aberto sem PDA, Zello desligado, movimentos na Multipark sem ponto; lista em Operacional → PDAs, avisos só com os interruptores ligados) (trabalho `ops-presence`) | de 5 em 5 min |
| Caixa: varredura do dinheiro (lê ao vivo da BD da Multipark as reservas dos nossos parques alteradas, as que estão dentro e as que saíram nas últimas 48 h; guarda um retrato quando o dinheiro muda e abre, atualiza ou resolve os casos da **Correção de caixa**). À mão: `/api/cron/cash-sweep` (trabalho `cash-sweep`) | de 10 em 10 min |
| Caixa: fecho do dia (todas as saídas de ontem e anteontem, com as mesmas regras). À mão: `/api/cron/cash-close` (trabalho `cash-close`) | diário, a partir das 06:15 |
| Caixa: confirmar os pagamentos das saídas de ontem e anteontem: pago online tem o pagamento Stripe na Multipark (sempre); com os interruptores ligados, também Stripe, Viva Wallet (multibanco) e InvoiceExpress. À mão: `/api/cron/cash-external` (trabalho `cash-external`) | diário, a partir das 07:00 |
| Google Tarefas/Calendário/Contactos/Drive — sincronização completa (rede de segurança; o resto é em tempo real, ver Ajuda → Google em tempo real) | de 4 em 4 horas |
| Google: renovar os canais de notificação (Calendário e Drive) | 1×/dia a partir das 03:40 |
| Automação dos extras · ligações funcionário ↔ utilizador | de hora a hora |
| Escala automática dos extras (propor às 14h, confirmar às 18h, por omissão) | de hora a hora, das 08h às 23h |
| GPS do Zello — recolha provisória do próprio dia | 1×/dia entre as 23:15 e as 23:55 (se falhar, fica para a final) |
| Manutenção diária + recolha GPS do Zello final (D-2) | 1×/dia a partir das 04:30 |
| RH — regra documental dos extras (documentos em falta) | 1×/semana, segunda a partir das 04:45 |
| Extras-Dia: pressão (últimos 60 dias da BD da Multipark, por grupo de parques × dia da semana × hora; guarda o resultado na nossa BD para o separador **Pressão**) | 1×/dia a partir das 04:45 (um grupo de cada vez; se não couber, continua no tick seguinte). À mão: `/api/cron/extras-pressure` |
| Briefing diário e relatórios de segunda | 1×/dia a partir das 07:30 |
| Avaliação (4 semanas; lê os movimentos em tempo real da BD da Multipark) | 1×/dia, depois da manutenção diária (o mais tardar às 06:00) |
| Google Ads e Meta Ads | 1×/dia a partir das 05:45 (última semana) e no dia 2 de cada mês (mês anterior) |
| Web & SEO | 1×/dia a partir das 09:00 (ou da hora escolhida nas Definições, se for mais tarde) |

**Reservas**: as páginas (Reservas do dia, ficha da reserva, Ocorrências, Avaliação, Extras-Dia, Parcerias) leem a BD da Multipark **ao vivo** — nada é copiado por iniciativa própria. Para a nossa cópia financeira (`multipark_bookings`) e o CRM entram só pelo **webhook** da Multipark; a **Fila do webhook Multipark** (de 15 em 15 min) repete o que falhou e completa o detalhe de cada reserva. A sincronização de reservas recentes/futuras, a da BD Multipark, a reconciliação diária e a cópia do histórico de cada reserva **foram retiradas** (27 set 2026); o histórico antigo (anterior a 2 mar 2026) continua guardado e é mostrado quando a BD da Multipark não tem nada.

Fora da agenda: **Base de conhecimento** (atualiza-se quando a Google avisa que um ficheiro das pastas mudou e na verificação de 4 em 4 horas do Google; o botão **Sincronizar agora** continua) e **Google Business Profile** (só à mão, em pausa até a Google aprovar o acesso).

**Recolha GPS do Zello**: o Zello dá o dia de hoje durante o próprio dia, deixa de o dar à meia-noite e só o volta a dar cerca de 2 dias depois. Por isso há duas recolhas: uma **provisória** às 23:15–23:55 (o dia de hoje, para o Histórico Diário e a Atividade do Dia terem dados logo) e a **final** às 04:30, do dia de **anteontem** (D-2), que substitui a provisória (inclui os turnos que acabam depois da meia-noite) e recupera qualquer dia dos últimos 7 que tenha ficado incompleto. O alerta "GPS desligado" sai uma só vez por condutor e dia. Entram **todas** as contas Zello, incluindo as que são "admin" no Zello; ficam de fora só as da lista **Contas Zello excluídas do GPS** (Definições → Parâmetros → Operação). Recolher à mão o dia de **ontem** não é possível (o Zello não o dá nesse momento).

As linhas antigas do GPS com a velocidade no formato errado (anteriores à correção, "v1") **ficam na base de dados**, mas já não são recalculadas nem entram na avaliação. Para as apagar à mão há um script em `scripts/sql/gps-antigo-apagar.sql`.

Dias recolhidos vazios (o antigo erro de recolher "ontem"): `scripts/sql/gps-dias-vazios.sql` lista-os; depois, em **Histórico Diário**, escolhe o dia e carrega em **Recolher Dados** — a recolha manual volta a buscar as linhas vazias (as que têm dados não são tocadas).

## Ler o cartão "Agendador" (Definições → Estado, só super admin)

Cada linha é uma tarefa, com a cadência, e:
- **Última** — quando começou a última corrida; **Duração**; **Último OK** — há quanto tempo acabou bem.
- **Próxima** — "no próximo tick" ou quando volta a estar na altura.
- Estado: **OK**; **A meio (retoma)** — não coube numa chamada e continua sozinha na seguinte (normal em tarefas grandes); **Erro** — com a mensagem por baixo; **A correr**.
- **Feito neste período** — a tarefa diária/mensal já terminou hoje/este mês.
- **Tentativas falhadas** — uma tarefa diária que falha volta a tentar de 30 em 30 min, até 3 vezes; depois espera pelo dia seguinte.
- **A última corrida não terminou** — a função foi cortada pelo limite de tempo; conta como falha e volta a tentar.

O cartão **Estado do sistema** (por cima) continua a mostrar o histórico de corridas de cada tarefa e marca **Parado** quando uma tarefa não corre há mais do dobro do intervalo. Se **todas** ficarem paradas ao mesmo tempo, o problema é o cron-job.org (conta desativada, segredo mudado no Vercel sem mudar lá) — vê a linha **Agendador (cron-job.org → /api/cron/tick)**.

## Corridas manuais

- **GitHub → Actions → "Agendador — rede de segurança (tick)" → Run workflow**: corre um tick completo e mostra o relatório (vermelho se alguma tarefa falhou).
- **GitHub → Actions → "Multipark Sync Cron" (e os outros workflows) → Run workflow**: corre cada tarefa à mão (extras, escala, ligações, manutenção diária, avaliação, anúncios e briefing — já sem sync de reservas).
- Chamar o tick duas vezes ao mesmo tempo não faz mal: cada tarefa só corre numa chamada de cada vez.
