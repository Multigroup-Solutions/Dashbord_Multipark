/**
 * CÓDIGO LEGADO — só para a comparação antes/depois (scripts/finance-parity.ts).
 *
 * São as funções getBillingData e getAnnualBreakdown tal como estavam em
 * server/db.ts antes do motor único (server/finance/engine.ts), movidas para
 * aqui SEM alterações de lógica. NÃO são usadas pela aplicação. Apagar depois
 * de validada a paridade nos meses fechados.
 */
import { and, eq, gte, lte, sql, isNotNull, inArray, notInArray } from "drizzle-orm";
import {
  multiparkBookings, projects, expenses, expenseCategories, extrasDiaAssignments,
  partnerships, partnerAliases, employees, marketingExpenses, campaignDailyStats, campaigns,
} from "../../drizzle/schema";
import {
  getDb, resolveProjectIds, toMysqlDateTime, bucketSqlExpr, EXTRAS_DIA_RATES,
  getPayrollData, getFinancialHistory,
} from "../db";

export async function legacyBillingData(filters: {
  from: string;
  to: string;
  projectId?: number;
  granularity?: "day" | "week" | "month" | "year";
}) {
  const db = await getDb();
  const granularity = filters.granularity ?? "day";
  if (!db) {
    return {
      summary: {
        produced: 0, invoiced: 0,
        expensesPaid: 0, expensesPending: 0,
        extrasDiaCost: 0, marketingCost: 0, partnerCommissionsPaid: 0, partnerCommissionsPending: 0,
        totalCostsPaid: 0, totalCostsAll: 0,
        marginRealized: 0, marginAll: 0,
      },
      timeseries: [],
      deliveries: [], expensesPaid: [], expensesPending: [], forecast: [],
      invoices: [], extrasDia: [], marketing: [], partnerCommissions: [],
      forecastBookings: [], forecastExpenses: [], forecastExtrasDia: [],
    };
  }

  const fromStr = toMysqlDateTime(new Date(filters.from));
  const toStr = toMysqlDateTime(new Date(filters.to + "T23:59:59"));
  const fromDateOnly = filters.from;
  const toDateOnly = filters.to;

  // Hierarquia de projetos
  let projectIds: number[] | undefined;
  if (filters.projectId) projectIds = await resolveProjectIds(filters.projectId);

  // ─── 1. ENTREGUES + RECOLHIDOS (modelo do Jorge, 2026-08-04) ─────────────
  // FONTE ÚNICA de receita = multipark_bookings.totalPrice (valor da reserva).
  // ENTREGUES = carro JÁ SAIU no período (checkOut no período + status
  //   CHECKED_OUT) — o valor "já cá está", é a receita realizada e a base
  //   da margem. (No modelo antigo chamava-se "faturado".)
  // RECOLHIDOS = carro ENTROU no período (checkIn no período + status de
  //   recolha em diante) — angariação em curso.
  // O cancelledAt não é fiável (4.6k canceladas sem ele) → filtros por status.
  const DELIVERED_STATUSES = ["CHECKED_OUT"];
  const COLLECTED_STATUSES = ["CHECKED_IN", "CHECKING_OUT", "PENDING_CHECKOUT", "CHECKED_OUT"];

  const deliveryConds: any[] = [
    gte(multiparkBookings.checkOut, fromStr),
    lte(multiparkBookings.checkOut, toStr),
    inArray(multiparkBookings.status, DELIVERED_STATUSES),
  ];
  if (projectIds) deliveryConds.push(inArray(multiparkBookings.projectId, projectIds));

  const deliveryRows = await db
    .select({
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      parkingRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.parkingPrice}), 0)`,
      deliveryCharges: sql<number>`COALESCE(SUM(${multiparkBookings.deliveryCharges}), 0)`,
      extrasRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.extrasTotal}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...deliveryConds))
    .groupBy(multiparkBookings.projectId, projects.name);

  const collectedConds: any[] = [
    gte(multiparkBookings.checkIn, fromStr),
    lte(multiparkBookings.checkIn, toStr),
    inArray(multiparkBookings.status, COLLECTED_STATUSES),
  ];
  if (projectIds) collectedConds.push(inArray(multiparkBookings.projectId, projectIds));

  const collectedRows = await db
    .select({
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...collectedConds))
    .groupBy(multiparkBookings.projectId, projects.name);

  // Receita produzida por projeto (folha) no período — usada para calcular
  // a comissão dos parceiros operacionais (secção 7b).
  const revenueByProjectId = new Map<number, number>();
  for (const r of deliveryRows) {
    if (r.projectId != null) revenueByProjectId.set(r.projectId, Number(r.totalRevenue ?? 0));
  }

  // (O antigo "Faturado" — tabela invoices manual — saiu: a faturação real
  //  vive no programa da Multipark e a tabela esteve sempre vazia. A receita
  //  vem só das reservas.)

  // ─── 3. DESPESAS INSERIDAS (expenseDate no período) ──────────────────────
  // Contabiliza as despesas LANÇADAS no período (data da despesa),
  // independentemente de já estarem pagas. Exclui apenas as canceladas.
  const insertedConds: any[] = [
    sql`${expenses.status} != 'cancelled'`,
    gte(expenses.expenseDate, fromStr),
    lte(expenses.expenseDate, toStr),
  ];
  if (projectIds) insertedConds.push(inArray(expenses.projectId, projectIds));

  const expPaidRows = await db
    .select({
      projectId: expenses.projectId,
      projectName: projects.name,
      categoryName: expenseCategories.name,
      count: sql<number>`COUNT(*)`,
      totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...insertedConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name);

  // ─── 4. DESPESAS PENDENTES (vencimento no período) ───────────────────────
  const pendConds: any[] = [
    inArray(expenses.status, ["pending", "overdue"]),
    isNotNull(expenses.paymentDueDate),
    gte(expenses.paymentDueDate, fromStr),
    lte(expenses.paymentDueDate, toStr),
  ];
  if (projectIds) pendConds.push(inArray(expenses.projectId, projectIds));

  const expPendRows = await db
    .select({
      projectId: expenses.projectId,
      projectName: projects.name,
      categoryName: expenseCategories.name,
      supplier: expenses.supplier,
      count: sql<number>`COUNT(*)`,
      totalAmount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .leftJoin(projects, eq(expenses.projectId, projects.id))
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(and(...pendConds))
    .groupBy(expenses.projectId, projects.name, expenseCategories.name, expenses.supplier);

  // ─── 5. EXTRAS-DIA (custo da equipa diária) ──────────────────────────────
  const extrasRows = await db
    .select({
      level: extrasDiaAssignments.level,
      hours: sql<number>`COALESCE(SUM(GREATEST(${extrasDiaAssignments.endHour} - ${extrasDiaAssignments.startHour}, 0)), 0)`,
      headcount: sql<number>`COUNT(*)`,
    })
    .from(extrasDiaAssignments)
    .where(
      and(
        gte(extrasDiaAssignments.assignmentDate, fromDateOnly),
        lte(extrasDiaAssignments.assignmentDate, toDateOnly),
      ),
    )
    .groupBy(extrasDiaAssignments.level);

  const extrasDiaSummary = extrasRows.map((r) => {
    const rate = EXTRAS_DIA_RATES[String(r.level ?? "junior")] ?? 4;
    const hours = Number(r.hours ?? 0);
    return {
      level: r.level ?? "junior",
      hours,
      headcount: Number(r.headcount ?? 0),
      cost: hours * rate,
    };
  });

  // (Marketing saiu da Faturação por decisão do Jorge 2026-08-04: as faturas
  //  do Google/fornecedores entram pelas Despesas normais — contá-las aqui
  //  outra vez seria dupla contagem. O detalhe de marketing vê-se no módulo
  //  de Marketing.)

  // ─── 7a. PARCEIROS DE VENDA (comissões calculadas via campaign matching) ──
  // IMPORTANTE: NÃO fazemos INNER JOIN entre bookings e partnerships porque,
  // se existirem várias partnerships com o mesmo campaignKey, cada reserva
  // seria contada N vezes (Cartesian product). Em vez disso:
  //   1) agrupamos as reservas no SQL por (campaign, projectId);
  //   2) carregamos as partnerships com campaignKey à parte;
  //   3) fazemos o match e o cálculo de comissão em memória.
  const bookingsByCampaignRows = await db
    .select({
      campaign: multiparkBookings.campaign,
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      bookingsCount: sql<number>`COUNT(*)`,
      revenueGross: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...deliveryConds, isNotNull(multiparkBookings.campaign)))
    .groupBy(multiparkBookings.campaign, multiparkBookings.projectId, projects.name);

  // Carrega TODAS as partnerships e os aliases associados. Cada parceiro
  // tem geralmente vários códigos — um por (cidade × marca) — e tudo está em
  // partner_aliases. Construímos um único map que aponta de qualquer chave
  // possível (campaignKey, nome do parceiro, partnerId/paymentMethod alias)
  // para a partnership, para que o match seja robusto independentemente
  // do que ficou gravado em multipark_bookings.campaign.
  const allPartners = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      campaignKey: partnerships.campaignKey,
      commissionRate: partnerships.commissionRate,
      updatedAt: partnerships.updatedAt,
    })
    .from(partnerships);

  const allAliases = await db
    .select({
      partnershipId: partnerAliases.partnershipId,
      aliasValue: partnerAliases.aliasValue,
    })
    .from(partnerAliases);

  type PartnerSummary = { id: number; name: string; commissionRate: number; updatedAt: string };
  const partnersById = new Map<number, PartnerSummary>();
  for (const p of allPartners) {
    partnersById.set(p.id, {
      id: p.id,
      name: p.name,
      commissionRate: Number(p.commissionRate ?? 0),
      updatedAt: p.updatedAt ?? "",
    });
  }

  const partnerByCampaign = new Map<string, PartnerSummary>();
  function registerKey(rawKey: string | null, partnerId: number) {
    if (!rawKey) return;
    const key = rawKey.trim().toLowerCase();
    if (!key) return;
    const partner = partnersById.get(partnerId);
    if (!partner) return;
    const existing = partnerByCampaign.get(key);
    if (!existing || partner.updatedAt > existing.updatedAt) {
      partnerByCampaign.set(key, partner);
    }
  }
  // Regista campaignKey e nome
  for (const p of allPartners) {
    registerKey(p.campaignKey, p.id);
    registerKey(p.name, p.id);
  }
  // Regista cada alias (partnerId ou paymentMethod)
  for (const a of allAliases) {
    registerKey(a.aliasValue, a.partnershipId);
  }

  // Consolida por (parceiro, projecto): se duas campaigns diferentes
  // apontarem ao mesmo parceiro, somam-se receitas/contagens em vez de
  // aparecerem 2 linhas separadas.
  const salesAgg = new Map<string, {
    partnerId: number;
    partnerName: string;
    projectId: number | null;
    projectName: string | null;
    bookingsCount: number;
    revenueGross: number;
    commissionRate: number;
    commission: number;
  }>();
  for (const r of bookingsByCampaignRows) {
    const cmpKey = (r.campaign ?? "").trim().toLowerCase();
    const partner = partnerByCampaign.get(cmpKey);
    if (!partner) continue; // sem partnership associada → ignorar
    const revenueGross = Number(r.revenueGross ?? 0);
    const rate = partner.commissionRate / 100;
    const key = `${partner.id}|${r.projectId ?? "null"}`;
    const ex = salesAgg.get(key);
    if (ex) {
      ex.bookingsCount += Number(r.bookingsCount ?? 0);
      ex.revenueGross += revenueGross;
      ex.commission += revenueGross * rate;
    } else {
      salesAgg.set(key, {
        partnerId: partner.id,
        partnerName: partner.name,
        projectId: r.projectId,
        projectName: r.projectName,
        bookingsCount: Number(r.bookingsCount ?? 0),
        revenueGross,
        commissionRate: partner.commissionRate,
        commission: revenueGross * rate,
      });
    }
  }
  const salesCommissions = Array.from(salesAgg.values()).sort((a, b) => b.commission - a.commission);

  // ─── 7b. PARCEIROS OPERACIONAIS (config operatesProjects) ────────────────
  // O parceiro operacional (ex.: Top Parking nas marcas do Porto) está
  // alocado, na sua ficha, aos projetos que opera (cfg.operatesProjects).
  // A comissão é um CUSTO calculado sobre TODAS as reservas produzidas
  // nesses projetos no período × commissionRate%. Já não depende das
  // partnership_invoices nem de inferir o projeto pelo nome.
  const { parsePartnerConfig: parseOpPartnerConfig } = await import("../../shared/partnerTypes");
  const opPartnerRows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      partnerType: partnerships.partnerType,
      commissionRate: partnerships.commissionRate,
      notes: partnerships.notes,
    })
    .from(partnerships)
    .where(eq(partnerships.partnerType, "operacional"));

  const operationalPartners: Array<{
    partnershipId: number;
    partnerName: string | null;
    partnerType: string | null;
    projectNames: string[];
    bookingsCount: number;
    revenueGross: number;
    commissionRate: number;
    commission: number;
  }> = [];
  for (const p of opPartnerRows) {
    const cfg = parseOpPartnerConfig(p.notes ?? null);
    const roots = cfg.operatesProjects ?? [];
    if (roots.length === 0) continue;
    // Expande cada raiz (Grupo/Cidade/Marca) para as folhas e respeita o
    // filtro de projeto activo (projectIds).
    const leaves = new Set<number>();
    for (const root of roots) {
      const ids = await resolveProjectIds(root);
      for (const pid of ids) {
        if (!projectIds || projectIds.includes(pid)) leaves.add(pid);
      }
    }
    if (leaves.size === 0) continue;
    let revenue = 0, bookingsCount = 0;
    const projNames: string[] = [];
    for (const dr of deliveryRows) {
      if (dr.projectId != null && leaves.has(dr.projectId)) {
        revenue += Number(dr.totalRevenue ?? 0);
        bookingsCount += Number(dr.count ?? 0);
        if (dr.projectName) projNames.push(dr.projectName);
      }
    }
    const rate = Number(p.commissionRate ?? 0);
    operationalPartners.push({
      partnershipId: p.id,
      partnerName: p.name,
      partnerType: p.partnerType,
      projectNames: projNames,
      bookingsCount,
      revenueGross: revenue,
      commissionRate: rate,
      commission: revenue * (rate / 100),
    });
  }
  operationalPartners.sort((a, b) => b.commission - a.commission);
  const operationalPartnersTotal = operationalPartners.reduce((s, p) => s + p.commission, 0);

  // ─── 7c. SALÁRIOS rateados ao dia, atribuídos ao projecto do colaborador ──
  // Empregados com salário fixo (não-extra). O salário mensal é proporcional
  // ao nº de dias do período. Se o empregado está num nível hierárquico
  // (Grupo / Cidade / Marca), o custo é distribuído equitativamente pelos
  // descendentes que sejam folha (level='project').
  const allEmps = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      projectId: employees.projectId,
      contractType: employees.contractType,
      monthlySalary: employees.monthlySalary,
      isActive: employees.isActive,
    })
    .from(employees)
    .where(eq(employees.isActive, 1));

  const allProjectsForHierarchy = await db
    .select({ id: projects.id, name: projects.name, parentId: projects.parentId, level: projects.level })
    .from(projects);
  const childrenMap = new Map<number, number[]>();
  for (const p of allProjectsForHierarchy) {
    if (p.parentId != null) {
      if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
      childrenMap.get(p.parentId)!.push(p.id);
    }
  }
  function leafDescendants(projectId: number): number[] {
    const self = allProjectsForHierarchy.find(p => p.id === projectId);
    if (!self) return [];
    if (self.level === "project") return [projectId];
    const kids = childrenMap.get(projectId) ?? [];
    if (kids.length === 0) return [projectId]; // sem filhos: fica no próprio
    const out: number[] = [];
    for (const kid of kids) out.push(...leafDescendants(kid));
    return out.length > 0 ? out : [projectId];
  }

  // Dias do período (inclusive)
  const msPerDay = 1000 * 60 * 60 * 24;
  const periodDays = Math.max(
    1,
    Math.floor((new Date(filters.to).getTime() - new Date(filters.from).getTime()) / msPerDay) + 1,
  );

  // Atribui salários por projecto (com rateio)
  const salaryPerProject = new Map<number, number>();
  const salaryDetailRows: Array<{ employeeId: number; fullName: string; projectId: number | null; cost: number; ratedTo: number[] }> = [];
  for (const e of allEmps) {
    const monthlySalary = parseFloat(String(e.monthlySalary ?? "0"));
    if (e.contractType === "extra" || monthlySalary <= 0) continue;
    const periodCost = (monthlySalary / 30) * periodDays;
    const directProjectId = e.projectId ?? null;

    let targets: number[];
    if (directProjectId == null) {
      targets = []; // sem projeto — não soma a nenhum (entra no custo "Geral" abaixo)
    } else {
      targets = leafDescendants(directProjectId);
    }

    if (targets.length === 0) {
      // Sem destino: regista como "sem alocação"
      salaryDetailRows.push({ employeeId: e.id, fullName: e.fullName, projectId: directProjectId, cost: periodCost, ratedTo: [] });
    } else if (targets.length === 1 && targets[0] === directProjectId) {
      const cur = salaryPerProject.get(targets[0]) ?? 0;
      salaryPerProject.set(targets[0], cur + periodCost);
      salaryDetailRows.push({ employeeId: e.id, fullName: e.fullName, projectId: directProjectId, cost: periodCost, ratedTo: targets });
    } else {
      // Empregado em nível superior → rateia equitativamente pelos folhas
      const share = periodCost / targets.length;
      for (const t of targets) {
        const cur = salaryPerProject.get(t) ?? 0;
        salaryPerProject.set(t, cur + share);
      }
      salaryDetailRows.push({ employeeId: e.id, fullName: e.fullName, projectId: directProjectId, cost: periodCost, ratedTo: targets });
    }
  }

  // Filtra salaryPerProject pelo projectId de input (hierarquia já resolvida)
  const salariesByProject = Array.from(salaryPerProject.entries())
    .filter(([pid]) => !projectIds || projectIds.includes(pid))
    .map(([pid, cost]) => {
      const p = allProjectsForHierarchy.find(x => x.id === pid);
      return { projectId: pid, projectName: p?.name ?? null, cost };
    })
    .sort((a, b) => b.cost - a.cost);

  // ─── 8. FORECAST: reservas futuras (checkin no futuro) ───────────────────
  // A previsão é sempre prospectiva: reservas com check-in a partir de agora,
  // ainda sem check-out e sem cancelamento. Se o período selecionado terminar
  // no passado/hoje, estende-se a janela 30 dias para a frente — caso
  // contrário a previsão daria sempre zero (não há check-ins futuros dentro
  // de um período já decorrido).
  const now = new Date();
  const forecastFromDate = now > new Date(filters.from) ? now : new Date(filters.from);
  let forecastToDate = new Date(filters.to + "T23:59:59");
  if (forecastToDate.getTime() <= now.getTime()) {
    forecastToDate = new Date(now.getTime() + 30 * msPerDay);
  }
  const forecastFrom = toMysqlDateTime(forecastFromDate);
  const forecastToStr = toMysqlDateTime(forecastToDate);
  // BUG antigo: exigia checkOut IS NULL, mas o checkOut é a data PREVISTA
  // (vem sempre preenchida da API) → a previsão dava sempre 0. E cancelledAt
  // não é fiável → filtra pelo status.
  const forecastConds: any[] = [
    gte(multiparkBookings.checkIn, forecastFrom),
    lte(multiparkBookings.checkIn, forecastToStr),
    notInArray(multiparkBookings.status, ["CANCELLED", ...COLLECTED_STATUSES]),
  ];
  if (projectIds) forecastConds.push(inArray(multiparkBookings.projectId, projectIds));

  const forecastRows = await db
    .select({
      projectId: multiparkBookings.projectId,
      projectName: projects.name,
      count: sql<number>`COUNT(*)`,
      totalRevenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .leftJoin(projects, eq(multiparkBookings.projectId, projects.id))
    .where(and(...forecastConds))
    .groupBy(multiparkBookings.projectId, projects.name);

  // ─── 9. TIMESERIES (granularity: day/week/month/year) ────────────────────
  const checkOutBucket = bucketSqlExpr(multiparkBookings.checkOut, granularity);
  const expenseDateBucket = bucketSqlExpr(expenses.expenseDate, granularity);
  const checkInBucket = bucketSqlExpr(multiparkBookings.checkIn, granularity);

  const tsProduced = await db
    .select({ bucket: checkOutBucket, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`, count: sql<number>`COUNT(*)` })
    .from(multiparkBookings)
    .where(and(...deliveryConds))
    .groupBy(checkOutBucket);

  const tsCollected = await db
    .select({ bucket: checkInBucket, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`, count: sql<number>`COUNT(*)` })
    .from(multiparkBookings)
    .where(and(...collectedConds))
    .groupBy(checkInBucket);

  const tsExpensesPaid = await db
    .select({ bucket: expenseDateBucket, total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)` })
    .from(expenses)
    .where(and(...insertedConds))
    .groupBy(expenseDateBucket);

  const tsForecast = await db
    .select({ bucket: checkInBucket, total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`, count: sql<number>`COUNT(*)` })
    .from(multiparkBookings)
    .where(and(...forecastConds))
    .groupBy(checkInBucket);

  // Totais de custos que não estão naturalmente distribuídos no tempo
  // (salários mensais, comissões de parceiros, equipa-dia). Distribuem-se
  // pelos buckets proporcionalmente ao produzido (ou em partes iguais se
  // não houver produção) para que o gráfico mostre TUDO como despesa e o
  // total bata certo com os KPIs.
  // FIX 2026-08-04: os salários agora respeitam o filtro de projeto
  // (antes somavam a empresa toda mesmo filtrando uma cidade). Sem filtro,
  // inclui também quem não tem projeto atribuído.
  const salariesUnallocated = salaryDetailRows
    .filter((r) => r.ratedTo.length === 0)
    .reduce((s, r) => s + r.cost, 0);
  const tsSalariesTotal =
    salariesByProject.reduce((s, r) => s + r.cost, 0) + (projectIds ? 0 : salariesUnallocated);
  const tsSalesTotal = salesCommissions.reduce((s, c) => s + c.commission, 0);
  const tsPartnersTotal = operationalPartnersTotal + tsSalesTotal;
  const tsExtrasTotal = extrasDiaSummary.reduce((s, r) => s + r.cost, 0);

  // Merge timeseries em um único array (chave = bucket)
  type TimeseriesPoint = {
    bucket: string;
    produced: number;        // entregues (carro saiu — receita realizada)
    collected: number;       // recolhidos (carro entrou)
    expenses: number;        // despesas inseridas no período
    salaries: number;        // ordenados (rateados)
    partners: number;        // parceiros operacionais + de venda
    extrasCost: number;      // equipa do dia (extras-dia)
    revenueForecast: number;
    totalCost: number;
    margin: number;
    // back-compat
    expensesPaid: number;
  };
  function emptyPoint(bk: string): TimeseriesPoint {
    return { bucket: bk, produced: 0, collected: 0, expenses: 0, salaries: 0, partners: 0, extrasCost: 0, revenueForecast: 0, totalCost: 0, margin: 0, expensesPaid: 0 };
  }
  const tsMap = new Map<string, TimeseriesPoint>();
  function bump(arr: any[], key: keyof Omit<TimeseriesPoint, "bucket">) {
    for (const r of arr) {
      const bk = r.bucket;
      if (!bk) continue;
      const ex = tsMap.get(bk) ?? emptyPoint(bk);
      (ex[key] as number) += Number(r.total ?? 0);
      tsMap.set(bk, ex);
    }
  }
  bump(tsProduced, "produced");
  bump(tsCollected, "collected");
  bump(tsExpensesPaid, "expenses");
  bump(tsForecast, "revenueForecast");

  // Distribui os custos não-temporais pelos buckets do produzido.
  const producedBuckets = tsProduced
    .filter((r: any) => r.bucket)
    .map((r: any) => ({ bucket: r.bucket as string, weight: Number(r.total ?? 0) }));
  const producedWeightSum = producedBuckets.reduce((s, b) => s + b.weight, 0);
  function distribute(total: number, key: keyof Omit<TimeseriesPoint, "bucket">) {
    if (!total) return;
    const useWeight = producedBuckets.length > 0 && producedWeightSum > 0;
    const targets = producedBuckets.length > 0
      ? producedBuckets
      : Array.from(tsMap.keys()).map((bk) => ({ bucket: bk, weight: 1 }));
    if (targets.length === 0) return;
    const weightSum = useWeight ? producedWeightSum : targets.length;
    for (const t of targets) {
      const share = total * ((useWeight ? t.weight : 1) / weightSum);
      const ex = tsMap.get(t.bucket) ?? emptyPoint(t.bucket);
      (ex[key] as number) += share;
      tsMap.set(t.bucket, ex);
    }
  }
  distribute(tsSalariesTotal, "salaries");
  distribute(tsPartnersTotal, "partners");
  distribute(tsExtrasTotal, "extrasCost");

  // Custo total e margem por bucket (back-compat: expensesPaid = expenses)
  for (const p of tsMap.values()) {
    p.totalCost = p.expenses + p.salaries + p.partners + p.extrasCost;
    p.margin = p.produced - p.totalCost;
    p.expensesPaid = p.expenses;
  }

  const timeseries = Array.from(tsMap.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));

  // ─── 10. SUMMARY ─────────────────────────────────────────────────────────
  // IVA e TSU alinhados com a página Anual: receita e despesas gravadas
  // COM IVA (23%); a margem verdadeira é calculada sobre valores líquidos.
  const VAT_RATE = 0.23;
  const TSU_EMPLOYER = 0.2375;

  const produced = deliveryRows.reduce((s, r) => s + Number(r.totalRevenue ?? 0), 0);
  const producedCount = deliveryRows.reduce((s, r) => s + Number(r.count ?? 0), 0);
  const collected = collectedRows.reduce((s, r) => s + Number(r.totalRevenue ?? 0), 0);
  const collectedCount = collectedRows.reduce((s, r) => s + Number(r.count ?? 0), 0);
  const expensesPaidTotal = expPaidRows.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const expensesPendingTotal = expPendRows.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const extrasDiaCost = extrasDiaSummary.reduce((s, r) => s + r.cost, 0);
  // Parceiros operacionais: comissão calculada sobre as reservas dos
  // projetos que operam (secção 7b). É um custo "sempre devido".
  const operationalPartnersPaid = operationalPartnersTotal;
  const operationalPartnersPending = 0;
  // Comissões a parceiros de venda — calculadas a partir das reservas.
  // Custo "sempre devido" assim que o checkout aconteceu.
  const salesCommissionsTotal = salesCommissions.reduce((s, r) => s + r.commission, 0);
  // Salários FILTRADOS pelo projeto (fix 2026-08-04) + TSU entidade patronal
  const totalSalaries = tsSalariesTotal;
  const employerTax = totalSalaries * TSU_EMPLOYER;

  // Líquidos de IVA (reservas e despesas incluem IVA; salários/TSU/extras/comissões não têm)
  const producedNoVat = produced / (1 + VAT_RATE);
  const collectedNoVat = collected / (1 + VAT_RATE);
  const expensesPaidNoVat = expensesPaidTotal / (1 + VAT_RATE);

  const totalCostsPaid = expensesPaidTotal + extrasDiaCost + operationalPartnersPaid + salesCommissionsTotal + totalSalaries + employerTax;
  const totalCostsAll = totalCostsPaid + expensesPendingTotal + operationalPartnersPending;
  // Custos líquidos: despesas sem IVA, resto tal-qual
  const totalCostsNoVat = expensesPaidNoVat + extrasDiaCost + operationalPartnersPaid + salesCommissionsTotal + totalSalaries + employerTax;

  const summary = {
    produced, producedCount,
    collected, collectedCount,
    producedNoVat, collectedNoVat,
    expensesPaid: expensesPaidTotal,
    expensesPaidNoVat,
    expensesPending: expensesPendingTotal,
    extrasDiaCost,
    salariesCost: totalSalaries,
    employerTax,
    salesCommissions: salesCommissionsTotal,
    // back-compat
    invoiced: 0,
    marketingCost: 0,
    partnerCommissionsPaid: operationalPartnersPaid,
    partnerCommissionsPending: operationalPartnersPending,
    operationalPartnersPaid,
    operationalPartnersPending,
    totalCostsPaid,
    totalCostsAll,
    totalCostsNoVat,
    marginRealized: produced - totalCostsPaid,
    marginAll: produced - totalCostsAll,
    // Margem verdadeira: receita entregue s/ IVA − custos (despesas s/ IVA)
    marginNet: producedNoVat - totalCostsNoVat,
    vatRate: VAT_RATE,
    periodDays,
  };

  return {
    summary,
    timeseries,
    granularity,
    range: { from: filters.from, to: filters.to },
    // Mantém os blocos antigos para back-compat / drilldown
    deliveries: deliveryRows,
    collected: collectedRows,
    expensesPaid: expPaidRows,
    expensesPending: expPendRows,
    forecast: forecastRows,
    extrasDia: extrasDiaSummary,
    partnerCommissions: [], // back-compat (deixou de vir de partnership_invoices)
    salesCommissions, // comissões parceiros de venda por projeto
    operationalPartners, // parceiros operacionais: comissão s/ reservas dos projetos operados
    salaries: {
      byProject: salariesByProject,
      details: salaryDetailRows,
      total: totalSalaries,
    },
  };
}

// ─── PARTNERSHIP ANALYTICS (from bookings campaign field) ────────────────────

export async function legacyAnnualBreakdown(year: number, projectId?: number) {
  const db = await getDb();
  if (!db) return [];

  const VAT_RATE = 0.23;

  // Resolve project hierarchy
  let projectIds: number[] | undefined;
  if (projectId) projectIds = await resolveProjectIds(projectId);

  // 1. Revenue: bookings with checkout no ano, excluindo canceladas.
  // Igual ao filtro da Faturação (status != 'CANCELLED' apanha também as
  // canceladas com cancelledAt vazio que o sync não populou).
  const revConds: any[] = [
    gte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
    sql`${multiparkBookings.status} != 'CANCELLED'`,
  ];
  if (projectIds) revConds.push(inArray(multiparkBookings.projectId, projectIds));

  const revenueRows = await db
    .select({
      month: sql<number>`MONTH(${multiparkBookings.checkOut})`,
      total: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...revConds))
    .groupBy(sql`MONTH(${multiparkBookings.checkOut})`);

  // 2. Despesas TODAS (pagas + pendentes + atraso, excepto canceladas) por
  // data da despesa (expenseDate, quando aconteceu), não por paidAt.
  // Visão de P&L de gestão, não fluxo de caixa.
  const expConds: any[] = [
    sql`${expenses.status} != 'cancelled'`,
    gte(expenses.expenseDate, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(expenses.expenseDate, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
  ];
  if (projectIds) expConds.push(inArray(expenses.projectId, projectIds));

  const expenseRows = await db
    .select({
      month: sql<number>`MONTH(${expenses.expenseDate})`,
      total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
    })
    .from(expenses)
    .where(and(...expConds))
    .groupBy(sql`MONTH(${expenses.expenseDate})`);

  // ─── 3. Marketing despesas (marketing_expenses) por mês ──────────────────
  const mktExpConds: any[] = [
    gte(marketingExpenses.date, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(marketingExpenses.date, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
  ];
  if (projectIds) mktExpConds.push(inArray(marketingExpenses.projectId, projectIds));
  const mktExpRows = await db
    .select({
      month: sql<number>`MONTH(${marketingExpenses.date})`,
      total: sql<number>`COALESCE(SUM(${marketingExpenses.amount}), 0)`,
    })
    .from(marketingExpenses)
    .where(and(...mktExpConds))
    .groupBy(sql`MONTH(${marketingExpenses.date})`);

  // ─── 4. Ad spend (Google/Meta) por mês ──────────────────────────────────
  const adsConds: any[] = [
    gte(campaignDailyStats.date, toMysqlDateTime(new Date(`${year}-01-01`))),
    lte(campaignDailyStats.date, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
  ];
  if (projectIds) adsConds.push(inArray(campaigns.projectId, projectIds));
  const adsRows = await db
    .select({
      month: sql<number>`MONTH(${campaignDailyStats.date})`,
      total: sql<number>`COALESCE(SUM(${campaignDailyStats.spend}), 0)`,
    })
    .from(campaignDailyStats)
    .innerJoin(campaigns, eq(campaigns.id, campaignDailyStats.campaignId))
    .where(and(...adsConds))
    .groupBy(sql`MONTH(${campaignDailyStats.date})`);

  // ─── 5. Extras-dia (custo da equipa diária) por mês ─────────────────────
  // assignmentDate é varchar("YYYY-MM-DD"). Agrupamos pelo dia e fazemos
  // o bucket por mês em JS, evitando problemas com strict mode do MySQL.
  // CRÍTICO: filtra isTeamLeader=0 — os team leaders são adicionados ao
  // extras-dia só para repartir o gasto diário do salário deles, mas o
  // pagamento real é o salário mensal (entra em "salaries"). Sem isto
  // estaríamos a contar o team leader duas vezes.
  const extrasRows = await db
    .select({
      date: extrasDiaAssignments.assignmentDate,
      level: extrasDiaAssignments.level,
      hours: sql<number>`COALESCE(SUM(GREATEST(${extrasDiaAssignments.endHour} - ${extrasDiaAssignments.startHour}, 0)), 0)`,
    })
    .from(extrasDiaAssignments)
    .where(
      and(
        gte(extrasDiaAssignments.assignmentDate, `${year}-01-01`),
        lte(extrasDiaAssignments.assignmentDate, `${year}-12-31`),
        eq(extrasDiaAssignments.isTeamLeader, 0),
      ),
    )
    .groupBy(extrasDiaAssignments.assignmentDate, extrasDiaAssignments.level);

  const extrasDiaByMonth: Record<number, number> = {};
  for (const r of extrasRows) {
    const rate = EXTRAS_DIA_RATES[String(r.level ?? "junior")] ?? 4;
    const m = Number((r.date ?? "").slice(5, 7));
    if (!m) continue;
    extrasDiaByMonth[m] = (extrasDiaByMonth[m] ?? 0) + Number(r.hours) * rate;
  }

  // ─── 6. Comissões parceiros (venda + operacional) descontadas da receita ─
  // Carrega aliases + parceiros para fazer match com bookings.campaign e
  // calcular comissão por mês. Para operacional, aplica % das reservas dos
  // projetos operados (mesmo padrão de getBillingData).
  const allPartners = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      campaignKey: partnerships.campaignKey,
      commissionRate: partnerships.commissionRate,
      partnerType: partnerships.partnerType,
      notes: partnerships.notes,
      updatedAt: partnerships.updatedAt,
    })
    .from(partnerships);
  const allAliases = await db
    .select({ partnershipId: partnerAliases.partnershipId, aliasValue: partnerAliases.aliasValue })
    .from(partnerAliases);
  const partnerByCampaign = new Map<string, { id: number; name: string; rate: number; updatedAt: string }>();
  const registerKey = (k: string | null, id: number, name: string, rate: number, updatedAt: string) => {
    if (!k) return;
    const key = k.trim().toLowerCase();
    if (!key) return;
    const ex = partnerByCampaign.get(key);
    if (!ex || updatedAt > ex.updatedAt) {
      partnerByCampaign.set(key, { id, name, rate, updatedAt });
    }
  };
  for (const p of allPartners) {
    const rate = Number(p.commissionRate ?? 0);
    const updatedAt = p.updatedAt ?? "";
    registerKey(p.campaignKey, p.id, p.name, rate, updatedAt);
    registerKey(p.name, p.id, p.name, rate, updatedAt);
  }
  const partnerById = new Map(allPartners.map(p => [p.id, p]));
  for (const a of allAliases) {
    const p = partnerById.get(a.partnershipId);
    if (!p) continue;
    registerKey(a.aliasValue, p.id, p.name, Number(p.commissionRate ?? 0), p.updatedAt ?? "");
  }

  const bookingsByMonthCampaign = await db
    .select({
      month: sql<number>`MONTH(${multiparkBookings.checkOut})`,
      campaign: multiparkBookings.campaign,
      revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
    })
    .from(multiparkBookings)
    .where(and(...revConds, isNotNull(multiparkBookings.campaign)))
    .groupBy(sql`MONTH(${multiparkBookings.checkOut})`, multiparkBookings.campaign);

  const salesCommissionByMonth: Record<number, number> = {};
  for (const r of bookingsByMonthCampaign) {
    const key = (r.campaign ?? "").trim().toLowerCase();
    const partner = partnerByCampaign.get(key);
    if (!partner) continue;
    const m = Number(r.month);
    salesCommissionByMonth[m] = (salesCommissionByMonth[m] ?? 0) + Number(r.revenue) * (partner.rate / 100);
  }

  // Operacional: para parceiros tipo "operacional" com operatesProjects
  const { parsePartnerConfig } = await import("../../shared/partnerTypes");
  const operationalPartnersList = allPartners
    .filter(p => (p.partnerType ?? "outro") === "operacional")
    .map(p => ({ p, cfg: parsePartnerConfig(p.notes ?? null) }))
    .filter(({ cfg }) => Array.isArray(cfg.operatesProjects) && cfg.operatesProjects!.length > 0);

  const operationalCommissionByMonth: Record<number, number> = {};
  for (const { p, cfg } of operationalPartnersList) {
    const expanded = new Set<number>();
    for (const root of cfg.operatesProjects ?? []) {
      const ids = await resolveProjectIds(root);
      for (const pid of ids) expanded.add(pid);
    }
    if (expanded.size === 0) continue;
    const rows = await db
      .select({
        month: sql<number>`MONTH(${multiparkBookings.checkOut})`,
        revenue: sql<number>`COALESCE(SUM(${multiparkBookings.totalPrice}), 0)`,
      })
      .from(multiparkBookings)
      .where(
        and(
          gte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-01-01`))),
          lte(multiparkBookings.checkOut, toMysqlDateTime(new Date(`${year}-12-31T23:59:59`))),
          sql`${multiparkBookings.status} != 'CANCELLED'`,
          inArray(multiparkBookings.projectId, Array.from(expanded)),
        ),
      )
      .groupBy(sql`MONTH(${multiparkBookings.checkOut})`);
    const rate = Number(p.commissionRate ?? 0) / 100;
    for (const r of rows) {
      const m = Number(r.month);
      operationalCommissionByMonth[m] = (operationalCommissionByMonth[m] ?? 0) + Number(r.revenue) * rate;
    }
  }

  // ─── 7. Payroll por mês COM RATEIO hierárquico — em paralelo ────────────
  // Resolver descendentes folha para rateio do salário de quem está no
  // topo (igual ao que se faz em getPartnerInvoicingSummary).
  const allProjsForRateio = await db
    .select({ id: projects.id, name: projects.name, parentId: projects.parentId, level: projects.level })
    .from(projects);
  const childrenMap = new Map<number, number[]>();
  for (const p of allProjsForRateio) {
    if (p.parentId != null) {
      if (!childrenMap.has(p.parentId)) childrenMap.set(p.parentId, []);
      childrenMap.get(p.parentId)!.push(p.id);
    }
  }
  function leafDescendants(pid: number): number[] {
    const self = allProjsForRateio.find(x => x.id === pid);
    if (!self) return [pid];
    if (self.level === "project") return [pid];
    const kids = childrenMap.get(pid) ?? [];
    if (kids.length === 0) return [pid];
    const out: number[] = [];
    for (const k of kids) out.push(...leafDescendants(k));
    return out.length > 0 ? out : [pid];
  }

  // TSU employer rate in Portugal: 23.75%
  const TSU_EMPLOYER = 0.2375;

  // PARALELIZA as 12 chamadas em vez de loop sequencial — 12x mais rápido
  const monthIds = Array.from({ length: 12 }, (_, i) => i + 1);
  const payrollResults = await Promise.all(monthIds.map(async (m) => {
    try {
      const payroll = await getPayrollData(year, m);
      // Rateio: para cada entrada, expande para descendentes folha
      let totalSalaries = 0;
      let totalEmployerTax = 0;
      for (const p of payroll) {
        const taxableBase = p.isExtra
          ? p.extraPayment
          : (p.baseSalary + p.overtimePayment + p.nightPayment + p.weekendPayment);
        const employerTaxForEmp = taxableBase * TSU_EMPLOYER;
        const empProjectId = p.projectId ?? null;
        if (empProjectId == null) {
          // Sem projeto: só conta se não há filtro
          if (!projectIds) {
            totalSalaries += p.totalPayment;
            totalEmployerTax += employerTaxForEmp;
          }
          continue;
        }
        const targets = leafDescendants(empProjectId);
        // Se há filtro de projeto, vê quantos targets caem no filtro
        const matching = projectIds ? targets.filter(t => projectIds!.includes(t)) : targets;
        if (matching.length === 0) continue;
        const share = matching.length / targets.length; // fracção que cai no filtro
        totalSalaries += p.totalPayment * share;
        totalEmployerTax += employerTaxForEmp * share;
      }
      return [m, { salaries: Math.round(totalSalaries * 100) / 100, employerTax: Math.round(totalEmployerTax * 100) / 100 }] as const;
    } catch {
      return [m, { salaries: 0, employerTax: 0 }] as const;
    }
  }));
  const payrollByMonth: Record<number, { salaries: number; employerTax: number }> = {};
  for (const [m, v] of payrollResults) payrollByMonth[m] = v;

  // ─── 8. Build monthly breakdown ──────────────────────────────────────────
  const revMap = new Map(revenueRows.map(r => [Number(r.month), Number(r.total)]));
  const expMap = new Map(expenseRows.map(e => [Number(e.month), Number(e.total)]));
  const mktExpMap = new Map(mktExpRows.map(r => [Number(r.month), Number(r.total)]));
  const adsMap = new Map(adsRows.map(r => [Number(r.month), Number(r.total)]));

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const revenueGrossWithVat = revMap.get(m) ?? 0;
    const salesCommissions = Math.round((salesCommissionByMonth[m] ?? 0) * 100) / 100;
    const operationalCommissions = Math.round((operationalCommissionByMonth[m] ?? 0) * 100) / 100;
    // Receita líquida: comissões saem ANTES dos impostos
    const revenueWithVat = revenueGrossWithVat - salesCommissions - operationalCommissions;

    const expensesWithVat = expMap.get(m) ?? 0;
    const marketingCost = (mktExpMap.get(m) ?? 0) + (adsMap.get(m) ?? 0);
    const extrasDiaCost = extrasDiaByMonth[m] ?? 0;
    const salaries = payrollByMonth[m]?.salaries ?? 0;
    const employerTax = payrollByMonth[m]?.employerTax ?? 0;

    const vatRevenue = Math.round(revenueWithVat * VAT_RATE / (1 + VAT_RATE) * 100) / 100;
    const vatExpenses = Math.round(expensesWithVat * VAT_RATE / (1 + VAT_RATE) * 100) / 100;
    const vatToPay = Math.round((vatRevenue - vatExpenses) * 100) / 100;

    const revenueNoVat = Math.round((revenueWithVat - vatRevenue) * 100) / 100;
    const expensesNoVat = Math.round((expensesWithVat - vatExpenses) * 100) / 100;

    const totalCosts = expensesNoVat + marketingCost + extrasDiaCost + salaries + employerTax;
    const profit = Math.round((revenueNoVat - totalCosts) * 100) / 100;

    months.push({
      month: m,
      revenueGrossWithVat: Math.round(revenueGrossWithVat * 100) / 100,
      salesCommissions,
      operationalCommissions,
      revenueWithVat: Math.round(revenueWithVat * 100) / 100,
      revenueNoVat,
      vatRevenue,
      expensesWithVat,
      expensesNoVat,
      vatExpenses,
      vatToPay,
      marketingCost: Math.round(marketingCost * 100) / 100,
      extrasDiaCost: Math.round(extrasDiaCost * 100) / 100,
      salaries,
      employerTax,
      totalCosts: Math.round(totalCosts * 100) / 100,
      profit,
      fromHistory: false,
    });
  }

  // ─── 9. Fusão com o histórico importado (anos sem dados na app) ──────────
  // Se um mês não tem NADA real (nem reservas, nem despesas, nem payroll)
  // e existe registo importado do Excel, usa esse. Só sem filtro de projeto
  // (o histórico é global). Permite ver 2016→hoje na mesma página.
  if (!projectIds) {
    try {
      const history = await getFinancialHistory(year);
      const histByMonth = new Map(history.map((h) => [h.month, h]));
      for (const mo of months) {
        const h = histByMonth.get(mo.month);
        if (!h) continue;
        const hasReal = mo.revenueGrossWithVat > 0 || mo.expensesWithVat > 0 || mo.salaries > 0;
        if (hasReal) continue;
        const revenueWithVat = h.revenueWithVat;
        const expensesWithVat = h.expensesWithVat;
        const salaries = h.salaries;
        const vatRevenue = Math.round(revenueWithVat * 0.23 / 1.23 * 100) / 100;
        const vatExpenses = Math.round(expensesWithVat * 0.23 / 1.23 * 100) / 100;
        const revenueNoVat = Math.round((revenueWithVat - vatRevenue) * 100) / 100;
        const expensesNoVat = Math.round((expensesWithVat - vatExpenses) * 100) / 100;
        const employerTax = Math.round(salaries * 0.2375 * 100) / 100;
        const totalCosts = Math.round((expensesNoVat + salaries + employerTax) * 100) / 100;
        Object.assign(mo, {
          revenueGrossWithVat: revenueWithVat,
          revenueWithVat,
          revenueNoVat,
          vatRevenue,
          expensesWithVat,
          expensesNoVat,
          vatExpenses,
          vatToPay: Math.round((vatRevenue - vatExpenses) * 100) / 100,
          salaries,
          employerTax,
          totalCosts,
          profit: Math.round((revenueNoVat - totalCosts) * 100) / 100,
          fromHistory: true,
        });
      }
    } catch (err) {
      console.warn("[annual] fusão histórico falhou:", err);
    }
  }

  return months;
}

