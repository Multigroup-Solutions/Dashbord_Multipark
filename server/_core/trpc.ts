import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { cityScope } from '../cityScope';
import { ROLE_RANK, roleRank, activeOverride, grantFor } from '../../shared/access';
import { accessRequest, moduleForPath, type AccessRequest } from './accessContext';
import type { CityAccess } from '../cityAccess';

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * Ficheiros do bucket com links ASSINADOS (server/storageSign.ts): à saída,
 * cada URL do bucket na resposta vira um GET assinado — só para quem a pode
 * abrir (as regras do /api/file, server/fileRoute.ts, com o "próprio" a
 * contar porque o procedimento já filtrou a linha); à entrada, um link
 * assinado que o cliente devolve (formulário pré-preenchido) volta à URL
 * canónica antes de qualquer gravação. Corre DEPOIS do login (dentro do
 * alcance de cidade da pessoa) em todos os procedimentos.
 */
const storageLinks = t.middleware(async (opts) => {
  const { canonicalStorageUrlsDeep, signStorageUrlsDeep } = await import("../storageSign");
  const raw = await opts.getRawInput();
  const clean = canonicalStorageUrlsDeep(raw);
  const result = clean !== raw ? await opts.next({ getRawInput: async () => clean }) : await opts.next();
  if (!result.ok) return result;
  const { makeViewerSigner } = await import("../fileRoute");
  const data = await signStorageUrlsDeep(result.data, { canSign: makeViewerSigner(opts.ctx.user as any) });
  return data === result.data ? result : { ...result, data };
});

export const publicProcedure = t.procedure.use(storageLinks);

// O grant `extras_dia.team_leader` NÃO sobe o papel efetivo (modelo de
// acessos, 24 set 2026): só torna a pessoa elegível como TL na escala do
// Extras-Dia (server/extrasDia.ts). O papel da conta é que decide os acessos.

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  // Contexto do pedido: as permissões da pessoa são lidas UMA vez (cache
  // partilhado por loadCityAccess, requireAccess, totais financeiros…).
  const req: AccessRequest = { userId: ctx.user.id };
  return accessRequest.run(req, async () => {
    // Bloqueio de login da ficha (docs/faltas/manual) — no servidor, não só na UI.
    const { loginBlockFor } = await import('../loginBlock');
    const blocked = await loginBlockFor(ctx.user!);
    if (blocked) throw new TRPCError({ code: "FORBIDDEN", message: blocked });

    // Acesso efetivo = papel + overrides de módulo (shared/access.ts).
    const { getUserModuleOverrides } = await import('../db');
    req.overrides = await getUserModuleOverrides(ctx.user!.id);
    const user = { ...ctx.user!, accessOverrides: req.overrides };

    const { loadCityAccess, loadCityAccessParts, isPersonalAccessPath, ownRecordEmployeeId, hasForeignCityFilter, scopeCityQuery, selectedCityAccess, MISSING_COST_CENTRE_MESSAGE } = await import('../cityAccess');
    let requestAccess: CityAccess | undefined;
    let scopedInput: unknown;
    let scopeInput = false;
    if (!isPersonalAccessPath(opts.path)) {
      let access = await loadCityAccess(user.id, user.role);
      if (access.missingCostCenter) {
        // 19c: sem centro de custos, só a PRÓPRIA ficha (foto, dados, documentos,
        // pedido de IBAN) — com âmbito de cidades vazio, nunca "todas".
        const target = ownRecordEmployeeId(opts.path, await opts.getRawInput());
        const { getEmployeeByUserId } = await import('../db');
        const mine = target != null ? (await getEmployeeByUserId(user.id))?.employee?.id ?? null : null;
        if (target == null || mine !== target) throw new TRPCError({ code: 'FORBIDDEN', message: MISSING_COST_CENTRE_MESSAGE });
        requestAccess = { ...access, all: false, cityIds: [], projectIds: [] };
      } else {
        // Só quem TEM overrides de módulo precisa das cidades base/todas (para
        // o alcance de cidade seguir o override); os outros ficam como sempre.
        if (Object.keys(req.overrides).length > 0) {
          const parts = await loadCityAccessParts(user.id, user.role);
          req.cityBase = parts.base;
          req.cityAll = parts.all ?? undefined;
          // Override do módulo deste procedimento muda o alcance de cidade ANTES
          // dos guardas (filtros de outra cidade, registos por id).
          const module = moduleForPath(opts.path);
          if (module && activeOverride(user, module)) {
            const g = grantFor(user, module);
            if (g.access === 'national' && !access.all && parts.all) { access = parts.all; req.adjusted = true; }
            else if (g.access !== 'national' && g.access !== 'none' && access.all && !parts.base.all) {
              access = { ...parts.base, missingCostCenter: false }; req.adjusted = true;
            }
          }
        }
        const raw = await opts.getRawInput();
        if (hasForeignCityFilter(access, raw)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Este projeto não pertence à cidade do teu centro de custos.' });
        }
        scopedInput = scopeCityQuery(opts.path, access, raw);
        scopeInput = scopedInput !== raw;
        requestAccess = opts.type === 'query' || opts.path === 'expenses.recurring.generateMonth'
          ? await selectedCityAccess(access, scopedInput) : access;
      }
    }

    const proceed = async () => {
      const { assertScopedOperation } = await import('../cityScopeGuards');
      await assertScopedOperation(opts.path, opts.type, scopedInput);
      return next({
        ...(scopeInput ? { getRawInput: async () => scopedInput } : {}),
        ctx: { ...ctx, user },
      });
    };
    return requestAccess ? cityScope.run(requestAccess, proceed) : proceed();
  });
});

export const protectedProcedure = t.procedure.use(requireUser).use(storageLinks);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    // Hierarquia: admin OU acima (super_admin incluído).
    if (!ctx.user || roleRank(ctx.user.role) < ROLE_RANK.admin) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
).use(storageLinks);
