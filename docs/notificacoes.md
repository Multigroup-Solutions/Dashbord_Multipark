# Notificações — quem recebe o quê

> Gerado a partir de `shared/notificationRouting.ts` (`pnpm tsx scripts/gen-notificacoes-doc.ts`). Não editar à mão.
> As omissões abaixo podem ser alteradas pelo super admin em **Definições → Notificações** (guardadas em `app_settings`, chave `notifications.routing`).

## Regras

1. **Uma só porta.** Todos os avisos do sino (e os emails de aviso) passam por `notify()` em `server/notify.ts`. Um teste falha se alguém voltar a escrever notificações por fora.
2. **Cada tipo pertence a um módulo** da matriz de acessos (`shared/access.ts`). Quem não consegue abrir o módulo nunca recebe o aviso.
3. **Quem recebe** = pessoas **ativas** que (a) têm o **papel** na lista do tipo **ou** um **override por pessoa** que lhes dá o módulo, (b) têm a ação no módulo e (c) têm a **cidade** da notificação no seu âmbito.
4. **Cidades.** Papéis de cidade (team leader, supervisor…) só recebem da(s) sua(s) cidade(s): centro de custos + cidades dadas em Permissões. O **super admin** recebe de todas. Papéis nacionais (frontoffice, backoffice, admin) recebem de todas, a não ser que o super admin marque "só a própria cidade". Aviso sem cidade conhecida → só quem vê todas as cidades.
5. **Super admin** recebe **todos** os tipos, de todas as cidades; pode silenciar qualquer tipo que não seja obrigatório. **Admin** recebe tudo o que a matriz lhe dá (não tem Marketing, Logs, Faturação nem Anual → nunca recebe esses avisos).
6. **Pessoais** ("a tua tarefa", "os teus documentos", "a tua passagem de turno") vão só à pessoa a quem se referem.
7. **Responsável do caso.** Reclamações, perdidos e WhatsApp juntam o responsável atribuído (é assim que o team leader recebe uma reclamação: só quando é o responsável).
8. **Silenciar.** Cada pessoa escolhe no **Perfil → Notificações** o que recebe (só aparecem os tipos que lhe podem chegar) e, nos tipos com email, se também quer o email. Os **obrigatórios** não se desligam.
9. **Sem repetições.** Uma notificação por pessoa × tipo × registo dentro de uma janela curta (30 min; resumos diários 12 h). Sem registo, conta a mesma mensagem (título + texto).
10. **Sino.** Filtro por tipo e a cidade de cada aviso.

## Tabela (omissões do código)

O Super Admin entra sempre; o Admin entra sozinho quando a matriz lhe dá o módulo. "Pessoal" = só a pessoa a quem se refere.

### Suporte (reclamações, ocorrências, perdidos)

| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |
|---|---|---|---|---|---|---|---|
| Reclamação nova | `complaint_new` | Reclamações (view) | por cidade | Supervisor, Frontoffice, Backoffice, Admin, Super Admin | — | não | Reclamação criada (manual ou por email). |
| Reclamações fora do prazo | `complaint_sla` | Reclamações (view) | por cidade | Supervisor, Frontoffice, Backoffice, Admin, Super Admin | — | não | Cron horário: reclamações novas/em análise que passaram o SLA (1× por reclamação, resumo por cidade). |
| Triagem da IA por rever | `complaint_triage` | Reclamações (view) | por cidade | Supervisor, Frontoffice, Backoffice, Admin, Super Admin | — | não | Triagem da IA com prioridade alta/urgente por aplicar ou possível duplicado. |
| Ocorrência crítica | `incident_critical` | Ocorrências (view) | por cidade | Team Leader, Supervisor, Backoffice, Admin, Super Admin | sim (ligado) | não | Ocorrência criada com gravidade crítica. |
| Ocorrências fora do prazo | `incident_sla` | Ocorrências (view) | por cidade | Team Leader, Supervisor, Backoffice, Admin, Super Admin | — | não | Cron horário: ocorrências fora do prazo (1×/dia, resumo por cidade). |
| Perdido novo | `lost_found_new` | Perdidos e Achados (view) | por cidade | Team Leader, Supervisor, Backoffice, Admin, Super Admin | — | não | Perdido registado. |
| Perdidos fora do prazo | `lost_found_sla` | Perdidos e Achados (view) | por cidade | Team Leader, Supervisor, Backoffice, Admin, Super Admin | — | não | Cron horário: perdidos fora do prazo (1×/dia, resumo por cidade + responsável). |
| Email novo de cliente | `mail_new` | Comunicação (caixas de email partilhadas) (view) | por cidade | Team Leader, Supervisor, Frontoffice, Backoffice, Admin, Super Admin | — | não | Sincronização do Gmail (5 em 5 min): conversa nova ou reaberta numa caixa partilhada com aviso ligado, que não criou reclamação/perdido/crítica/ocorrência — só a quem vê essa caixa (módulo, papéis e cidade da caixa). |
| Email atribuído a ti | `mail_assigned` | Comunicação (caixas de email partilhadas) (view) | a pessoa | Pessoal | — | não | Alguém te atribui uma conversa de email (Comunicação). |

