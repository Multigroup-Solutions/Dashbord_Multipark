/**
 * Telemóveis pessoais (Jorge, 13 out 2026; regras em shared/personalDevice.ts,
 * dados em server/personalDeviceStore.ts).
 *
 * O telemóvel de UMA pessoa, registado por ela no próprio aparelho ("Registar
 * este telemóvel como meu"). Fica com:
 *  - o nome de quem tem sessão nele (quem entra passa a aparecer, "agora com");
 *  - o Zello da ficha do dono (a conta Zello instalada no telemóvel) — que já
 *    é o que o GPS, o mapa ao vivo, os alertas e o vigia do terminal usam para
 *    quem não tem PDA na mão;
 *  - os avisos no telemóvel como em qualquer aparelho da pessoa (com o texto).
 * E larga o que é só dos PDAs partilhados: sessão presa ao PDA (nonce, 16 h),
 * fim de sessão na saída do ponto, "um titular de cada vez" (check-ins de
 * PDA), o aviso "mudou de aparelho", o QR só TL+ e o nome no Zello.
 *
 * Um PDA registado por engano no telemóvel de alguém (o do Jorge, da Márcia,
 * do Marco) converte-se: o token do aparelho passa para aqui, o PDA fica
 * Inativo (com nota), a sessão de PDA que lá estivesse acaba e os check-ins
 * abertos fecham. Nada se apaga.
 *
 * Sem avisos a ninguém (são ações explícitas): só ficam nos registos.
 */
import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { deviceLabelFromUserAgent } from "../shared/loginCode";
import {
  CONVERT_NOT_REGISTERED_MSG, CONVERT_RACE_MSG, isDeviceToken, personalDeviceTitle, personalDeviceZello, personalIsPdaMsg,
  personalOtherOwnerMsg, shortPersonName,
} from "../shared/personalDevice";
import { zelloKey } from "../shared/zelloKey";
import { personalDeviceStore, type PersonalDeviceRow } from "./personalDeviceStore";

/** Token novo do telemóvel pessoal (32 caracteres base64url). */
export const newPersonalToken = (): string => crypto.randomBytes(24).toString("base64url");

export interface Actor { id: number; name?: string | null }

export interface PersonalDeviceView {
  id: number;
  /** "Telemóvel de Márcia Silva" — quem tem sessão agora (senão o último, senão o dono). */
  title: string;
  /** "Android · Chrome" ou o nome do PDA convertido. */
  label: string | null;
  ownerName: string | null;
  ownerEmployeeId: number | null;
  /** Tem dono (conta ou ficha). Sem dono (convertido sem escolher a pessoa): quem o registar no Perfil fica dono. */
  hasOwner: boolean;
  /** Quem tem sessão nele agora (null = ninguém). */
  currentName: string | null;
  currentEmployeeId: number | null;
  currentSince: number | null;
  /** Quem lá esteve por último. */
  lastName: string | null;
  lastSeenAt: number | null;
  /** O Zello do telemóvel (o da ficha do dono) e de quem é. */
  zelloUsername: string | null;
  zelloOf: string | null;
  convertedFromPdaId: number | null;
  /** Quem pergunta é o dono (a conta ou a ficha). */
  mine: boolean;
}

async function employeeOf(userId: number): Promise<{ id: number; fullName: string } | null> {
  const { getEmployeeByUserId } = await import("./db");
  const e = await getEmployeeByUserId(userId).catch(() => undefined);
  return e ? { id: Number(e.employee.id), fullName: String(e.employee.fullName ?? "") } : null;
}

async function log(userId: number, action: string, entity: "personal_device" | "pda", entityId: number | null, details: string): Promise<void> {
  try {
    const { logActivity } = await import("./db");
    await logActivity({ userId, action, entity, entityId, details: details.slice(0, 1000) } as any);
  } catch { /* o registo nunca parte nada */ }
}

const isOwner = (row: PersonalDeviceRow, userId: number, employeeId: number | null | undefined): boolean =>
  row.ownerUserId === userId || (employeeId != null && row.ownerEmployeeId === employeeId);

