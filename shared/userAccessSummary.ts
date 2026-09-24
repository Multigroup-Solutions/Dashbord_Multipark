import { PERMISSIONS } from './permissions';
import { ROLE_LABELS, ROLE_RANK, canSeeFinanceTotalsFor, isNationalRole } from './access';

export const USER_ROLE_LABELS: Record<string, string> = { ...ROLE_LABELS };
const rank: Record<string, number> = { ...ROLE_RANK };

export function userAccessSummary(role: string, overrides: Record<string, string>, cities?: { all: boolean; missingCostCenter: boolean; cityNames?: string[]; cityName?: string }) {
  // O grant extras_dia.team_leader já não eleva o papel (só a escala do Extras-Dia).
  const effectiveRole = role;
  const permissions = PERMISSIONS.map(p => {
    const mode = overrides[p.id] ?? 'default';
    const baseline = p.id === 'extras_dia.team_leader' ? (rank[role] ?? 0) >= rank.team_leader
      : p.id === 'finance.view_totals' ? canSeeFinanceTotalsFor(role, {}) : false;
    const cityName = ({ 'city.extra.lisbon': 'lisboa', 'city.extra.porto': 'porto', 'city.extra.faro': 'faro' } as Record<string, string>)[p.id];
    const cityEnabled = !!cities && !cities.missingCostCenter && (cities.all || isNationalRole(role) || (cityName != null && (cities.cityNames ?? [cities.cityName ?? '']).some(n => n.toLowerCase() === cityName)));
    return { id: p.id, label: p.label, mode,
      enabled: p.id.startsWith('city.') && cities ? cityEnabled : mode === 'deny' ? false : mode === 'grant' || baseline,
      additional: mode === 'grant' && !baseline };
  });
  const warnings = permissions.filter(p => p.additional).map(p => `Permissão adicional: ${p.label}.`);
  if ((rank[role] ?? 0) >= rank.admin) warnings.push('Perfil administrativo: permite gerir configurações e dados nas cidades autorizadas.');
  return { role, effectiveRole, permissions, warnings };
}