### Operações

| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |
|---|---|---|---|---|---|---|---|
| WhatsApp por responder | `whatsapp_sla` | WhatsApp (view) | por cidade | Team Leader, Supervisor, Frontoffice, Backoffice, Admin, Super Admin | — | não | Cron: conversas por responder / urgentes / janela de 24h a fechar (resumo por cidade + responsável da conversa). |
| Faltam condutores | `extras_gap` | Extras Dia (view) | por cidade | Team Leader, Supervisor, Admin, Super Admin | — | não | Proposta automática da escala e verificação da véspera com horas sem condutores. |
| Respostas ao aviso de escala | `extras_schedule_reply` | Extras Dia (view) | por cidade | Team Leader, Supervisor, Admin, Super Admin | — | não | Extra responde "não" ao aviso de escala, ou resposta que o sistema não percebeu. |
| A tua passagem de turno | `handover` | Passagem de Turno (view) | a pessoa | Pessoal | — | sim | Passagem de turno entregue (team leaders do turno seguinte) e lembrete de passagem em falta (team leaders do turno). |
| Passagem de turno em falta | `handover_missing` | Passagem de Turno (view) | por cidade | Supervisor, Admin, Super Admin | — | não | Lembrete de passagem de turno em falta (supervisores da cidade). |
| Excesso de velocidade | `speed_alert` | Histórico diário (GPS) (view) | por cidade | Team Leader, Supervisor, Admin, Super Admin | — | não | Alerta de velocidade (API GPS, registo manual, verificação Zello). |
| GPS desligado | `gps_alert` | Histórico diário (GPS) (view) | por cidade | Team Leader, Supervisor, Admin, Super Admin | — | não | Condutor com GPS desligado no Zello. |
| Relatório diário dos motoristas | `driver_daily_report` | Histórico diário (GPS) (view) | nacional | Admin, Super Admin | sim (desligado) | não | Fim da recolha diária do histórico GPS. |
| Anomalias nas reservas | `anomaly_bookings` | Reservas & Operações (view) | por cidade | Supervisor, Admin, Super Admin | — | não | Deteção diária de anomalias nas reservas (só críticas). |
| As tuas tarefas | `task` | Tarefas (view) | a pessoa | Pessoal | — | não | Tarefas: atraso, conclusão, comentários (criador, responsáveis, gestores da hierarquia). |

### Pessoas (RH, formação, recrutamento)

| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |
|---|---|---|---|---|---|---|---|
| Documentos em falta (RH) | `rh_docs_missing` | Recursos Humanos (view) | por cidade | Supervisor, Backoffice, Admin, Super Admin | — | não | Regra documental dos extras: 14 dias com documentos obrigatórios em falta (1.º aviso). |
| Os teus documentos em falta | `my_docs_missing` | Minha ficha (view) | a pessoa | Pessoal | sim (ligado) | não | Mesmo momento, para a própria pessoa (app + email). |
| Candidaturas | `driver_application` | Leads de Extras (view) | por cidade | Team Leader, Supervisor, Backoffice, Admin, Super Admin | — | não | Candidatura nova "Be a Driver" no site. |
| Lead respondeu | `lead_replied` | Leads de Extras (view) | por cidade | Team Leader, Supervisor, Backoffice, Admin, Super Admin | — | não | Lead de extras responde por WhatsApp. |
| Leads à espera | `leads_waiting` | Leads de Extras (view) | por cidade | Supervisor, Backoffice, Admin, Super Admin | — | não | Resumo diário das leads à espera (por cidade da lead). |
| Formação em atraso (equipa) | `training_overdue` | Formação (view) | por cidade | Team Leader, Supervisor, Admin, Super Admin | — | não | Formação obrigatória em atraso escalada às chefias. |
| Promoções por aprovar | `training_promotion` | Formação (edit) | por cidade | Supervisor, Backoffice, Admin, Super Admin | — | não | Exame de carreira aprovado → promoção por aprovar. |
| A tua formação | `my_training` | Formação (view) | a pessoa | Pessoal | — | não | Lembrete de formação por concluir; promoção aprovada. |
| Contestações da avaliação | `evaluation_dispute` | Avaliação Individual (edit) | por cidade | Supervisor, Admin, Super Admin | — | não | Colaborador contesta um dia/métrica da avaliação. |
| A tua avaliação | `my_evaluation` | Minha ficha (view) | a pessoa | Pessoal | — | não | Contestação aceite ou recusada. |