/** Linhas → o que vai para o ecrã (nomes, Zello). */
export async function personalDeviceViews(rows: readonly PersonalDeviceRow[], viewer?: { userId: number; employeeId: number | null }): Promise<PersonalDeviceView[]> {
  if (!rows.length) return [];
  const employeeIds = rows.flatMap((r) => [r.ownerEmployeeId, r.currentEmployeeId, r.lastEmployeeId]).filter((x): x is number => x != null);
  const userIds = rows.flatMap((r) => [r.ownerUserId, r.currentUserId, r.lastUserId]).filter((x): x is number => x != null);
  const people = await personalDeviceStore().people(employeeIds, userIds);
  const nameOf = (employeeId: number | null, userId: number | null): string | null =>
    (employeeId != null ? people.employees.get(employeeId)?.name : null) || (userId != null ? people.users.get(userId) ?? null : null) || null;
  const zelloOf = (employeeId: number | null): string | null => (employeeId != null ? people.employees.get(employeeId)?.zello ?? null : null);
  return rows.map((r) => {
    const ownerName = nameOf(r.ownerEmployeeId, r.ownerUserId);
    const currentName = r.currentUserId != null ? nameOf(r.currentEmployeeId, r.currentUserId) : null;
    const lastName = r.lastUserId != null ? nameOf(r.lastEmployeeId, r.lastUserId) : null;
    const hasOwner = r.ownerEmployeeId != null;
    const zelloUsername = personalDeviceZello({ hasOwner, ownerZello: zelloOf(r.ownerEmployeeId), currentZello: zelloOf(r.currentEmployeeId), lastZello: zelloOf(r.lastEmployeeId) });
    const zelloEmployee = hasOwner ? r.ownerEmployeeId : zelloOf(r.currentEmployeeId) ? r.currentEmployeeId : r.lastEmployeeId;
    return {
      id: r.id,
      title: personalDeviceTitle({ currentName, lastName, ownerName }),
      label: r.label,
      ownerName,
      ownerEmployeeId: r.ownerEmployeeId,
      hasOwner: r.ownerUserId != null || r.ownerEmployeeId != null,
      currentName,
      currentEmployeeId: r.currentEmployeeId,
      currentSince: r.currentSince,
      lastName,
      lastSeenAt: r.lastSeenAt,
      zelloUsername,
      zelloOf: zelloUsername && zelloEmployee != null ? people.employees.get(zelloEmployee)?.name ?? null : null,
      convertedFromPdaId: r.convertedFromPdaId,
      mine: !!viewer && isOwner(r, viewer.userId, viewer.employeeId),
    };
  });
}

async function viewOf(id: number, viewer: { userId: number; employeeId: number | null }): Promise<PersonalDeviceView | null> {
  const row = await personalDeviceStore().byId(id);
  return row ? (await personalDeviceViews([row], viewer))[0] ?? null : null;
}

/**
 * "Registar este telemóvel como meu" — qualquer pessoa com sessão, no próprio
 * telemóvel. Recusa num PDA partilhado (o token do PDA validado) e num
 * telemóvel que já é pessoal de outra pessoa. No próprio: não muda nada.
 */
