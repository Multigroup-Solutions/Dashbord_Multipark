/**
 * Quem pode ver/ligar ficheiros do Drive num registo — as MESMAS regras do
 * próprio registo (matriz de acessos + âmbito de cidade do pedido):
 *  - cliente: módulo Clientes + cidade (reservas do cliente na cidade);
 *  - reclamação: módulo Reclamações + cidade da reclamação;
 *  - conversa de email: as regras da Comunicação (caixa, cidade, pessoal);
 *  - colaborador (RH): as regras dos documentos pessoais (ver = quem vê os
 *    documentos da ficha; ligar/gerar = quem pode carregar documentos nela);
 *  - tarefa: as regras da tarefa (atribuída ou quem gere tarefas + cidade);
 *  - parceria: módulo Parcerias (+ cidade de operação).
 * Também carrega os dados do registo para os modelos {{…}} e a pasta no
 * Shared Drive (o RH não tem: os documentos do RH nunca vão para o Drive).
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { requireAccess, withOverrides } from "../_core/access";
import { normalizeDriveEntityId, type DriveEntityType, type SharedFolderTarget } from "../../shared/drive";

export type DriveAction = "view" | "edit";
export type DriveUser = { id: number; role: string; name?: string | null; email?: string | null; accessOverrides?: any };

export interface DriveEntityInfo {
  type: DriveEntityType;
  id: string;
  label: string;
  /** Caminho no Shared Drive (null = não tem pasta própria, ex.: tarefas, RH). */
  folder: SharedFolderTarget | null;
}

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const forbidden = (message = "Acesso não autorizado.") => new TRPCError({ code: "FORBIDDEN", message });
const notFound = (message = "Registo não encontrado.") => new TRPCError({ code: "NOT_FOUND", message });

async function database() {
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
  return d;
}

