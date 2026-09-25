/**
 * Gera docs/notificacoes.md a partir de shared/notificationRouting.ts (as
 * omissões do código). Regenerar: `pnpm tsx scripts/gen-notificacoes-doc.ts`;
 * um teste garante que o ficheiro está em dia.
 */
import { MODULES, ROLE_LABELS } from "./access";
import { NOTIFICATION_GROUP_LABELS, routingTable, type NotificationGroup } from "./notificationRouting";

/** De onde sai cada tipo (para quem lê a documentação). */
export const KIND_SOURCES: Record<string, string> = {
  complaint_new: "Reclamação criada (manual ou por email).",
  complaint_sla: "Cron horário: reclamações novas/em análise que passaram o SLA (1× por reclamação, resumo por cidade).",
  complaint_triage: "Triagem da IA com prioridade alta/urgente por aplicar ou possível duplicado.",
  mail_new: "Sincronização do Gmail (5 em 5 min): conversa nova ou reaberta numa caixa partilhada com aviso ligado, que não criou reclamação/perdido/crítica/ocorrência — só a quem vê essa caixa (módulo, papéis e cidade da caixa).",
  mail_assigned: "Alguém te atribui uma conversa de email (Comunicação).",
  web_analytics_alert: "Recolha diária Web & SEO (/api/cron/web-analytics): sessões de ontem abaixo da média de 7 dias, cliques orgânicos da semana a cair, pesquisas do top a perder posição, PageSpeed móvel abaixo do mínimo e dados reais (Chrome UX Report) das páginas-chave acima dos limiares de LCP/INP/CLS (limiares em Definições → Integrações → Web & SEO; 1× por propriedade e dia).",
  google_business_alert: "Recolha do Google Business Profile (/api/cron/google-business), 1×/dia depois da atualização: impressões ou chamadas da semana a cair face à anterior, perfil sem controlo (suspenso/por verificar), fechado, alterado pela Google ou com edições pendentes (limiares em Marketing → Web & SEO → Google Business → Configurar).",
  google_reviews_alert: "Recolha do Google Business Profile (/api/cron/google-business), 1×/dia: média de estrelas dos últimos 7 dias abaixo da dos 90 dias anteriores e críticas Google sem resposta há mais de N horas (por perfil; vai à cidade do perfil).",
  google_account_reauth: "A autorização da tua conta Google (O meu email, Tarefas e Calendário) expirou ou foi revogada — 1× por mudança de estado.",
  incident_critical: "Ocorrência criada com gravidade crítica.",
  incident_sla: "Cron horário: ocorrências fora do prazo (1×/dia, resumo por cidade).",
  lost_found_new: "Perdido registado.",
  lost_found_sla: "Cron horário: perdidos fora do prazo (1×/dia, resumo por cidade + responsável).",
  whatsapp_sla: "Cron: conversas por responder / urgentes / janela de 24h a fechar (resumo por cidade + responsável da conversa).",
  extras_gap: "Proposta automática da escala e verificação da véspera com horas sem condutores.",
  extras_schedule_reply: "Extra responde \"não\" ao aviso de escala, ou resposta que o sistema não percebeu.",
  handover: "Passagem de turno entregue (team leaders do turno seguinte) e lembrete de passagem em falta (team leaders do turno).",
  handover_missing: "Lembrete de passagem de turno em falta (supervisores da cidade).",
  speed_alert: "Alerta de velocidade (API GPS, registo manual, verificação Zello).",
  gps_alert: "Condutor com GPS desligado no Zello.",
  driver_daily_report: "Fim da recolha diária do histórico GPS.",
  anomaly_bookings: "Deteção diária de anomalias nas reservas (só críticas).",
  task: "Tarefas: atraso, conclusão, comentários (criador, responsáveis, gestores da hierarquia).",
  rh_docs_missing: "Regra documental dos extras: 14 dias com documentos obrigatórios em falta (1.º aviso).",
  my_docs_missing: "Mesmo momento, para a própria pessoa (app + email).",
  driver_application: "Candidatura nova \"Be a Driver\" no site.",
  lead_replied: "Lead de extras responde por WhatsApp.",
  leads_waiting: "Resumo diário das leads à espera (por cidade da lead).",
  training_overdue: "Formação obrigatória em atraso escalada às chefias.",
  training_promotion: "Exame de carreira aprovado → promoção por aprovar.",
  my_training: "Lembrete de formação por concluir; promoção aprovada.",
  evaluation_dispute: "Colaborador contesta um dia/métrica da avaliação.",
  my_evaluation: "Contestação aceite ou recusada.",
  expense_due: "Despesa criada com data de pagamento.",
  expense_overdue: "Verificação de despesas em atraso (por projeto).",
  anomaly_expenses: "Deteção diária de anomalias nas despesas (só críticas).",
  payroll_ready: "Folha de ordenados gerada (com o link do PDF).",
  marketing_alert: "Deteção diária de anomalias no gasto/ROAS do marketing (só críticas).",
  integration_alert: "Ligação (Google Ads, Meta, Google Business, WhatsApp) passa a precisar de religação ou fica em erro.",
  cron_stale: "Cron parado há mais do dobro do intervalo.",
  sync_alert: "Sem webhooks Multipark / webhooks retomados / reservas por sincronizar.",
  ai_budget: "Gasto da IA chega ao orçamento do mês.",
};

const moduleLabel = (id: string) => MODULES.find((m) => m.id === id)?.label ?? id;