export async function registerPersonalDevice(actor: Actor, input: { pdaToken?: string | null; currentToken?: string | null; userAgent?: string | null }, now = Date.now()): Promise<{ token: string; already: boolean; device: PersonalDeviceView | null }> {
  const store = personalDeviceStore();
  if (isDeviceToken(input.pdaToken)) {
    const pda = await store.activePdaByToken(input.pdaToken);
    if (pda) throw new TRPCError({ code: "FORBIDDEN", message: personalIsPdaMsg(pda.name) });
  }
  const emp = await employeeOf(actor.id);
  const viewer = { userId: actor.id, employeeId: emp?.id ?? null };
  if (isDeviceToken(input.currentToken)) {
    let row = await store.byToken(input.currentToken);
    if (row && row.status === "active") {
      // Sem dono (convertido sem escolher a pessoa): quem o regista fica dono.
      if (row.ownerUserId == null && row.ownerEmployeeId == null) {
        if (await store.claimOwner(row.id, actor.id, emp?.id ?? null)) {
          await log(actor.id, "register_device", "personal_device", row.id, `Telemóvel pessoal #${row.id} ficou de ${emp?.fullName || actor.name || `#${actor.id}`} (não tinha dono)`);
        }
        row = (await store.byId(row.id)) ?? row;
      }
      if (!isOwner(row, actor.id, emp?.id)) {
        const [v] = await personalDeviceViews([row]);
        throw new TRPCError({ code: "CONFLICT", message: personalOtherOwnerMsg(shortPersonName(v?.ownerName) || "outra pessoa") });
      }
      await store.setCurrent(row.id, { userId: actor.id, employeeId: emp?.id ?? null }, now);
      return { token: row.deviceToken, already: true, device: await viewOf(row.id, viewer) };
    }
  }
  const token = newPersonalToken();
  const label = deviceLabelFromUserAgent(input.userAgent);
  const id = await store.insert({
    deviceToken: token, label, ownerUserId: actor.id, ownerEmployeeId: emp?.id ?? null,
    currentUserId: actor.id, currentEmployeeId: emp?.id ?? null, convertedFromPdaId: null, createdById: actor.id, now,
  });
  if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível registar este telemóvel. Tenta outra vez." });
  await log(actor.id, "register_device", "personal_device", id, `Telemóvel pessoal registado por ${emp?.fullName || actor.name || `#${actor.id}`} (${label})`);
  return { token, already: false, device: await viewOf(id, viewer) };
}

/**
 * Quem tem sessão neste telemóvel agora (corre em cada entrada). Também
 * reconhece um PDA convertido em pessoal: o browser ainda tem o token na chave
 * do PDA → `migrated` (o cliente passa-o para a chave do telemóvel pessoal).
 * `none` = não é (ou deixou de ser) um telemóvel pessoal.
 */
export async function seenPersonalDevice(actor: Actor, input: { token?: string | null; pdaToken?: string | null }, now = Date.now()): Promise<{ kind: "none" } | { kind: "pessoal"; migrated: boolean; device: PersonalDeviceView | null }> {
  const store = personalDeviceStore();
  const token = isDeviceToken(input.token) ? input.token : isDeviceToken(input.pdaToken) ? input.pdaToken : null;
  if (!token) return { kind: "none" };
  const row = await store.byToken(token);
  if (!row || row.status !== "active") return { kind: "none" };
  const emp = await employeeOf(actor.id);
  await store.setCurrent(row.id, { userId: actor.id, employeeId: emp?.id ?? null }, now);
  if (row.lastUserId !== actor.id) {
    const [before] = row.lastUserId != null ? await personalDeviceViews([row]) : [];
    await log(actor.id, "personal_device_enter", "personal_device", row.id,
      `${emp?.fullName || actor.name || `#${actor.id}`} entrou no telemóvel pessoal #${row.id}${before?.lastName ? ` (antes: ${before.lastName})` : ""}`);
  }
  return { kind: "pessoal", migrated: token !== input.token, device: await viewOf(row.id, { userId: actor.id, employeeId: emp?.id ?? null }) };
}

/** Sair neste telemóvel: deixa de aparecer "agora com" esta pessoa (fica como "último"). */
export async function leftPersonalDevice(actor: Actor, token: string | null | undefined): Promise<{ left: boolean }> {
  if (!isDeviceToken(token)) return { left: false };
  const store = personalDeviceStore();
  const row = await store.byToken(token);
  if (!row) return { left: false };
  return { left: await store.clearCurrent(row.id, actor.id) };
}

/**
 * Deixar de ser pessoal (nunca se apaga: fica Inativo). No próprio telemóvel
 * (pelo token) ou na lista (pelo id): o dono, ou quem edita PDAs (`canManage`).
 */
export async function unregisterPersonalDevice(actor: Actor, input: { id?: number | null; token?: string | null }, canManage: boolean, now = Date.now()): Promise<{ done: boolean }> {
  const store = personalDeviceStore();
  const row = isDeviceToken(input.token) ? await store.byToken(input.token) : input.id ? await store.byId(input.id) : null;
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Telemóvel pessoal não encontrado." });
  if (row.status !== "active") return { done: false };
  const emp = await employeeOf(actor.id);
  const owner = isOwner(row, actor.id, emp?.id);
  if (!owner && !canManage) throw new TRPCError({ code: "FORBIDDEN", message: "Só o dono do telemóvel (ou uma chefia) o tira de pessoal." });
  // Pela lista, uma chefia só mexe nos telemóveis das suas cidades (os que vê).
  if (!owner && !isDeviceToken(input.token) && !(await store.listActive()).some((d) => d.id === row.id)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Este telemóvel não é das tuas cidades." });
  }
  const done = await store.deactivate(row.id, actor.id, now);
  if (done) await log(actor.id, "unregister_device", "personal_device", row.id, `Telemóvel pessoal #${row.id} deixou de ser pessoal (fica no histórico, Inativo)`);
  return { done };
}

/** Os telemóveis pessoais ativos (com o âmbito de cidade do pedido). */
export async function listPersonalDevices(viewer: Actor): Promise<{ devices: PersonalDeviceView[]; convertedPdaIds: number[] }> {
  const store = personalDeviceStore();
  const emp = await employeeOf(viewer.id);
  const [rows, convertedPdaIds] = await Promise.all([store.listActive(), store.convertedPdaIds()]);
  return { devices: await personalDeviceViews(rows, { userId: viewer.id, employeeId: emp?.id ?? null }), convertedPdaIds };
}

/**
 * "É um telemóvel pessoal": um PDA que afinal é o telemóvel de alguém passa a
 * telemóvel pessoal. O token do aparelho muda de tabela (o telemóvel não
 * precisa de fazer nada: na próxima entrada passa sozinho), o PDA fica Inativo
 * com nota, a sessão de PDA que lá estivesse acaba e os check-ins abertos
 * fecham. Se o PDA tinha um Zello e a ficha do dono não tem nenhum (e mais
 * ninguém o tem), esse Zello passa para a ficha; se a ficha já tem outro,
 * não se mexe e a resposta diz qual ficou (`zelloLeft`) para a chefia
 * confirmar. O nome no Zello nunca volta a ser o do PDA. Quem chama já
 * validou a permissão (editar PDAs, TL ou acima) e a cidade do PDA.
 */
export async function convertPdaToPersonal(actor: Actor, input: { pdaId: number; owner: { userId: number | null; employeeId: number | null; name: string | null } | null }, now = Date.now()): Promise<{ id: number; pdaName: string; closedCheckins: number; zelloAdopted: string | null; zelloLeft: string | null; device: PersonalDeviceView | null }> {
  const store = personalDeviceStore();
  const pda = await store.pda(input.pdaId);
  if (!pda) throw new TRPCError({ code: "NOT_FOUND", message: "PDA não encontrado." });
  if (!pda.deviceToken) throw new TRPCError({ code: "BAD_REQUEST", message: CONVERT_NOT_REGISTERED_MSG });
  const owner = input.owner;
  const id = await store.insert({
    deviceToken: pda.deviceToken, label: pda.name, ownerUserId: owner?.userId ?? null, ownerEmployeeId: owner?.employeeId ?? null,
    currentUserId: null, currentEmployeeId: null, convertedFromPdaId: pda.id, createdById: actor.id, now,
  });
  if (!id) throw new TRPCError({ code: "CONFLICT", message: "Este aparelho já é um telemóvel pessoal." });
  // O PDA larga o token só se ainda for este (outro registo pelo QR entretanto → não se mexe).
  // Se a BD falhar aqui, o telemóvel novo fica inativo: nunca um aparelho PDA e pessoal ao mesmo tempo.
  let released: boolean;
  try {
    released = await store.releasePdaToken(pda.id, pda.deviceToken);
  } catch (err) {
    await store.deactivate(id, actor.id, now).catch(() => false);
    throw err;
  }
  if (!released) {
    await store.deactivate(id, actor.id, now);
    throw new TRPCError({ code: "CONFLICT", message: CONVERT_RACE_MSG });
  }
  const who = owner?.name ? shortPersonName(owner.name) : null;
  const by = actor.name || `#${actor.id}`;
  const day = new Date(now).toISOString().slice(0, 10);
  await store.retirePda(pda.id, `${day}: passou a telemóvel pessoal${who ? ` de ${who}` : ""} (#${id}), por ${by}. Era um telemóvel registado como PDA; o histórico fica.`);
  // A sessão de PDA que lá estivesse acaba (avisos do PDA desligados); os check-ins abertos fecham.
  const { endPdaSessionOnRetire } = await import("./pdaSession");
  await endPdaSessionOnRetire(pda.id, actor.id, now);
  // (Sem o "nome do PDA no Zello": a conta Zello deste aparelho deixa de ser de um PDA — ver em baixo.)
  const closedCheckins = await store.closePdaCheckins(pda.id, now, "fechado: o aparelho passou a telemóvel pessoal");
  let zelloAdopted: string | null = null;
  let zelloLeft: string | null = null;
  if (pda.zelloUsername && owner?.employeeId != null) {
    if (await store.adoptZello(owner.employeeId, pda.zelloUsername).catch(() => false)) zelloAdopted = pda.zelloUsername;
    const people = await store.people([owner.employeeId], []).catch(() => null);
    const ownerZello = people?.employees.get(owner.employeeId)?.zello ?? null;
    if (zelloKey(ownerZello) && zelloKey(ownerZello) === zelloKey(pda.zelloUsername)) {
      // O Zello do aparelho é o da ficha do dono: com "Zello: nome de quem tem o PDA" ligado, deixa de ter nome de PDA.
      if (owner.name) {
        const { syncPersonalZelloName } = await import("./pdaZelloName");
        void syncPersonalZelloName(pda.zelloUsername, owner.name);
      }
    } else {
      // A ficha já tem outro Zello (ou este é de outra ficha): não se mexe em nada — a chefia confirma.
      zelloLeft = pda.zelloUsername;
    }
  }
  const details = `${pda.name} (PDA #${pda.id}) passou a telemóvel pessoal #${id}${who ? ` de ${who}` : ""}; o PDA ficou Inativo${closedCheckins ? `, ${closedCheckins} check-in(s) fechado(s)` : ""}${zelloAdopted ? `; o Zello ${zelloAdopted} passou para a ficha` : ""}${zelloLeft ? `; o Zello ${zelloLeft} do PDA não passou para a ficha (a ficha tem outro, ou outra ficha tem este)` : ""}`;
  await log(actor.id, "convert_device", "pda", pda.id, details);
  await log(actor.id, "convert_device", "personal_device", id, details);
  const emp = await employeeOf(actor.id);
  return { id, pdaName: pda.name, closedCheckins, zelloAdopted, zelloLeft, device: await viewOf(id, { userId: actor.id, employeeId: emp?.id ?? null }) };
}
