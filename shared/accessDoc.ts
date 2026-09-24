/**
 * Gera docs/permissoes.md a partir da matriz de shared/access.ts — a tabela
 * do documento é SEMPRE a que o servidor aplica. Regenerar com
 * `pnpm tsx scripts/gen-permissoes-doc.ts`; o teste server/accessMatrix.test.ts
 * falha se o ficheiro estiver desatualizado.
 */
import { MATRIX, MODULES, ROLES, ROLE_LABELS, type Access, type Action, type Grant } from "./access";

const ACCESS_LABEL: Record<Access, string> = {
  none: "—",
  own: "próprio",
  below_city: "equipa (cidade)",
  city: "cidade",
  national: "nacional",
};

const ACTION_LETTER: Record<Action, string> = { view: "V", edit: "E", export: "X", manage: "G" };

function cell(g: Grant): string {
  if (g.access === "none") return "—";
  const letters = (["view", "edit", "export", "manage"] as Action[]).filter(a => g.actions.includes(a)).map(a => ACTION_LETTER[a]).join("");
  return `${ACCESS_LABEL[g.access]} ${letters}`;
}

export function renderPermissoesDoc(): string {
  const out: string[] = [];
  out.push("# Permissões — modelo de acessos v2");
  out.push("");
  out.push("> Ficheiro gerado a partir de `shared/access.ts` (`pnpm tsx scripts/gen-permissoes-doc.ts`).");
  out.push("> Não editar à mão: alterar a matriz no código e regenerar. Um teste garante que está em dia.");
  out.push("");
  out.push("## Princípios");
  out.push("");
  out.push("- **Uma só fonte de verdade.** A matriz de `shared/access.ts` decide o menu (`DashboardLayout.tsx`) e o servidor (`requireAccess` em `server/_core/access.ts`). O que não está no menu também é recusado pela API.");
  out.push("- **Hierarquia.** Utilizador < Extra < Condutor < Team Leader < Supervisor < Frontoffice = Backoffice < Admin < Super Admin. Cada papel tem tudo o que os papéis abaixo têm, salvo indicação em contrário.");
  out.push("- **Alcance.** `próprio` = só o que é da pessoa (a sua ficha, as suas despesas, os casos em que é o condutor envolvido); `equipa (cidade)` = na sua cidade, o que é dele ou de quem está abaixo dele; `cidade` = tudo na sua cidade (centro de custos da ficha + cidades dadas por permissão); `nacional` = todas as cidades.");
  out.push("- **Ações.** V = ver · E = criar/alterar no dia a dia · X = exportar (Excel/PDF) · G = gerir (configuração, apagar, aprovar).");
  out.push("- **Cidade.** Supervisor, Team Leader, Condutor, Extra e Utilizador ficam limitados à sua cidade pelo servidor (`cityScope`); Frontoffice, Backoffice, Admin e Super Admin são nacionais.");
  out.push("");
  out.push("## Papéis");
  out.push("");
  out.push("| Papel | Resumo |");
  out.push("| --- | --- |");
  const summary: Record<string, string> = {
    user: "A própria ficha (documentos e dados pessoais), Formação e Disponibilidade.",
    extra: "Utilizador + a própria Avaliação, Serviços pendentes, o próprio Histórico diário, PDAs (registar o seu), Tarefas e as próprias ocorrências/reclamações/críticas.",
    condutor: "Extra + as próprias Despesas, Reservas & Operações e Extras-dia da cidade (ver), os próprios Perdidos e Achados.",
    team_leader: "Condutor + Despesas dele e da equipa, Parcerias, RH da equipa, Leads de extras, Formação (gestão da equipa), Avaliação da equipa, Serviços/Actividade diária/Tarefas da cidade, preencher Extras-dia, Passagem de turno (sem o Resumo do dia), Disponibilidade dos extras, WhatsApp, Clientes e o Suporte da cidade.",
    supervisor: "Team Leader + Utilizadores da cidade (sem tocar em admins), Permissões (não de admins), Sincronização e Integrações — tudo na sua cidade.",
    frontoffice: "Backoffice sem Permissões.",
    backoffice: "Supervisor com alcance nacional.",
    admin: "Backoffice + Permissões de quem está abaixo dele, Financeiro (sem Faturação) e Dashboards. Sem Marketing, Logs nem Faturação.",
    super_admin: "Tudo (inclui Marketing, Logs, Faturação, API Keys e manutenção).",
  };
  for (const r of ROLES) out.push(`| ${ROLE_LABELS[r]} (\`${r}\`) | ${summary[r]} |`);
  out.push("");
  out.push("## Matriz");
  out.push("");
  out.push(`| Módulo | ${ROLES.map(r => ROLE_LABELS[r]).join(" | ")} |`);
  out.push(`| --- | ${ROLES.map(() => "---").join(" | ")} |`);
  const groups = [...new Set(MODULES.map(m => m.group))];
  for (const group of groups) {
    out.push(`| **${group}** | ${ROLES.map(() => "").join(" | ")} |`);
    for (const m of MODULES.filter(x => x.group === group)) {
      out.push(`| ${m.label} | ${ROLES.map(r => cell(MATRIX[m.id][r])).join(" | ")} |`);
    }
  }
  out.push("");
  out.push("## Regras adicionais");
  out.push("");
  out.push("- **Permissão \"Pode ser Team Leader na escala\"** (`extras_dia.team_leader`): só torna a pessoa elegível como TL na escala do Extras-Dia. Não dá nenhum acesso de team leader na aplicação — é o papel da conta que decide.");
  out.push("- **Papel Condutor**: novo (migração 0096). Nenhuma conta existente é convertida automaticamente; a passagem a condutor faz-se à mão em Utilizadores.");
  out.push("- **Utilizadores**: o supervisor gere as contas da sua cidade até supervisor; frontoffice/backoffice até backoffice; admin tudo abaixo de admin; super_admin tudo. Ninguém mexe em contas acima de si.");
  out.push("- **Permissões**: supervisor e backoffice dão/retiram permissões a qualquer conta que não seja admin/super_admin; admin a quem está abaixo dele; super_admin a todos. Frontoffice não tem Permissões. As cidades extra (`city.*`) só as dá quem é nacional e os totais financeiros só quem tem o Financeiro.");
  out.push("- **Totais financeiros** (`finance.view_totals`): por defeito só admin/super_admin (módulo Financeiro). Um deny retira-os; um grant abre-os a supervisor, frontoffice ou backoffice.");
  out.push("- **Marketing, Logs e Faturação**: só super_admin (correção do dono).");
  out.push("- **Despesas do Team Leader**: as dele e as registadas por contas abaixo dele (condutores, extras, utilizadores) na sua cidade.");
  out.push("- **RH do Team Leader**: fichas da sua cidade de quem está abaixo dele; fichas sem conta contam pelo posto (extra, condutor, condutor sénior).");
  out.push("");
  return out.join("\n");
}
