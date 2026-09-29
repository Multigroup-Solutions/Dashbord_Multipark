// Catálogo de permissões por UTILIZADOR (pedido Jorge 2026-08-06): para além
// do role, cada utilizador pode receber (grant) ou perder (deny) capacidades
// específicas. O servidor guarda os overrides em user_permissions; o que não
// tem override segue o comportamento por defeito descrito aqui.

export type PermissionId =
  | "extras_dia.team_leader"
  | "finance.view_totals"
  | "city.extra.lisbon"
  | "city.extra.porto"
  | "city.extra.faro"
  | "city.all";

export type PermissionDef = {
  id: PermissionId;
  label: string;
  description: string;
  category: "Operações" | "Financeiro" | "Cidades";
  /** O que acontece SEM override */
  defaultBehavior: string;
};

export const PERMISSIONS: PermissionDef[] = [
  {
    id: "extras_dia.team_leader",
    label: "Pode ser Team Leader na escala",
    description:
      "Pode ser escolhido como Team Leader na escala do Extras-Dia. Um extra normal não aparece na lista de TL; com esta permissão passa a aparecer. NÃO dá acessos de team leader na aplicação (o papel da conta é que decide).",
    category: "Operações",
    defaultBehavior: "Só posições team_leader, supervisor e director aparecem como TL.",
  },
  {
    id: "finance.view_totals",
    label: "Ver totais financeiros",
    description:
      "Vê receitas, totais de despesas e dashboards financeiros. Negar esta permissão deixa a pessoa registar e ver as PRÓPRIAS despesas, mas sem ver os totais da empresa. Dar (grant) abre os totais a um supervisor, frontoffice ou backoffice.",
    category: "Financeiro",
    defaultBehavior: "Admin e super_admin veem os totais (módulo Financeiro); negar retira; dar abre a supervisor/front/backoffice.",
  },
  {
    id: "city.extra.lisbon",
    label: "Acesso extra: Lisboa",
    description: "Além da cidade do seu centro de custos, também vê os parques de Lisboa.",
    category: "Cidades",
    defaultBehavior: "Cada um vê a cidade do seu centro de custos.",
  },
  {
    id: "city.extra.porto",
    label: "Acesso extra: Porto",
    description: "Além da cidade do seu centro de custos, também vê os parques do Porto.",
    category: "Cidades",
    defaultBehavior: "Cada um vê a cidade do seu centro de custos.",
  },
  {
    id: "city.extra.faro",
    label: "Acesso extra: Faro",
    description: "Além da cidade do seu centro de custos, também vê os parques de Faro.",
    category: "Cidades",
    defaultBehavior: "Cada um vê a cidade do seu centro de custos.",
  },
  {
    id: "city.all",
    label: "Todas as cidades",
    description: "Acrescenta acesso a todas as cidades. Exige sempre um centro de custos válido.",
    category: "Cidades",
    defaultBehavior: "O centro de custos de grupo concede todas. Os restantes precisam de autorização explícita e de centro de custos válido.",
  },
];

export const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);
