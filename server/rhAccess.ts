/**
 * PERMISSÕES DE RH POR FINALIDADE — regra única para fichas, documentos,
 * horário, ponto e ordenados. Segue o modelo de acessos (shared/access.ts):
 *
 * VER (listas operacionais: nome, posto, nível, foto, centro, contacto) e
 * DADOS PESSOAIS (NIF, NIB, morada, nascimento, nacionalidade, contactos
 * pessoais, foto, documentos):
 *   - toda a gente: a PRÓPRIA ficha (nunca o contratual);
 *   - team_leader: as fichas do seu centro de custos (com descendentes) de
 *     quem está ABAIXO dele (utilizadores, extras, condutores; sem conta: por
 *     posto — extra/driver/senior_driver);
 *   - supervisor: as fichas do seu centro de custos;
 *   - frontoffice / backoffice: todos os centros (nacionais);
 *   - admin: tudo menos fichas de super_admin; super_admin: tudo.
 *   Fichas de admin/super_admin ficam fora do alcance de quem está abaixo.
 *
 * CONTRATUAL (posto, centro, tipo/datas de contrato, salário, subsídio,
 * conta associada, ativo/inativo, email de trabalho): admin+ — e um admin
 * não toca na ficha de um super_admin.
 *
 * 41c (Jorge, 7 out 2026: "o supervisor tem que ter permissões para fazer
 * tudo no RH da cidade dele"): o supervisor vê e gere as fichas da SUA CIDADE
 * (não só do centro da ficha dele) de quem está abaixo dele — ativar e
 * desativar, posto (até team leader), centro (da cidade), tipo e datas de
 * contrato. O dinheiro (salário, subsídio) e a identidade (email de trabalho,
 * conta associada) continuam só admin+.
 *
 * Jorge (7 out 2026): o back office está na MESMA posição do supervisor e gere
 * o RH a nível nacional, sem ordenados — as mesmas regras do supervisor, em
 * todas as cidades (RH_MANAGER_ROLES).
 */
export type RhRole = string;

import { ROLE_RANK as RANK, roleRank, isNationalRole } from "../shared/access";
export const rank = (role: string) => roleRank(role);

export interface RhViewer {
  id: number;
  role: string;
  /** ficha do próprio (se existir) */
  employeeId: number | null;
  /** centros (com descendentes) que supervisor/team_leader/frontoffice gerem */
  scopeProjectIds: number[] | null;
  /** 41c: o supervisor com todas as cidades (permissão "todas as cidades"). */
  scopeAll?: boolean;
}

export interface EmployeeRef {
  id: number;
  projectId: number | null;
  /** role da conta associada à ficha (null/undefined = sem conta ou desconhecido) */
  role?: string | null;
  /** posto da ficha (para fichas sem conta: quem está "abaixo" de um team_leader) */
  position?: string | null;
}

/** Papéis cujo âmbito é o PRÓPRIO centro de custos (com descendentes). */
export const CENTER_SCOPED_ROLES = ["supervisor", "team_leader"] as const;

/** Postos operacionais abaixo de um team_leader (fichas sem conta). */
const BELOW_TL_POSITIONS = ["extra", "driver", "senior_driver"];

/** A ficha é de alguém ABAIXO de quem vê (conta pelo role; sem conta, pelo posto)? */
export function isBelowViewer(v: Pick<RhViewer, "role">, e: EmployeeRef): boolean {
  if (e.role) return rank(e.role) >= 0 && rank(e.role) < rank(v.role);
  if (v.role !== "team_leader") return rank(v.role) > RANK.team_leader;
  return e.position == null || BELOW_TL_POSITIONS.includes(e.position);
}

/** Âmbito de gestor de centro: supervisor = o centro; team_leader = o centro, só quem está abaixo. */
function inManagedScope(v: RhViewer, e: EmployeeRef): boolean {
  if (v.role === "supervisor") return inScope(v, e);
  if (v.role === "team_leader") return inScope(v, e) && isBelowViewer(v, e);
  return false;
}

export function isOwn(v: RhViewer, employeeId: number): boolean {
  return v.employeeId != null && v.employeeId === employeeId;
}

