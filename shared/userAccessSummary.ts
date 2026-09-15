import { PERMISSIONS } from './permissions';

export const USER_ROLE_LABELS: Record<string, string> = {
  user: 'Utilizador', extra: 'Extra', frontoffice: 'Frontoffice', backoffice: 'Backoffice',
  team_leader: 'Chefe de turno', supervisor: 'Supervisor', admin: 'Administrador', super_admin: 'Super administrador',
};
const rank: Record<string, number> = { user: 0, extra: 1, frontoffice: 2, backoffice: 3, team_leader: 4, supervisor: 5, admin: 6, super_admin: 7 };

export function userAccessSummary(role: string, overrides: Record<string, string>, cities?: { all: boolean; missingCostCenter: boolean; cityNames?: string[]; cityName?: string }) {
  const elevated = (rank[role] ?? 0) < rank.team_leader && overrides['extras_dia.team_leader'] === 'grant';
  const effectiveRole = elevated ? 'team_leader' : role;
  const permissions = PERMISSIONS.map(p => {
    const mode = overrides[p.id] ?? 'default';
    const baseline = p.id === 'extras_dia.team_leader' ? (rank[role] ?? 0) >= rank.team_leader
      : p.id === 'finance.view_totals' ? (rank[role] ?? 0) >= rank.backoffice : false;
    const cityName = ({ 'city.extra.lisbon': 'lisboa', 'city.extra.porto': 'porto', 'city.extra.faro': 'faro' } as Record<string, string>)[p.id];
    const cityEnabled = !!cities && !cities.missingCostCenter && (cities.all || (cityName != null && (cities.cityNames ?? [cities.cityName ?? '']).some(n => n.toLowerCase() === cityName)));
    return { id: p.id, label: p.label, mode,
      enabled: p.id.startsWith('city.') && cities ? cityEnabled : mode === 'deny' ? false : mode === 'grant' || baseline,
      additional: mode === 'grant' && !baseline };
  });
  const warnings = permissions.filter(p => p.additional).map(p => `Permissão adicional: ${p.label}.`);
  if (elevated) warnings.push('O acesso de chefe de turno também eleva o perfil efetivo nas operações.');
  if ((rank[role] ?? 0) >= rank.admin) warnings.push('Perfil administrativo: permite gerir configurações e dados nas cidades autorizadas.');
  return { role, effectiveRole, permissions, warnings };
}
