// Health check isolado (função Vercel própria). Público: só { ok, version? }.
// Com Authorization: Bearer <CRON_SECRET> devolve também a presença (booleana,
// nunca valores) das variáveis críticas. Ver server/opsRules.ts.
import { buildHealthBody, cronBearerOk } from "../server/opsRules";

export default function handler(req: any, res: any) {
  const detailed = cronBearerOk(req?.headers?.authorization);
  res.status(200).json(buildHealthBody({ initFailed: false, detailed }));
}