function inScope(v: RhViewer, e: EmployeeRef): boolean {
  return inScopeProject(v, e.projectId);
}

/** O centro de custos está no âmbito de quem vê? PURA. */
export function inScopeProject(v: RhViewer, projectId: number | null | undefined): boolean {
  if (projectId == null) return false;
  if (v.scopeAll) return true;
  return (v.scopeProjectIds ?? []).includes(projectId);
}

/** A ficha é de alguém admin+ com mais poder do que quem está a ver? */
export function isProtectedTarget(v: RhViewer, e: EmployeeRef): boolean {
  const target = rank(e.role ?? "");
  return target >= RANK.admin && rank(v.role) < target;
}

/** Pode ver a ficha (resumo operacional)? */
export function canViewEmployee(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) >= RANK.admin) return true;
  if (isOwn(v, e.id)) return true;
  if (isNationalRole(v.role)) return true;   // frontoffice / backoffice
  return inManagedScope(v, e);
}

/** Pode ver E editar os dados PESSOAIS (NIF, NIB, morada, contactos, foto, documentos)? */
export function canEditPersonal(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return true;
  if (isProtectedTarget(v, e)) return false;
  if (rank(v.role) >= RANK.admin) return true;
  if (isNationalRole(v.role)) return true;   // frontoffice / backoffice
  return inManagedScope(v, e);
}

/**
 * É o RH a tratar desta ficha (19c)? front office / back office / admin+ que
 * pode mexer nos dados pessoais dela — e NUNCA na própria (só o super_admin).
 * Decide: mudar o IBAN sem pedido (e aprovar os pedidos dos outros) e o
 * "Não enviar WhatsApp/email" (decisão do Jorge: só o RH mexe).
 */
export function isRhFor(v: RhViewer, e: EmployeeRef): boolean {
  if (v.role === "super_admin") return true;
  if (isOwn(v, e.id)) return false;
  return isNationalRole(v.role) && canEditPersonal(v, e);
}

/**
 * D49 (Jorge, 3 out 2026): quem muda o IBAN de OUTRA pessoa NA HORA — back
 * office, supervisor e admin (nas fichas cujos dados pessoais pode editar) e
 * o super admin (também o próprio). Front office e team leader não: deixam um
 * pedido, como o próprio no Perfil.
 */
const IBAN_DIRECT_ROLES: ReadonlySet<string> = new Set(["backoffice", "supervisor", "admin"]);
export function canChangeIbanDirectly(v: RhViewer, e: EmployeeRef): boolean {
  if (v.role === "super_admin") return true;
  if (isOwn(v, e.id)) return false;
  return IBAN_DIRECT_ROLES.has(v.role) && canEditPersonal(v, e);
}

/**
 * D49: aprovar/recusar os pedidos de IBAN — o RH que muda na hora: back
 * office e admin (e o super admin). Front office não (aprovar é mudar).
 */
// D49 + Jorge (3 out 2026): o supervisor também aprova (só nas suas cidades — canEditPersonal).
const IBAN_APPROVER_ROLES: ReadonlySet<string> = new Set(["backoffice", "supervisor", "admin"]);
export function canApproveIbanRequests(v: RhViewer, e: EmployeeRef): boolean {
  if (v.role === "super_admin") return true;
  if (isOwn(v, e.id)) return false;
  return IBAN_APPROVER_ROLES.has(v.role) && canEditPersonal(v, e);
}

/** Pode editar o CONTRATUAL (posto, centro, contrato, salário, conta, ativo)? admin+, nunca acima de si. */
export function canEditContract(v: RhViewer, e: EmployeeRef): boolean {
  if (rank(v.role) < RANK.admin) return false;
  return !isProtectedTarget(v, e);
}

/**
 * Quem gere fichas abaixo do supervisor sem ser admin: o supervisor (na sua
 * cidade) e o back office (em todas — Jorge, 7 out 2026: "na mesma posição").
 */