### Financeiro

| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |
|---|---|---|---|---|---|---|---|
| Despesas com vencimento | `expense_due` | Despesas (view) | por cidade | Supervisor, Admin, Super Admin | sim (desligado) | não | Despesa criada com data de pagamento. |
| Despesas em atraso | `expense_overdue` | Despesas (view) | por cidade | Supervisor, Admin, Super Admin | sim (desligado) | não | Verificação de despesas em atraso (por projeto). |
| Anomalias nas despesas | `anomaly_expenses` | Despesas (view) | por cidade | Supervisor, Admin, Super Admin | — | não | Deteção diária de anomalias nas despesas (só críticas). |
| Folha de ordenados | `payroll_ready` | RH — ordenados e processamento (view) | nacional | Admin, Super Admin | sim (ligado) | não | Folha de ordenados gerada (com o link do PDF). |

### Marketing

| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |
|---|---|---|---|---|---|---|---|
| Alertas de marketing | `marketing_alert` | Marketing (view) | nacional | Super Admin | sim (desligado) | não | Deteção diária de anomalias no gasto/ROAS do marketing (só críticas). |

### Sistema

| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |
|---|---|---|---|---|---|---|---|
| Integrações com problemas | `integration_alert` | Integrações (view) | nacional | Admin, Super Admin | sim (ligado) | não | Ligação (Google Ads, Meta, Google Business, WhatsApp) passa a precisar de religação ou fica em erro. |
| Crons parados | `cron_stale` | Definições (view) | nacional | Admin, Super Admin | sim (ligado) | não | Cron parado há mais do dobro do intervalo. |
| A tua conta Google | `google_account_reauth` | Minha ficha (view) | a pessoa | Pessoal | sim (ligado) | não | A autorização da tua conta Google (O meu email) expirou ou foi revogada — 1× por mudança de estado. |
| Sincronização Multipark | `sync_alert` | Sincronização (view) | nacional | Admin, Super Admin | — | não | Sem webhooks Multipark / webhooks retomados / reservas por sincronizar. |
| Orçamento da IA | `ai_budget` | Definições (view) | nacional | Admin, Super Admin | sim (desligado) | não | Gasto da IA chega ao orçamento do mês. |

## O que continua fora do sino

- Avisos **ao próprio** por WhatsApp/email que já existiam: escala dos extras (aviso de trabalho), pedidos de disponibilidade, lembrete de formação por email, email da tarefa ao criador.
- Relatórios por email com destinatários próprios (já por cidade/módulo): briefing diário, relatórios semanais, email da passagem de turno.
- `system.notifyOwner` (ferramenta manual de admin que envia um email ao OWNER_EMAIL).

## Limpeza única (migração 0140)

No primeiro arranque depois desta mudança, as notificações **por ler com mais de 14 dias** passam a lidas (o sino deixa de estar inundado pelos avisos antigos, que iam a toda a gente). Corre uma só vez: fica marcada em `app_notification_maintenance` (`0140_mark_old_read`). As notificações não são apagadas.

## Tipos antigos

Silenciamentos guardados com os tipos antigos são convertidos: `extras` → faltam condutores, respostas ao aviso de escala, passagem em falta; `complaint` → os três de reclamações; `case_sla` → ocorrências/perdidos fora do prazo; `training` → os três de formação; `sync`/`integration` → sistema.