export function renderNotificacoesDoc(): string {
  const rows = routingTable();
  const out: string[] = [];
  out.push("# Notificações — quem recebe o quê");
  out.push("");
  out.push("> Gerado a partir de `shared/notificationRouting.ts` (`pnpm tsx scripts/gen-notificacoes-doc.ts`). Não editar à mão.");
  out.push("> As omissões abaixo podem ser alteradas pelo super admin em **Definições → Notificações** (guardadas em `app_settings`, chave `notifications.routing`).");
  out.push("");
  out.push("## Regras");
  out.push("");
  out.push("1. **Uma só porta.** Todos os avisos do sino (e os emails de aviso) passam por `notify()` em `server/notify.ts`. Um teste falha se alguém voltar a escrever notificações por fora.");
  out.push("2. **Cada tipo pertence a um módulo** da matriz de acessos (`shared/access.ts`). Quem não consegue abrir o módulo nunca recebe o aviso.");
  out.push("3. **Quem recebe** = pessoas **ativas** que (a) têm o **papel** na lista do tipo **ou** um **override por pessoa** que lhes dá o módulo, (b) têm a ação no módulo e (c) têm a **cidade** da notificação no seu âmbito.");
  out.push("4. **Cidades.** Papéis de cidade (team leader, supervisor…) só recebem da(s) sua(s) cidade(s): centro de custos + cidades dadas em Permissões. O **super admin** recebe de todas. Papéis nacionais (frontoffice, backoffice, admin) recebem de todas, a não ser que o super admin marque \"só a própria cidade\". Aviso sem cidade conhecida → só quem vê todas as cidades.");
  out.push("5. **Super admin** recebe **todos** os tipos, de todas as cidades; pode silenciar qualquer tipo que não seja obrigatório. **Admin** recebe tudo o que a matriz lhe dá (não tem Marketing, Logs, Faturação nem Anual → nunca recebe esses avisos).");
  out.push("6. **Pessoais** (\"a tua tarefa\", \"os teus documentos\", \"a tua passagem de turno\") vão só à pessoa a quem se referem.");
  out.push("7. **Responsável do caso.** Reclamações, perdidos e WhatsApp juntam o responsável atribuído (é assim que o team leader recebe uma reclamação: só quando é o responsável).");
  out.push("8. **Silenciar.** Cada pessoa escolhe no **Perfil → Notificações** o que recebe (só aparecem os tipos que lhe podem chegar) e, nos tipos com email, se também quer o email. Os **obrigatórios** não se desligam.");
  out.push("9. **Sem repetições.** Uma notificação por pessoa × tipo × registo dentro de uma janela curta (30 min; resumos diários 12 h). Sem registo, conta a mesma mensagem (título + texto).");
  out.push("10. **Sino.** Filtro por tipo e a cidade de cada aviso.");
  out.push("");
  out.push("## Tabela (omissões do código)");
  out.push("");
  out.push("O Super Admin entra sempre; o Admin entra sozinho quando a matriz lhe dá o módulo. \"Pessoal\" = só a pessoa a quem se refere.");
  out.push("");
  const groups = Object.keys(NOTIFICATION_GROUP_LABELS) as NotificationGroup[];
  for (const g of groups) {
    const list = rows.filter((r) => r.group === g);
    if (!list.length) continue;
    out.push(`### ${NOTIFICATION_GROUP_LABELS[g]}`);
    out.push("");
    out.push("| Tipo | Chave | Módulo (ação) | Âmbito | Quem recebe | Email | Obrigatória | Quando |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const r of list) {
      const who = r.personal ? "Pessoal" : r.roles.map((x) => ROLE_LABELS[x]).join(", ");
      const email = r.email ? (r.emailDefault ? "sim (ligado)" : "sim (desligado)") : "—";
      const scope = r.personal ? "a pessoa" : r.cityScoped ? "por cidade" : "nacional";
      out.push(`| ${r.label} | \`${r.kind}\` | ${moduleLabel(r.module)} (${r.action}) | ${scope} | ${who} | ${email} | ${r.mandatory ? "sim" : "não"} | ${KIND_SOURCES[r.kind] ?? ""} |`);
    }
    out.push("");
  }
  out.push("## O que continua fora do sino");
  out.push("");
  out.push("- Avisos **ao próprio** por WhatsApp/email que já existiam: escala dos extras (aviso de trabalho), pedidos de disponibilidade, lembrete de formação por email, email da tarefa ao criador.");
  out.push("- Relatórios por email com destinatários próprios (já por cidade/módulo): briefing diário, relatórios semanais, email da passagem de turno.");
  out.push("- `system.notifyOwner` (ferramenta manual de admin que envia um email ao OWNER_EMAIL).");
  out.push("");
  out.push("## Limpeza única (migração 0140)");
  out.push("");
  out.push("No primeiro arranque depois desta mudança, as notificações **por ler com mais de 14 dias** passam a lidas (o sino deixa de estar inundado pelos avisos antigos, que iam a toda a gente). Corre uma só vez: fica marcada em `app_notification_maintenance` (`0140_mark_old_read`). As notificações não são apagadas.");
  out.push("");
  out.push("## Tipos antigos");
  out.push("");
  out.push("Silenciamentos guardados com os tipos antigos são convertidos: `extras` → faltam condutores, respostas ao aviso de escala, passagem em falta; `complaint` → os três de reclamações; `case_sla` → ocorrências/perdidos fora do prazo; `training` → os três de formação; `sync`/`integration` → sistema.");
  out.push("");
  return out.join("\n");
}