export const RH_MANAGER_ROLES = ["supervisor", "backoffice"] as const;
const isRhManager = (role: string) => (RH_MANAGER_ROLES as readonly string[]).includes(role);
/** O centro de custos serve a quem gere? Back office: todos; supervisor: os da cidade. PURA. */
function managerProjectOk(v: RhViewer, projectId: number | null | undefined): boolean {
  return v.role === "backoffice" ? true : inScopeProject(v, projectId);
}

/** 41c: postos que o supervisor (e o back office) dão (abaixo do supervisor). */
export const SUPERVISOR_ASSIGNABLE_POSITIONS = ["team_leader", "senior_driver", "driver", "extra"] as const;
/** 41c: campos contratuais que o supervisor muda (sem dinheiro nem identidade). */
export const SUPERVISOR_CONTRACT_FIELDS = ["position", "extraLevel", "department", "projectId", "contractType", "contractStart", "contractEnd", "isActive"] as const;

/** A ficha é de alguém abaixo de um supervisor? Conta pelo papel; sem conta, pelo posto. */
function belowSupervisor(e: EmployeeRef): boolean {
  if (e.role) return rank(e.role) >= 0 && rank(e.role) < RANK.supervisor;
  return e.position == null || (SUPERVISOR_ASSIGNABLE_POSITIONS as readonly string[]).includes(e.position);
}

/**
 * 41c: GERIR a ficha (ativar/desativar, posto, centro, contrato sem dinheiro,
 * horário, ausências, revisão do ponto): admin+ (não protegido), ou o
 * supervisor nas fichas da sua cidade de quem está abaixo dele — nunca a dele.
 */
export function canManageEmployee(v: RhViewer, e: EmployeeRef): boolean {
  if (canEditContract(v, e)) return true;
  return isRhManager(v.role) && !isOwn(v, e.id) && (v.role === "backoffice" || inScope(v, e)) && belowSupervisor(e);
}

/**
 * 41c: erro (PT-PT) ao mudar estes campos contratuais nesta ficha, ou null.
 * admin+: tudo. Supervisor: só SUPERVISOR_CONTRACT_FIELDS, postos abaixo
 * dele e centros da sua cidade. PURA.
 */
export function contractEditError(v: RhViewer, e: EmployeeRef, sent: Record<string, unknown>): string | null {
  const keys = (CONTRACT_FIELDS as readonly string[]).filter((k) => sent[k] !== undefined);
  if (!keys.length || canEditContract(v, e)) return null;
  if (!canManageEmployee(v, e)) return "Só admin pode alterar dados contratuais (posto, centro, contrato, salário, conta).";
  if (keys.some((k) => !(SUPERVISOR_CONTRACT_FIELDS as readonly string[]).includes(k))) {
    return "O salário, o subsídio de alimentação, o email de trabalho e a conta associada só um administrador muda.";
  }
  if (sent.position !== undefined && !(SUPERVISOR_ASSIGNABLE_POSITIONS as readonly unknown[]).includes(sent.position)) {
    return "Só se dão postos abaixo do supervisor: team leader, condutor sénior, condutor ou extra.";
  }
  if (sent.projectId !== undefined && !(typeof sent.projectId === "number" && managerProjectOk(v, sent.projectId))) {
    return "Esse centro de custos não é da tua cidade.";
  }
  return null;
}

/**
 * 41c: criar uma ficha — admin+ tudo; o supervisor cria na sua cidade, com
 * posto abaixo dele, sem salário/subsídio nem conta escolhida à mão. PURA.
 */
export function createEmployeeError(v: RhViewer, input: { position: string; projectId: number | null; monthlySalary?: unknown; mealAllowancePerDay?: unknown; userId?: unknown }): string | null {
  if (rank(v.role) >= RANK.admin) return null;
  if (!isRhManager(v.role)) return "Só um administrador, o back office ou o supervisor da cidade cria fichas.";
  if (!(SUPERVISOR_ASSIGNABLE_POSITIONS as readonly string[]).includes(input.position)) {
    return "Só se criam fichas abaixo do supervisor: team leader, condutor sénior, condutor ou extra.";
  }
  if (input.monthlySalary != null && input.monthlySalary !== "" || input.mealAllowancePerDay != null && input.mealAllowancePerDay !== "") {
    return "O salário e o subsídio de alimentação só um administrador põe.";
  }
  if (input.userId != null) return "Ligar a ficha a uma conta escolhida à mão é com um administrador (a conta liga-se sozinha pelo email).";
  if (!managerProjectOk(v, input.projectId)) return "Esse centro de custos não é da tua cidade.";
  return null;
}

