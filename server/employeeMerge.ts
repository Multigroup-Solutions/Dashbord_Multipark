/**
 * Juntar duas fichas da MESMA pessoa (RH → Ligações, só administradores).
 * Caso típico: a ficha criada pelo RH e outra criada sozinha a partir de um
 * utilizador ou de um agente ("ribeirohelio662", "Agent DRIVER").
 *
 *  - Fica a ficha escolhida; TUDO o que aponta para a outra (ponto, PDAs,
 *    escalas, documentos, avaliações, contas e agentes extra…) passa para ela —
 *    todas as tabelas com a coluna `employeeId`, lidas do próprio MySQL.
 *    Nas chaves únicas ganha o que a ficha que fica já tinha.
 *  - O utilizador e o agente principal da outra passam para esta (principal se
 *    esta não tiver, senão extra). Campos vazios desta são preenchidos com os
 *    da outra (telefone, morada, cidade, Zello, email pessoal).
 *  - A outra fica DESATIVADA ("ficha_duplicada") — nunca é apagada.
 */
import { sql } from "drizzle-orm";

type Db = { execute: (q: any) => Promise<any> };
const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];

export interface EmployeeMergePreview {
  keep: { id: number; fullName: string; email: string | null; isActive: boolean };
  drop: { id: number; fullName: string; email: string | null; isActive: boolean };
  /** linhas que passam, por tabela (só as que têm alguma) */
  moves: { table: string; rows: number }[];
  warnings: string[];
}

async function loadEmp(d: Db, id: number) {
  return rowsOf(await d.execute(sql`SELECT id, fullName, email, personalEmail, phone, address, projectId, zelloUsername, userId,
    multiparkAgentUserId, multiparkAgentName, isActive FROM employees WHERE id = ${id} LIMIT 1`))[0] ?? null;
}

/** Tabelas (nossas) com a coluna employeeId, fora a própria `employees`. */
export async function employeeIdTables(d: Db): Promise<string[]> {
  const rows = rowsOf(await d.execute(sql`SELECT DISTINCT TABLE_NAME AS t FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'employeeId' AND TABLE_NAME <> 'employees'`));
  return rows.map((r) => String(r.t)).filter((t) => /^[A-Za-z0-9_]+$/.test(t)).sort();
}

