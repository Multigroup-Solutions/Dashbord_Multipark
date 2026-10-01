/**
 * Canal de toque das chamadas do WhatsApp por Server-Sent Events:
 * `GET /api/whatsapp/calls/stream` (mesma origem, cookie de sessão).
 *
 * Porquê: o polling do toque sofre o "intensive throttling" do Chrome (separador
 * escondido há mais de 5 min → temporizadores 1 vez por minuto), o que pode
 * fazer o toque chegar depois do prazo da Meta para atender (30 a 60 s). Um
 * evento de rede não depende dos temporizadores da página.
 *
 * Como:
 *  - autenticação e âmbito são os MESMOS do `whatsapp.calls.incoming`: o pedido
 *    passa pelo `protectedProcedure` (sessão, bloqueio de login, overrides,
 *    cidade) através de um caller interno com o mesmo caminho tRPC;
 *  - o servidor lê a BD de 1 em 1 s (`listIncomingCalls`, que sem chamadas é um
 *    SELECT indexado sem JOIN) e envia só `ring` / `ring-cleared` com o id da
 *    chamada; o cliente volta a pedir o `incoming` para saber quem liga;
 *  - fecha antes do maxDuration da função (50 s); o EventSource volta a ligar-se
 *    sozinho (`retry: 1000`);
 *  - interruptor WHATSAPP_CALLS desligado → 204 (o EventSource deixa de tentar);
 *    sem sessão → 401, sem acesso → 403.
 */
import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "./_core/trpc";
import { requireAccess } from "./_core/access";
import { scopedProjectIds } from "./cityScope";
import type { User } from "../drizzle/schema";
import {
  CALL_STREAM_MAX_DB_ERRORS, CALL_STREAM_MAX_MS, CALL_STREAM_PATH, CALL_STREAM_PING_MS, CALL_STREAM_RETRY_MS, CALL_STREAM_TICK_MS,
  diffRinging, formatSseEvent, ringingIds,
} from "../shared/whatsappCallSignal";

/**
 * Router interno (não faz parte do appRouter): o caminho
 * `whatsapp.calls.streamScope` é o mesmo módulo e o mesmo tratamento de cidade
 * que o `whatsapp.calls.incoming`.
 */
const streamAuthRouter = router({
  whatsapp: router({
    calls: router({
      streamScope: protectedProcedure.query(async ({ ctx }) => {
        requireAccess(ctx.user, "whatsapp", "edit");
        const { whatsappCallsEnabled } = await import("./whatsappCalls");
        const scope = scopedProjectIds();
        return { enabled: await whatsappCallsEnabled(), scope: scope === undefined ? null : [...scope] };
      }),
    }),
  }),
});

export type CallScope = { enabled: boolean; scope: number[] | null };

/**
 * Âmbito de cidade do toque para UMA pessoa sem pedido HTTP (push das
 * chamadas): passa pelo mesmo `protectedProcedure` que o stream e o
 * `incoming` (bloqueio de login, overrides, centro de custos). Sem acesso
 * (ou erro) → null.
 */
export async function callScopeForUser(user: User): Promise<CallScope | null> {
  try {
    return await streamAuthRouter.createCaller({ user, req: { headers: {} }, res: {}, accessDenied: false } as any).whatsapp.calls.streamScope();
  } catch {
    return null;
  }
}

async function resolveStreamScope(req: Request, res: Response): Promise<CallScope | { status: number }> {
  try {
    const { createContext } = await import("./_core/context");
    const ctx = await createContext({ req, res } as any);
    return await streamAuthRouter.createCaller(ctx).whatsapp.calls.streamScope();
  } catch (err) {
    if (err instanceof TRPCError && err.code === "UNAUTHORIZED") return { status: 401 };
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return { status: 403 };
    console.warn("[WhatsAppCallStream] falha a validar a sessão:", String((err as any)?.message ?? err).slice(0, 160));
    return { status: 503 };
  }
}

export async function handleCallStream(req: Request, res: Response): Promise<void> {
  const auth = await resolveStreamScope(req, res);
  if ("status" in auth) {
    res.status(auth.status).end();
    return;
  }
  if (!auth.enabled) {
    res.status(204).end();
    return;
  }
  const scope = auth.scope ?? undefined;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // no-transform: nenhum proxy (Cloudflare) pode comprimir/juntar os eventos.
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  // `res` (não `req`): em Node recente o "close" do pedido dispara logo que o
  // corpo (vazio) do GET é lido; o da resposta é o que diz "o browser saiu".
  res.on("close", () => { closed = true; });
  const write = (chunk: string): void => {
    if (!closed) res.write(chunk);
  };
  write(`retry: ${CALL_STREAM_RETRY_MS}\n: ligado\n\n`);

  const { listIncomingCalls } = await import("./whatsappCallsQueries");
  const { sweepStaleCallsThrottled } = await import("./whatsappCalls");
  const endAt = Date.now() + CALL_STREAM_MAX_MS;
  let lastPing = Date.now();
  let prev = new Set<number>();
  let dbErrors = 0;

  while (!closed && Date.now() < endAt) {
    try {
      // Mesmo varrimento do `incoming` (travado a 1 vez por 15 s por processo).
      await sweepStaleCallsThrottled();
      const next = ringingIds(await listIncomingCalls(scope));
      for (const ev of diffRinging(prev, next)) write(formatSseEvent(ev));
      prev = next;
      dbErrors = 0;
    } catch (err: any) {
      dbErrors++;
      if (dbErrors >= CALL_STREAM_MAX_DB_ERRORS) {
        console.warn("[WhatsAppCallStream] BD indisponível, a fechar o stream:", String(err?.message ?? err).slice(0, 160));
        break;
      }
    }
    if (Date.now() - lastPing >= CALL_STREAM_PING_MS) {
      write(": ping\n\n");
      lastPing = Date.now();
    }
    await new Promise((r) => setTimeout(r, CALL_STREAM_TICK_MS));
  }
  if (!closed) res.end();
}

/** Monta a rota nos dois entrypoints (Railway `index.ts` e Vercel `api-entry.ts`). */
export function registerWhatsappCallStreamRoute(app: Express): void {
  app.get(CALL_STREAM_PATH, (req, res) => {
    handleCallStream(req, res).catch((err) => {
      console.warn("[WhatsAppCallStream] erro:", String(err?.message ?? err).slice(0, 160));
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  });
}
