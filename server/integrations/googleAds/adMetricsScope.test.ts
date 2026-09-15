import { expect, it, vi } from 'vitest';
const select = vi.hoisted(() => vi.fn(() => { throw new Error('Não deve consultar campanhas fora de um âmbito vazio'); }));
vi.mock('../../db', () => ({ getDb: async () => ({ select }) }));
import { getAdMetrics } from './adMetrics';
it('uma lista de projetos vazia não se transforma em todas as cidades', async () => {
  const result = await getAdMetrics({ from: '2026-09-01', to: '2026-09-15', projectIds: [] });
  expect(result.byCampaign).toEqual([]);
  expect(result.totals.cost).toBe(0);
  expect(select).not.toHaveBeenCalled();
});
