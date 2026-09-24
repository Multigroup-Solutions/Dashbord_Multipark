import type { Express, Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { sql } from 'drizzle-orm';
import { sdk } from '../../_core/sdk';
import { loadCityAccess } from '../../cityAccess';
import { CALLBACK, config, PAGE } from './config';
import { consumeState, database, finishOAuth, saveConnection, startOAuth } from './oauth';
import { notificationLocation, safeError } from './domain';
import { refreshLocations, syncReviews } from './service';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function authorizedAdmin(req: Request) {
  const user = await sdk.authenticateRequest(req).catch(() => null);
  if (!user || !['admin', 'super_admin'].includes(user.role)) return null;
  return (await loadCityAccess(user.id, user.role)).all ? user : null;
}
export async function verifyPush(authorization: string | undefined) {
  const c = config();
  if (!c.pushAudience || !c.pushEmail || !c.subscription || !authorization?.startsWith('Bearer ')) throw new Error('Push não autorizado.');
  const { payload } = await jwtVerify(authorization.slice(7), googleKeys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: c.pushAudience, algorithms: ['RS256'],
  });
  if (payload.email !== c.pushEmail || payload.email_verified !== true) throw new Error('Identidade push inválida.');
}
export function registerGoogleBusinessRoutes(app: Express, afterReceive?: () => void) {
  app.get('/api/integrations/google-business/oauth/start', async (req, res) => {
    try {
      const user = await authorizedAdmin(req);
      if (!user) { res.status(403).send('Só um administrador com acesso global pode ligar os perfis Google.'); return; }
      res.redirect(302, await startOAuth(user.id));
    } catch (error) { res.status(500).type('text').send(safeError(error)); }
  });
  app.get(CALLBACK, async (req, res) => {
    try {
      const user = await authorizedAdmin(req);
      if (!user) { res.status(403).send('Inicia sessão com o administrador que iniciou a ligação.'); return; }
      const { state, code } = req.query;
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) { res.status(400).send('Pedido OAuth inválido.'); return; }
      const verifier = await consumeState(state, user.id);
      if (!verifier) { res.status(400).send('Pedido expirado. Volta a carregar em Ligar Google Business Profile nas Críticas.'); return; }
      if (req.query.error || typeof code !== 'string') { res.status(400).send('Autorização não concluída. Volta às Críticas para tentar novamente.'); return; }
      await finishOAuth(code, verifier, user.id);
      try { await refreshLocations(); }
      catch (error) { await saveConnection({ lastError: safeError(error) }); }
      res.redirect(302, `${PAGE}?googleBusiness=connected`);
    } catch (error) { res.status(500).type('text').send(safeError(error)); }
  });
  app.get('/api/cron/google-business', async (req, res) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try { res.json(await syncReviews()); }
    catch (error) { res.status(500).json({ ok: false, error: safeError(error) }); }
  });
  app.post('/api/integrations/google-business/webhook', async (req, res) => {
    try { await verifyPush(req.headers.authorization); }
    catch { res.status(401).json({ error: 'Unauthorized' }); return; }
    let location: string | null;
    try {
      const body = req.body;
      if (body?.subscription !== config().subscription || !body?.message?.messageId) throw new Error('Envelope inválido.');
      const encoded = body.message.data;
      if (typeof encoded !== 'string' || encoded.length > 65_536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Dados inválidos.');
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Dados inválidos.');
      location = notificationLocation({ ...body.message.attributes, ...data });
    } catch { res.status(400).json({ error: 'Notificação inválida.' }); return; }
    try {
      if (location) {
        const db = await database();
        // Durable coalescing: acknowledge only after storing the work. Retries
        // merely request another scan; importReview is idempotent and atomic.
        await db.execute(sql`UPDATE google_business_locations SET dirtyAt = UTC_TIMESTAMP(), dirtyVersion = dirtyVersion + 1
          WHERE locationName = ${location}`);
      }
      res.status(204).end();
      try { if (location) afterReceive?.(); } catch { /* cron recovers durable work */ }
    } catch { res.status(503).json({ error: 'Não foi possível guardar a notificação.' }); }
  });
}