/**
 * 41c: o que o próprio carrega na sua ficha — os documentos dele. Contrato,
 * anexos, termo de responsabilidade e seguro são do RH (contam para a lista
 * obrigatória). PURA.
 */
export const SELF_UPLOAD_DOC_TYPES = ["id_card", "residence_permit", "driving_license", "nib_proof", "address_proof", "photo", "other"] as const;
export function selfUploadDocTypeError(v: RhViewer, e: EmployeeRef, docType: string): string | null {
  if (!isOwn(v, e.id) || rank(v.role) >= RANK.admin) return null;
  return (SELF_UPLOAD_DOC_TYPES as readonly string[]).includes(docType) ? null
    : "Esse documento (contrato, anexo, termo ou seguro) é o RH que o carrega na tua ficha.";
}

/** Pode ver dados SENSÍVEIS de gestão (salário, subsídio, bloqueio, desativação)? admin+ (não protegido) ou o próprio. */
export function canViewSensitive(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return true;
  return canEditContract(v, e);
}

/** Pode ver/abrir/carregar documentos pessoais? Quem pode mexer nos dados pessoais. */
export function canViewDocuments(v: RhViewer, e: EmployeeRef): boolean {
  return canEditPersonal(v, e);
}

/**
 * Jorge (7 out 2026): quem VALIDA/RECUSA os documentos e a carta desta ficha
 * — o RH dela: front office / back office / admin+ (isRhFor) e quem a gere
 * (supervisor da cidade, back office, admin — canManageEmployee). NUNCA na
 * própria ficha (nem o super admin: ninguém valida os seus papéis). O team
 * leader carrega, mas não valida. PURA.
 */
export function canValidateDocuments(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return false;
  return isRhFor(v, e) || canManageEmployee(v, e);
}

/** Estado com que entra um ficheiro novo: o que o RH carrega já vem validado; o resto fica pendente. PURA. */
export function initialDocumentStatus(v: RhViewer, e: EmployeeRef): "pending" | "validated" {
  return canValidateDocuments(v, e) ? "validated" : "pending";
}

/**
 * Jorge (7 out 2026): a pessoa entrega os seus documentos a 1.ª vez e pode
 * voltar a entregar enquanto estão pendentes ou depois de recusados — NUNCA
 * depois de validados (só o RH substitui). Vale também para quem carrega por
 * ela sem ser RH (team leader). "Outros" não tranca (são documentos soltos).
 * `activeStatuses` = estados dos ficheiros ATIVOS desse tipo. Erro (PT-PT) ou null. PURA.
 */
export function documentUploadError(v: RhViewer, e: EmployeeRef, docType: string, activeStatuses: readonly string[]): string | null {
  if (canValidateDocuments(v, e)) return null;
  if (docType === "other") return null;
  if (!activeStatuses.includes("validated")) return null;
  return isOwn(v, e.id)
    ? "Este documento já foi validado pelo RH e já não o podes substituir. Se mudou (ex.: renovaste-o), pede ao RH para o trocar."
    : "Este documento já foi validado pelo RH: só o RH o substitui.";
}

/**
 * Pode arquivar ("apagar") um documento? Admin+ (não protegido) e o RH da
 * ficha: sempre (substituir = arquivar). Quem o carregou e ainda mexe na
 * ficha: só enquanto NÃO está validado. PURA.
 */
export function canDeleteDocument(v: RhViewer, e: EmployeeRef, uploadedById: number | null | undefined, status?: string | null): boolean {
  if (canEditContract(v, e) || canValidateDocuments(v, e)) return true;
  if (status === "validated") return false;
  return uploadedById != null && uploadedById === v.id && canEditPersonal(v, e);
}

