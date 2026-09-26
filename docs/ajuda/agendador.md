---
modulo: definicoes
titulo: Agendador (tarefas automáticas)
rotas: /definicoes
palavras: agendador, tarefas automáticas, cron, crons, cron-job.org, tick, api/cron/tick, cron_secret, automático, sincronização automática, parado, falhou, a meio, retoma, próxima corrida, github actions, recolha diária, zello, gps
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
| Gmail (Comunicação) | de 5 em 5 min |
| Fila do webhook Multipark · IA na comunicação · Google Tarefas/Calendário/Contactos/Drive | de 15 em 15 min |
| Reservas recentes · emails IMAP · automação dos extras · ligações funcionário ↔ utilizador | de hora a hora |
| Escala automática dos extras (propor às 14h, confirmar às 18h, por omissão) | de hora a hora, das 08h às 23h |
| Reservas futuras | de 2 em 2 horas |
| GPS do Zello — recolha provisória do próprio dia | 1×/dia entre as 23:15 e as 23:55 (se falhar, fica para a final) |
| Manutenção diária + recolha GPS do Zello final (D-2) | 1×/dia a partir das 04:30 |
| RH — regra documental dos extras (documentos em falta) | 1×/semana, segunda a partir das 04:45 |
| Briefing diário e relatórios de segunda | 1×/dia a partir das 07:30 |
| Avaliação (4 semanas) | 1×/dia, depois da manutenção diária (o mais tardar às 06:00) |
| Google Ads e Meta Ads | 1×/dia a partir das 05:45 (última semana) e no dia 2 de cada mês (mês anterior) |
| Web & SEO | 1×/dia a partir das 09:00 (ou da hora escolhida nas Definições, se for mais tarde) |

Fora da agenda (só à mão): **Base de conhecimento** (botão **Sincronizar agora**) e **Google Business Profile** (em pausa até a Google aprovar o acesso).

**Recolha GPS do Zello**: o Zello dá o dia de hoje durante o próprio dia, deixa de o dar à meia-noite e só o volta a dar cerca de 2 dias depois. Por isso há duas recolhas: uma **provisória** às 23:15–23:55 (o dia de hoje, para o Histórico Diário e a Atividade do Dia terem dados logo) e a **final** às 04:30, do dia de **anteontem** (D-2), que substitui a provisória (inclui os turnos que acabam depois da meia-noite) e recupera qualquer dia dos últimos 7 que tenha ficado incompleto. O alerta "GPS desligado" sai uma só vez por condutor e dia. Recolher à mão o dia de **ontem** não é possível (o Zello não o dá nesse momento).

As linhas antigas do GPS com a velocidade no formato errado (anteriores à correção, "v1") são **apagadas** aos poucos pela manutenção diária, em vez de recalculadas.

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
- **GitHub → Actions → "Multipark Sync Cron" (e os outros workflows) → Run workflow**: corre cada tarefa à mão, como antes.
- Chamar o tick duas vezes ao mesmo tempo não faz mal: cada tarefa só corre numa chamada de cada vez.
