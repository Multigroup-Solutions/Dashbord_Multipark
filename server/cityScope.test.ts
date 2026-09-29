import { describe, expect, it } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
import { applyCityPermissions, hasForeignCityFilter, resolveCityAccess, scopeCityQuery } from './cityAccess';
import { cityScope, projectScope, bookingHistoryScope, cityNameScope, assertProjectAccess, scopedProjectIds } from './cityScope';
import { canSeeExpense, expenseConditions } from './expenseScope';
import { userAccessSummary } from '../shared/userAccessSummary';

const nodes = [
  { id: 48, name: 'Multipark', level: 'group', parentId: null },
  { id: 49, name: 'Lisboa', level: 'city', parentId: 48 },
  { id: 50, name: 'Porto', level: 'city', parentId: 48 },
  { id: 51, name: 'Faro', level: 'city', parentId: 48 },
  { id: 65, name: 'Parque Porto', level: 'project', parentId: 50 },
];
const porto = resolveCityAccess(50, nodes);
const lisboa = resolveCityAccess(49, nodes);
const compile = (value: ReturnType<typeof sql>) => new MySqlDialect().sqlToQuery(value);

describe('âmbito de cidades por pedido', () => {
  it('isola pedidos concorrentes e limpa o âmbito no fim', async () => {
    const values = await Promise.all([porto, lisboa].map(access => cityScope.run(access, async () => {
      await Promise.resolve();
      return scopedProjectIds();
    })));
    expect(values).toEqual([[50, 65], [49]]);
    expect(scopedProjectIds()).toBeUndefined();
  });
  it('o filtro SQL contém os descendentes e bloqueia âmbito vazio', () => {
    cityScope.run(porto, () => {
      expect(compile(projectScope(sql`projectId`)).params).toEqual([50, 65]);
      expect(compile(bookingHistoryScope(sql`history.bookingExternalId`))).toMatchObject({ params: [50, 65] });
      expect(compile(bookingHistoryScope(sql`history.bookingExternalId`)).sql).toContain('city_booking.externalId = history.bookingExternalId');
    });
    cityScope.run(resolveCityAccess(null, nodes), () => expect(compile(projectScope(sql`projectId`)).sql).toBe('1 = 0'));
  });
  it('aceita os aliases das cidades sem inferir pessoas', () => {
    cityScope.run(lisboa, () => expect(compile(cityNameScope(sql`city`)).params).toEqual(['lisboa', 'lisbon']));
  });
  it('o Extras Dia sem filtro recebe a cidade do centro, incluindo nas novas escalas', () => {
    for (const path of ['extrasDia.forecast', 'extrasDia.bookingsInSlot', 'extrasDia.upsertAssignment']) {
      expect(scopeCityQuery(path, porto, {})).toEqual({ city: 'porto' });
      expect(scopeCityQuery(path, lisboa, {})).toEqual({ city: 'lisbon' });
    }
  });
  it('a cidade restringe despesas próprias, administradores, totais e exportação', () => cityScope.run(porto, () => {
    expect(canSeeExpense({ kind: 'all' }, { insertedById: 7, projectId: 49 })).toBe(false);
    expect(canSeeExpense({ kind: 'own', userId: 7 }, { insertedById: 7, projectId: 49 })).toBe(false);
    expect(canSeeExpense({ kind: 'all' }, { insertedById: 7, projectId: 65 })).toBe(true);
    expect(() => assertProjectAccess(null)).toThrow();
    expect(() => assertProjectAccess(49)).toThrow();
    expect(compile(expenseConditions({}, { kind: 'all' })[0]).params).toEqual([50, 65]);
  }));
});

describe('autorizações adicionais e avisos na ficha', () => {
  it('um grant de Lisboa alarga Porto só a Lisboa', () => {
    const access = applyCityPermissions(porto, nodes, { 'city.extra.lisbon': 'grant' });
    expect(access.cityIds).toEqual([49, 50]);
    expect(hasForeignCityFilter(access, { city: 'Lisbon' })).toBe(false);
    expect(hasForeignCityFilter(access, { city: 'Faro' })).toBe(true);
    expect(access.all).toBe(false);
  });
  it('nem city.all permite entrar sem centro válido', () => {
    expect(applyCityPermissions(resolveCityAccess(null, nodes), nodes, { 'city.all': 'grant' }).missingCostCenter).toBe(true);
    expect(applyCityPermissions(porto, nodes, { 'city.all': 'grant' }).all).toBe(true);
  });
  it('a remoção de uma autorização não deixa acesso residual', () => {
    const denied = applyCityPermissions(porto, nodes, { 'city.all': 'grant', 'city.extra.faro': 'deny' });
    expect(denied.cityIds).toEqual([49, 50]);
    expect(denied.all).toBe(false);
    expect(applyCityPermissions(porto, nodes, {}).cityIds).toEqual([50]);
  });
  it('mostra a elevação real e identifica grants sem classificar todos como excessivos', () => {
    const result = userAccessSummary('extra', { 'extras_dia.team_leader': 'grant', 'city.extra.lisbon': 'grant', 'finance.view_totals': 'deny' });
    // o grant de TL só marca elegibilidade na escala — o papel não sobe
    expect(result.effectiveRole).toBe('extra');
    expect(result.warnings).toHaveLength(2);
    expect(result.permissions.find(p => p.id === 'finance.view_totals')?.enabled).toBe(false);
    expect(userAccessSummary('extra', {}).warnings).toEqual([]);
  });
  it('o resumo distingue a cidade do centro das cidades sem acesso', () => {
    const permissions = userAccessSummary('extra', {}, porto).permissions;
    expect(permissions.find(p => p.id === 'city.extra.porto')?.enabled).toBe(true);
    expect(permissions.find(p => p.id === 'city.extra.faro')?.enabled).toBe(false);
    expect(permissions.find(p => p.id === 'city.all')?.enabled).toBe(false);
  });
});