/**
 * Jorge (7 out 2026): notas internas — team leader e acima, no âmbito de cada
 * um (o mesmo de "ver a ficha": TL só quem está abaixo no seu centro,
 * supervisor a cidade, nacionais e admin tudo), nunca fichas de quem está
 * acima (admin/super admin protegidos) e NUNCA a própria ficha. PURA.
 */
export function canViewInternalNotes(v: RhViewer, e: EmployeeRef): boolean {
  if (isOwn(v, e.id)) return false;
  if (rank(v.role) < RANK.team_leader) return false;
  if (isProtectedTarget(v, e)) return false;
  return canViewEmployee(v, e);
}
/** Escrever = ler (quem lê as notas também as escreve). PURA. */
export const canWriteInternalNotes = canViewInternalNotes;

/**
 * Editar/arquivar uma nota: o autor nas primeiras 24 h, ou um administrador
 * do RH (admin+) — sempre com acesso às notas desta ficha. PURA.
 */
export function canEditInternalNote(
  v: RhViewer, e: EmployeeRef,
  note: { authorId: number; createdAtMs: number },
  nowMs: number, windowMs = 24 * 60 * 60 * 1000,
): boolean {
  if (!canViewInternalNotes(v, e)) return false;
  if (isRhAdmin(v)) return true;
  return note.authorId === v.id && nowMs - note.createdAtMs >= 0 && nowMs - note.createdAtMs <= windowMs;
}

/** Pode ver horário e registos de ponto? quem vê documentos, ou team_leader
 * (operação) — mas só no SEU centro de custos (com descendentes), nunca
 * fichas de outras cidades/centros. */
export function canViewTimeAndSchedule(v: RhViewer, e: EmployeeRef): boolean {
  return canViewDocuments(v, e);
}

/** Campos que ligam a ficha a uma conta (identidade): só admin+ (não protegido)
 * os altera — mesmo na própria ficha, para ninguém se "ligar" a outra conta. */
export const IDENTITY_FIELDS = ["email", "personalEmail"] as const;
export function canEditIdentity(v: RhViewer, e: EmployeeRef): boolean {
  return canEditContract(v, e);
}

/**
 * Leitura de registos de uma ficha (horas, férias, salário, penalizações):
 * a própria passa sempre; senão exige `minRole` E que a ficha esteja no
 * âmbito de cidade do pedido (`scopedProjectIds` undefined = todas as
 * cidades). Vale também para admin: um admin limitado a uma cidade não lê
 * fichas de outra.
 */
export function canReadEmployeeRecord(
  v: Pick<RhViewer, "role" | "employeeId">,
  e: { id: number; projectId: number | null },
  minRole: string,
  scopedProjectIds: number[] | undefined,
): boolean {
  if (v.employeeId != null && v.employeeId === e.id) return true;
  if (rank(v.role) < rank(minRole)) return false;
  if (scopedProjectIds === undefined) return true;
  return e.projectId != null && scopedProjectIds.includes(e.projectId);
}

/** Campos da ficha que são DADOS PESSOAIS (o próprio e os gestores do centro editam). */
export const PERSONAL_FIELDS = ["fullName", "phone", "personalEmail", "personalPhone", "nif", "nib", "address", "birthDate", "nationality", "photoUrl", "photoKey", "idDocNumber", "drivingLicenseNumber"] as const;
/** Campos CONTRATUAIS / de gestão (só admin+). */
export const CONTRACT_FIELDS = ["email", "position", "extraLevel", "department", "projectId", "contractType", "contractStart", "contractEnd", "monthlySalary", "mealAllowancePerDay", "userId", "isActive"] as const;

// Sensível pessoal: escondido a quem só vê a lista operacional.
const PERSONAL_SENSITIVE = ["nif", "nib", "address", "birthDate", "nationality", "personalEmail", "personalPhone"] as const;
// Sensível de gestão: só admin+ (não protegido) ou o próprio. O MOTIVO/notas
// da desativação (0071) seguem a mesma regra do motivo de bloqueio: quem só
// vê a lista operacional vê "Inativo", nunca o porquê.
const ADMIN_SENSITIVE = ["monthlySalary", "mealAllowancePerDay", "loginBlockedReason", "docsWarningAt", "deactivationReason", "deactivationReasonOther", "deactivationNotes", "deactivatedById"] as const;