export async function previewEmployeeMerge(d: Db, keepId: number, dropId: number): Promise<EmployeeMergePreview> {
  if (keepId === dropId) throw new Error("Escolhe duas fichas diferentes.");
  const [k, x] = await Promise.all([loadEmp(d, keepId), loadEmp(d, dropId)]);
  if (!k || !x) throw new Error("Ficha não encontrada.");
  const moves: EmployeeMergePreview["moves"] = [];
  for (const t of await employeeIdTables(d)) {
    const n = Number(rowsOf(await d.execute(sql`SELECT COUNT(*) AS n FROM ${sql.raw(`\`${t}\``)} WHERE employeeId = ${dropId}`))[0]?.n ?? 0);
    if (n > 0) moves.push({ table: t, rows: n });
  }
  const warnings: string[] = [];
  if (Number(x.isActive) !== 1) warnings.push("A ficha que sai já estava desativada.");
  if (k.userId && x.userId && Number(k.userId) !== Number(x.userId)) warnings.push("As duas fichas têm utilizador: o da que sai passa a conta extra desta pessoa (se for a mesma pessoa com dois logins, junta-os depois em \"Juntar contas\").");
  if (k.multiparkAgentUserId && x.multiparkAgentUserId && k.multiparkAgentUserId !== x.multiparkAgentUserId) warnings.push("As duas fichas têm agente da Multipark: o da que sai passa a agente extra.");
  return {
    keep: { id: Number(k.id), fullName: String(k.fullName), email: k.email ?? null, isActive: Number(k.isActive) === 1 },
    drop: { id: Number(x.id), fullName: String(x.fullName), email: x.email ?? null, isActive: Number(x.isActive) === 1 },
    moves,
    warnings,
  };
}

export async function mergeEmployees(d: Db, o: { keepId: number; dropId: number }): Promise<EmployeeMergePreview> {
  const p = await previewEmployeeMerge(d, o.keepId, o.dropId);
  const [k, x] = await Promise.all([loadEmp(d, o.keepId), loadEmp(d, o.dropId)]);

  // 1. Tudo o que aponta para a ficha que sai passa para a que fica (as que colidem numa chave única ficam onde estavam).
  for (const t of await employeeIdTables(d)) {
    await d.execute(sql`UPDATE IGNORE ${sql.raw(`\`${t}\``)} SET employeeId = ${o.keepId} WHERE employeeId = ${o.dropId}`);
  }

  // 2. A que sai fica desativada, sem utilizador/agente/Zello (nunca apagada). Antes de passar o
  // utilizador/agente/Zello para a que fica, para não colidir em chaves únicas.
  await d.execute(sql`UPDATE employees SET isActive = 0, userId = NULL, multiparkAgentUserId = NULL, multiparkAgentName = NULL, zelloUsername = NULL,
      deactivationReason = 'ficha_duplicada', deactivationReasonOther = ${`Junta à ficha #${o.keepId}`.slice(0, 200)}
    WHERE id = ${o.dropId}`);
  // 3. Utilizador da que sai → principal desta (se não tiver) ou conta extra.
  if (x.userId) {
    if (!k.userId) await d.execute(sql`UPDATE employees SET userId = ${Number(x.userId)} WHERE id = ${o.keepId}`);
    else if (Number(k.userId) !== Number(x.userId)) {
      await d.execute(sql`INSERT IGNORE INTO employee_accounts (userId, employeeId) VALUES (${Number(x.userId)}, ${o.keepId})`).catch(() => {});
    }
  }

  // 4. Agente principal da que sai → principal desta (se não tiver) ou extra.
  const dropAgent = x.multiparkAgentUserId ? String(x.multiparkAgentUserId).trim() : "";
  if (dropAgent) {
    const { isSystemAgentId } = await import("../shared/agentIdentity");
    if (!isSystemAgentId(dropAgent)) {
      if (!k.multiparkAgentUserId) {
        await d.execute(sql`UPDATE employees SET multiparkAgentUserId = NULL, multiparkAgentName = NULL WHERE id = ${o.dropId}`);
        await d.execute(sql`UPDATE employees SET multiparkAgentUserId = ${dropAgent}, multiparkAgentName = ${x.multiparkAgentName ?? null} WHERE id = ${o.keepId}`);
      } else if (String(k.multiparkAgentUserId).trim() !== dropAgent) {
        await d.execute(sql`INSERT INTO employee_agents (agentUserId, employeeId, agentName) VALUES (${dropAgent}, ${o.keepId}, ${x.multiparkAgentName ?? null})
          ON DUPLICATE KEY UPDATE employeeId = VALUES(employeeId)`);
      }
    }
  }

  // 5. Campos vazios desta ← da outra. O email da que sai fica como pessoal, se esta não tiver.
  const otherEmail = [x.email, x.personalEmail].map((e) => String(e ?? "").trim().toLowerCase()).find((e) => e && e !== String(k.email ?? "").trim().toLowerCase()) ?? null;
  await d.execute(sql`UPDATE employees SET
      phone = COALESCE(NULLIF(phone, ''), ${x.phone ?? null}),
      address = COALESCE(NULLIF(address, ''), ${x.address ?? null}),
      projectId = COALESCE(projectId, ${x.projectId ?? null}),
      zelloUsername = COALESCE(NULLIF(zelloUsername, ''), ${x.zelloUsername ?? null}),
      personalEmail = COALESCE(NULLIF(personalEmail, ''), ${otherEmail})
    WHERE id = ${o.keepId}`);

  return p;
}
