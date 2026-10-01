/**
 * GET /api/file/<key> — abre um ficheiro do storage PELA KEY, com autorização
 * por entidade (P1, 1 out 2026). Antes bastava ter sessão e o endpoint
 * redirecionava para o link público do bucket: qualquer login abria qualquer
 * documento de RH, folha de ordenados ou fatura pela key.
 *
 * Os ecrãs normais já recebem links assinados pelos próprios procedimentos
 * (server/storageSign.ts); este endpoint fica para links que saem da app (o
 * email da folha), ficheiros antigos com URL relativa e o modo local. A regra
 * decide-se pelo PREFIXO da key (os ids vêm na própria key); prefixos
 * partilhados por várias funcionalidades (`uploads/`, `inbound/`) e os
 * desconhecidos ficam só para admin ou acima.
 *
 * Resposta: 302 para um GET assinado de 5 min; 401 sem sessão; 403 sem
 * permissão; 404 se não existir. Mesmo padrão do /api/mail/attachment.
 */
import type { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { ROLE_RANK, grantFor, roleRank, type AccessOverrides, type ModuleId } from "../shared/access";
import { loginUrlWithReturn } from "../shared/loginReturn";
import type { CityAccess } from "./cityAccess";

export type FileRule =
  | { kind: "session" }
  | { kind: "employeeDocs"; employeeId: number }
  | { kind: "employeeTime"; employeeId: number }
  | { kind: "ownInvoice"; userId: number }
  | { kind: "module"; modules: ModuleId[] }
  | { kind: "admin" };

/** Quem pode abrir uma key — decidido pelo prefixo. PURA. */
export function fileAccessRule(rawKey: string): FileRule {
  const key = rawKey.replace(/^\/+/, "");
  let m = key.match(/^employees\/(\d+)\/docs\//);
  if (m) return { kind: "employeeDocs", employeeId: Number(m[1]) };
  m = key.match(/^employees\/(\d+)\/ponto\//);
  if (m) return { kind: "employeeTime", employeeId: Number(m[1]) };
  // as fotos de perfil já aparecem em listas, contactos e no menu
  if (/^employees\/\d+\/photo-[^/]+$/.test(key)) return { kind: "session" };
  if (/^(payroll|payslips)\//.test(key)) return { kind: "module", modules: ["rh_salarios"] };
  m = key.match(/^invoices\/(\d+)\//);
  if (m) return { kind: "ownInvoice", userId: Number(m[1]) };
  if (key.startsWith("complaints/")) return { kind: "module", modules: ["reclamacoes"] };
  if (key.startsWith("lost-found/")) return { kind: "module", modules: ["perdidos"] };
  if (key.startsWith("training/")) return { kind: "module", modules: ["formacao"] };
  if (key.startsWith("crm/")) return { kind: "module", modules: ["clientes"] };
  if (key.startsWith("cash/")) return { kind: "module", modules: ["faturacao"] };
  if (key.startsWith("whatsapp/")) return { kind: "module", modules: ["whatsapp"] };
  if (key.startsWith("driver-history/")) return { kind: "module", modules: ["historico_diario", "atividade_diaria"] };
  // knowledge/ (visibilidade por documento), uploads/ e inbound/ (várias
  // funcionalidades) e o resto: só admin+ — os ecrãs usam links assinados.
  return { kind: "admin" };
}

export interface FileViewer { id: number; role: string; accessOverrides: AccessOverrides }

export interface FileRouteDeps {
  authenticate(req: Request): Promise<{ id: number; role: string } | null>;
  overrides(userId: number): Promise<AccessOverrides>;
  cityAccess(userId: number, role: string): Promise<CityAccess>;
  /** Corre `fn` com o alcance de cidade da pessoa (cityScope). */
  inScope<T>(access: CityAccess, fn: () => Promise<T>): Promise<T>;
  /** Lança se não pode (TRPCError FORBIDDEN). */
  assertDocs(user: FileViewer, employeeId: number): Promise<void>;
  assertTime(user: FileViewer, employeeId: number): Promise<void>;
  /** Lança se não tem a ação "ver" no módulo (com `allowOwn`, o alcance "own" chega). */
  assertModule(user: FileViewer, module: ModuleId, allowOwn: boolean): void;
  /** URL de leitura: GET assinado ou URL absoluta de outro backend; "" se não existe; relativa no modo local. */
  readUrl(key: string): Promise<string>;
  /** Caminho no disco no modo local (ou null). */
  localPath(key: string): string | null;
}

/**
 * Pode abrir? Lança FORBIDDEN quando não. `allowOwn`: o alcance "own" de um
 * módulo chega — só para links que um procedimento JÁ filtrou (ex.: o condutor
 * a ver a SUA reclamação); no /api/file (key escolhida por quem pede) não.
 */
export async function assertCanOpenFile(deps: FileRouteDeps, user: FileViewer, rule: FileRule, allowOwn = false): Promise<void> {
  const forbidden = () => Object.assign(new Error("Sem permissão para abrir este ficheiro."), { code: "FORBIDDEN" });
  const isAdmin = roleRank(user.role) >= ROLE_RANK.admin;
  switch (rule.kind) {
    case "session":
      return;
    case "employeeDocs":
      return deps.assertDocs(user, rule.employeeId);
    case "employeeTime":
      return deps.assertTime(user, rule.employeeId);
    case "ownInvoice":
      if (rule.userId === user.id) return;
      return deps.assertModule(user, "despesas", false);
    case "module": {
      let lastErr: unknown = forbidden();
      for (const m of rule.modules) {
        try { deps.assertModule(user, m, allowOwn); return; } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }
    case "admin":
      if (isAdmin) return;
      throw forbidden();
  }
}

export function makeFileRoute(deps: FileRouteDeps) {
  return async function fileRoute(req: Request, res: Response): Promise<void> {
    try {
      // O Express já decodifica os grupos capturados — um 2º decodeURIComponent
      // lançava URIError (500) com nomes que contêm "%".
      const key = String((req.params as any)[0] ?? "");
      if (!key || key.includes("..")) { res.status(400).json({ error: "Key inválida" }); return; }
      const auth = await deps.authenticate(req).catch(() => null);
      if (!auth) {
        // clique num link (ex.: o email da folha) sem sessão → login, e volta ao ficheiro
        if (String(req.headers?.accept ?? "").includes("text/html")) { res.redirect(302, loginUrlWithReturn(req.originalUrl)); return; }
        res.status(401).json({ error: "Sessão inválida ou expirada — volta a entrar." });
        return;
      }
      const user: FileViewer = { id: auth.id, role: auth.role, accessOverrides: await deps.overrides(auth.id).catch(() => ({})) };
      const access = await deps.cityAccess(auth.id, auth.role);
      await deps.inScope(access, () => assertCanOpenFile(deps, user, fileAccessRule(key)));
      const url = await deps.readUrl(key);
      res.setHeader("Cache-Control", "private, no-store");
      if (url && /^https?:\/\//.test(url)) { res.redirect(302, url); return; }
      // Modo local (sem S3/Blob): serve do disco.
      const local = deps.localPath(key);
      if (local) { res.sendFile(local); return; }
      res.status(404).json({ error: "Ficheiro não encontrado no storage" });
    } catch (e: any) {
      const code = e?.code === "FORBIDDEN" ? 403 : e?.code === "NOT_FOUND" ? 404 : e?.code === "UNAUTHORIZED" ? 401 : 500;
      res.status(code).json({ error: code === 500 ? "Falha a resolver ficheiro" : String(e?.message ?? "Sem permissão") });
    }
  };
}

/** Dependências reais (imports dinâmicos: não arrasta a BD para os testes). */
export const realFileDeps: FileRouteDeps = {
  async authenticate(req) {
    const { sdk } = await import("./_core/sdk");
    const u = await sdk.authenticateRequest(req as any);
    return u ? { id: u.id, role: u.role } : null;
  },
  async overrides(userId) {
    const { getUserModuleOverrides } = await import("./db");
    return getUserModuleOverrides(userId);
  },
  async cityAccess(userId, role) {
    const { loadCityAccess } = await import("./cityAccess");
    return loadCityAccess(userId, role);
  },
  async inScope(access, fn) {
    const { cityScope } = await import("./cityScope");
    return cityScope.run(access, fn);
  },
  async assertDocs(user, employeeId) {
    const { assertCanViewDocuments } = await import("./rhGuards");
    await assertCanViewDocuments(user, employeeId, "Sem permissão para ver os documentos desta ficha.");
  },
  async assertTime(user, employeeId) {
    const { assertCanViewTimeRecords } = await import("./rhGuards");
    await assertCanViewTimeRecords(user, employeeId);
  },
  assertModule(user, module, allowOwn) {
    // a mesma regra do requireAccess, sem mexer no alcance de cidade do pedido
    const g = grantFor(user, module);
    if (g.access === "none" || !g.actions.includes("view") || (g.access === "own" && !allowOwn)) {
      throw Object.assign(new Error("Acesso não autorizado."), { code: "FORBIDDEN" });
    }
  },
  async readUrl(key) {
    const { storagePresignGet } = await import("./storage");
    return (await storagePresignGet(key, { expiresSeconds: 300 })).url;
  },
  localPath(key) {
    if (process.env.VERCEL) return null;
    const root = path.resolve(process.cwd(), "uploads");
    const p = path.resolve(root, key);
    return p.startsWith(root + path.sep) && fs.existsSync(p) ? p : null;
  },
};

/** O endpoint com as dependências reais. */
export const fileRoute = makeFileRoute(realFileDeps);

/**
 * Regra para links que SAEM de um procedimento (server/storageSign.ts). O
 * procedimento já filtrou a linha; o que se protege aqui é a key colada num
 * campo de texto para a receber assinada. Por isso só os ficheiros SENSÍVEIS
 * mantêm a regra do /api/file — documentos e ponto de RH, folhas e recibos,
 * faturas; o resto (fotos, CRM, reclamações, rádio, CVs, trajetos…) vai a quem
 * o procedimento o mostrou, sem partir ecrãs que cruzam módulos (ex.: fotos do
 * CRM nos Contactos, trajetos na Avaliação do dia).
 */
export function outputSignRule(key: string): FileRule {
  const rule = fileAccessRule(key);
  if (rule.kind === "employeeDocs" || rule.kind === "employeeTime" || rule.kind === "ownInvoice") return rule;
  if (rule.kind === "module" && rule.modules.includes("rh_salarios")) return rule;
  return { kind: "session" };
}

/**
 * `canSign` de um procedimento: memoriza por regra (uma verificação por ficha
 * ou módulo, não uma por linha). Sem utilizador, não assina nada.
 */
export function makeViewerSigner(
  user: { id: number; role: string; accessOverrides?: AccessOverrides } | null | undefined,
  deps: FileRouteDeps = realFileDeps,
): (key: string) => Promise<boolean> {
  if (!user) return async () => false;
  const viewer: FileViewer = { id: user.id, role: user.role, accessOverrides: user.accessOverrides ?? {} };
  const memo = new Map<string, Promise<boolean>>();
  return (key: string) => {
    const rule = outputSignRule(key);
    const id = JSON.stringify(rule);
    let p = memo.get(id);
    if (!p) {
      p = assertCanOpenFile(deps, viewer, rule, true).then(() => true, () => false);
      memo.set(id, p);
    }
    return p;
  };
}