/** Remove campos sensíveis quando o visualizador não os pode ver. `role` é o da conta associada à ficha. */
export function sanitizeEmployee<T extends Record<string, any>>(v: RhViewer, emp: T, role?: string | null): T {
  const ref: EmployeeRef = { id: emp.id, projectId: emp.projectId ?? null, role: role ?? null, position: emp.position ?? null };
  if (canViewSensitive(v, ref)) return emp;
  const out: Record<string, any> = { ...emp };
  for (const f of ADMIN_SENSITIVE) if (f in out) out[f] = null;
  if (!canEditPersonal(v, ref)) for (const f of PERSONAL_SENSITIVE) if (f in out) out[f] = null;
  return out as T;
}

/** Aplica a lista: filtra o que não pode ver e limpa o sensível. `roleOf` dá o role da conta de cada ficha. */
export function sanitizeEmployeeRows<T extends { employee: Record<string, any> }>(
  v: RhViewer,
  rows: T[],
  roleOf?: (emp: Record<string, any>) => string | null | undefined,
): T[] {
  return rows
    .filter((r) => canViewEmployee(v, { id: r.employee.id, projectId: r.employee.projectId ?? null, role: roleOf?.(r.employee) ?? null, position: r.employee.position ?? null }))
    .map((r) => ({ ...r, employee: sanitizeEmployee(v, r.employee, roleOf?.(r.employee) ?? null) }));
}

/** O que o visualizador pode fazer nesta ficha — vai para o cliente decidir a UI. */
export function employeeAccess(v: RhViewer, e: EmployeeRef) {
  return {
    isOwn: isOwn(v, e.id),
    canEditPersonal: canEditPersonal(v, e),
    canEditContract: canEditContract(v, e),
    /** 41c: ativar/desativar, posto, centro e contrato sem dinheiro (admin+ ou supervisor da cidade). */
    canManage: canManageEmployee(v, e),
    canViewSensitive: canViewSensitive(v, e),
    canViewDocuments: canViewDocuments(v, e),
    /** 19c: RH desta ficha — mexe no "Não enviar". */
    isRh: isRhFor(v, e),
    /** D49: muda o IBAN desta ficha na hora (sem pedido). */
    canChangeIban: canChangeIbanDirectly(v, e),
    /** D49: aprova/recusa pedidos de IBAN desta ficha. */
    canApproveIban: canApproveIbanRequests(v, e),
    /** Jorge, 7 out 2026: valida/recusa os documentos e a carta desta ficha. */
    canValidateDocuments: canValidateDocuments(v, e),
    /** Jorge, 7 out 2026: lê e escreve as notas internas (nunca a própria ficha). */
    canViewNotes: canViewInternalNotes(v, e),
  };
}
export type EmployeeAccess = ReturnType<typeof employeeAccess>;

/** admin+ vê tudo — mesmo fichas que já não existem (listas vazias, checklists). */
export function isRhAdmin(v: RhViewer): boolean {
  return rank(v.role) >= RANK.admin;
}

/**
 * Pode `reviewer` confirmar/anular uma penalização (pontos)? Devolve o erro
 * (PT-PT) ou null. Aos 3 pontos confirmados o login fica bloqueado, por isso:
 *  - só supervisor ou acima (antes bastava editar Perdidos/RH — um team leader
 *    propunha e confirmava);
 *  - quem PROPÔS não confirma a própria proposta (pode anulá-la).
 */
export function penaltyReviewError(o: { reviewer: { id: number; role: string }; proposedById: number | null | undefined; decision: "confirmed" | "dismissed" }): string | null {
  if (rank(o.reviewer.role) < RANK.supervisor) return "Só um supervisor (ou acima) confirma ou anula pontos.";
  if (o.decision === "confirmed" && o.proposedById != null && o.proposedById === o.reviewer.id) {
    return "Não podes confirmar pontos que tu próprio propuseste: pede a outro supervisor.";
  }
  return null;
}