/** Nome da cidade de um centro de custos (sobe na árvore até ao nó "city"). */
export async function cityNameOfProject(projectId: number | null | undefined): Promise<string | null> {
  if (projectId == null) return null;
  const { getProjects } = await import("../db");
  const list = (await getProjects()) as Array<{ id: number; name: string; level: string; parentId: number | null }>;
  const byId = new Map(list.map((p) => [p.id, p]));
  let cur = byId.get(projectId);
  const first = cur?.name ?? null;
  for (let i = 0; cur && i < 10; i++) {
    if (cur.level === "city") return cur.name;
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  return first;
}

/**
 * Verifica o acesso ao registo (lança FORBIDDEN/NOT_FOUND) e devolve o
 * rótulo e a pasta no Shared Drive. Chamado em TODOS os pedidos do Drive.
 */
export async function assertDriveEntityAccess(user: DriveUser, type: DriveEntityType, rawId: string, action: DriveAction): Promise<DriveEntityInfo> {
  const id = normalizeDriveEntityId(type, rawId);
  if (!id) throw new TRPCError({ code: "BAD_REQUEST", message: "Registo inválido." });
  const u = withOverrides(user);
  if (type === "client") {
    requireAccess(u, "clientes", action);
    const { assertEntityInScope } = await import("../mail/inbox");
    await assertEntityInScope("client", id);
    const d = await database();
    const r = rowsOf(await d.execute(sql`SELECT MAX(NULLIF(TRIM(CONCAT_WS(' ', clientFirstName, clientLastName)), '')) AS name, COUNT(*) AS n
      FROM multipark_bookings WHERE LOWER(TRIM(clientEmail)) = ${id}`))[0];
    const name = r?.name ? String(r.name) : null;
    return { type, id, label: name ? `${name} (${id})` : id, folder: { kind: "client", name, email: id } };
  }
  if (type === "complaint") {
    requireAccess(u, "reclamacoes", action);
    const { assertEntityInScope } = await import("../mail/inbox");
    await assertEntityInScope("complaint", id);
    const d = await database();
    const r = rowsOf(await d.execute(sql`SELECT id, title, clientName, createdAt FROM complaints WHERE id = ${Number(id)} LIMIT 1`))[0];
    if (!r) throw notFound("Reclamação não encontrada.");
    return { type, id, label: `Reclamação #${id} — ${r.clientName ?? r.title ?? ""}`.trim(), folder: { kind: "complaint", id: Number(id), createdAt: r.createdAt ? String(r.createdAt) : null } };
  }
  if (type === "mail_thread") {
    const { threadAccess } = await import("../mail/inbox");
    const a = await threadAccess({ id: u.id, role: u.role, accessOverrides: u.accessOverrides ?? null } as any, Number(id));
    if (action === "edit" && !a.canAct) throw forbidden("Só quem trata esta conversa pode ligar ficheiros.");
    return { type, id, label: a.thread.subject ? `Email: ${a.thread.subject}` : `Conversa #${id}`, folder: null };
  }
  if (type === "employee") {
    const { assertCanViewDocuments, assertCanUploadDocuments } = await import("../routers");
    if (action === "view") await assertCanViewDocuments(u, Number(id), "Sem permissão para ver os documentos desta ficha");
    else await assertCanUploadDocuments(u, Number(id));
    const { getEmployeeById } = await import("../db");
    const e = await getEmployeeById(Number(id));
    if (!e) throw notFound("Colaborador não encontrado.");
    // Sem pasta no Drive: os documentos do RH nunca vão para o Google Drive (26 set 2026).
    return { type, id, label: e.employee.fullName, folder: null };
  }
  if (type === "task") {
    requireAccess(u, "tarefas", "view", { allowOwn: true });
    const { loadTaskFor } = await import("../tasksRouter");
    const { task } = await loadTaskFor({ user: u }, Number(id));
    return { type, id, label: `Tarefa: ${task.title}`, folder: null };
  }
  // partner
  requireAccess(u, "parcerias", action);
  const { partnerScope } = await import("../cityScope");
  const d = await database();
  const r = rowsOf(await d.execute(sql`SELECT p.id, p.name FROM partnerships p WHERE p.id = ${Number(id)} AND ${partnerScope(sql`p.id`)} LIMIT 1`))[0];
  if (!r) throw notFound("Parceria não encontrada.");
  return { type, id, label: `Parceria — ${r.name}`, folder: { kind: "partner", id: Number(id), name: String(r.name) } };
}

/** Dados do registo para os modelos {{…}} (depois de assertDriveEntityAccess). */
export async function loadEntityRecord(type: "employee" | "complaint" | "client" | "partner", id: string): Promise<{ record: Record<string, any>; projectId: number | null }> {
  const d = await database();
  if (type === "employee") {
    const { getEmployeeById } = await import("../db");
    const e = await getEmployeeById(Number(id));
    if (!e) throw notFound("Colaborador não encontrado.");
    return { record: e.employee as any, projectId: e.employee.projectId ?? null };
  }
  if (type === "complaint") {
    const r = rowsOf(await d.execute(sql`SELECT id, title, description, complaint_status AS complaintStatus, clientName, clientEmail, clientPhone,
      reservationRef, vehiclePlate, projectId, createdAt FROM complaints WHERE id = ${Number(id)} LIMIT 1`))[0];
    if (!r) throw notFound("Reclamação não encontrada.");
    return { record: r, projectId: r.projectId != null ? Number(r.projectId) : null };
  }
  if (type === "client") {
    const r = rowsOf(await d.execute(sql`SELECT LOWER(TRIM(clientEmail)) AS email,
        MAX(NULLIF(TRIM(CONCAT_WS(' ', clientFirstName, clientLastName)), '')) AS name,
        MAX(NULLIF(TRIM(clientPhone), '')) AS phone, COUNT(*) AS bookings,
        MIN(checkIn) AS firstCheckIn, MAX(checkIn) AS lastCheckIn
      FROM multipark_bookings WHERE LOWER(TRIM(clientEmail)) = ${id}`))[0];
    return { record: { ...(r ?? {}), email: id, bookings: r?.bookings != null ? Number(r.bookings) : 0 }, projectId: null };
  }
  const r = rowsOf(await d.execute(sql`SELECT id, name, partner_nif AS partnerNif, contactName, contactEmail, contactPhone, commissionRate, monthlyFee
    FROM partnerships WHERE id = ${Number(id)} LIMIT 1`))[0];
  if (!r) throw notFound("Parceria não encontrada.");
  return { record: r, projectId: null };
}
