/** Recuperação limitada por parques e datas. Sem --apply apenas consulta a origem. */
import { config } from 'dotenv';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  from: { type: 'string' }, to: { type: 'string' }, parks: { type: 'string' },
  env: { type: 'string' }, apply: { type: 'boolean', default: false },
} });
if (!values.from || !values.to || !/^\d{4}-\d{2}-\d{2}$/.test(values.from) || !/^\d{4}-\d{2}-\d{2}$/.test(values.to) || values.from > values.to || !values.parks) {
  throw new Error('Indica --from YYYY-MM-DD --to YYYY-MM-DD --parks ID,ID [--env ficheiro] [--apply]');
}
if (values.env) config({ path: values.env, quiet: true });
const { getConfiguredParks, getBookingsReport, getParkApiKey } = await import('../server/multipark');
const parkIds = values.parks.split(',').filter(Boolean);
const parks = getConfiguredParks().filter(p => parkIds.includes(p.id));
if (!parks.length || parks.length !== new Set(parkIds).size) throw new Error('Um dos parques não está configurado');
try {
  if (!values.apply) {
    for (const park of parks) {
      const report = await getBookingsReport(values.from, values.to, 'creation', getParkApiKey(park));
      console.log(JSON.stringify({ mode: 'read-only', park: park.id, bookings: report.bookings?.length ?? 0 }));
    }
  } else {
    // O novo parque parceiro pertence à marca Marketplace da cidade Porto.
    // Bloquear o pai serializa duas recuperações concorrentes sem duplicar o projeto.
    if (parkIds.includes('PORTO_TOP_PARKING')) {
      const { getDb } = await import('../server/db');
      const { sql } = await import('drizzle-orm');
      const db = await getDb();
      if (!db) throw new Error('Base de dados indisponível');
      await db.transaction(async tx => {
        const parents = await tx.execute(sql`SELECT p.id FROM projects p JOIN projects city ON city.id = p.parentId
          WHERE p.name = 'Marketplace' AND p.level = 'brand' AND city.name = 'Porto' AND city.level = 'city' FOR UPDATE`);
        const parentRows = (parents as any)[0];
        if (parentRows.length !== 1) throw new Error('Hierarquia Marketplace Porto ambígua ou em falta');
        const parentId = parentRows[0].id;
        await tx.execute(sql`INSERT INTO projects (name, parentId, level)
          SELECT 'Top Parking Porto', ${parentId}, 'project' FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM projects WHERE name = 'Top Parking Porto' AND parentId = ${parentId})`);
        await tx.execute(sql`UPDATE multipark_bookings SET projectId = (
          SELECT id FROM projects WHERE name = 'Top Parking Porto' AND parentId = ${parentId} LIMIT 1)
          WHERE parkId = 'cmr2qq7tp05viql2zi4ah8dcl' AND city = 'porto' AND projectId IS NULL`);
      });
    }
    const { syncBookings, enrichBookingsBatch } = await import('../server/jobs/multiparkBookingSync');
    const result = await syncBookings({ startDate: values.from, endDate: values.to, parkIds });
    const detail = await enrichBookingsBatch({ externalIds: result.enrichTargets, force: true, limit: result.enrichTargets.length });
    console.log(JSON.stringify({ mode: 'apply', parks: parkIds, from: values.from, to: values.to,
      processed: result.processed, created: result.created, updated: result.updated,
      reportErrors: result.errors.length, detail }));
    if (!result.success || detail.errors || detail.noKey) process.exitCode = 1;
  }
} catch (error) {
  console.error('Recuperação não concluída. Código:', (error as { code?: string }).code ?? 'RECOVERY_FAILED');
  process.exitCode = 1;
}
// O pool da aplicação mantém ligações abertas; todo o trabalho acima foi aguardado.
process.exit(process.exitCode ?? 0);
