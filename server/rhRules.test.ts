import { describe, expect, it } from "vitest";
import { classifyAvailabilityReply, isExplicitShiftConfirm, replyOnly } from "./availabilityReply";
import { canDeleteDocument, canEditContract, canEditPersonal, canViewDocuments, canViewEmployee, canViewSensitive, canViewTimeAndSchedule, employeeAccess, isProtectedTarget, sanitizeEmployee, sanitizeEmployeeRows, type RhViewer } from "./rhAccess";
import { csvCell, toCsv } from "../shared/csv";

describe("classifyAvailabilityReply", () => {
  it("negações deixam de ser 'sim'", () => {
    expect(classifyAvailabilityReply("Não posso").verdict).toBe("no");
    expect(classifyAvailabilityReply("Nao estou disponível amanhã").verdict).toBe("no");
    expect(classifyAvailabilityReply("Infelizmente não dá").verdict).toBe("no");
    expect(classifyAvailabilityReply("não vou poder, desculpa").verdict).toBe("no");
  });
  it("afirmações limpas são 'sim'", () => {
    expect(classifyAvailabilityReply("Sim, posso").verdict).toBe("yes");
    expect(classifyAvailabilityReply("Ok, conto comigo").verdict).toBe("yes");
    expect(classifyAvailabilityReply("Disponível!").verdict).toBe("yes");
  });
  it("condicionais e misturas vão para revisão, nunca marcam", () => {
    expect(classifyAvailabilityReply("Posso, mas só de manhã").verdict).toBe("unclear");
    expect(classifyAvailabilityReply("talvez, ainda não sei").verdict).toBe("unclear");
    expect(classifyAvailabilityReply("sim não").verdict).toBe("unclear");
    expect(classifyAvailabilityReply("").verdict).toBe("unclear");
    expect(classifyAvailabilityReply("Boa tarde").verdict).toBe("unclear");
  });
  it("ignora a citação do pedido original e o assunto não conta", () => {
    const body = "Não posso.\n\nOn Tue, RH wrote:\n> Podes confirmar? Responde SIM\n> disponível?";
    expect(replyOnly(body)).toBe("Não posso.");
    expect(classifyAvailabilityReply(body).verdict).toBe("no");
  });
  it("'o máximo', 'no máximo' e 'tentar' são condição, nunca um 'sim'", () => {
    for (const t of ["O máximo posso tentar entre as 16h e as 17h", "no máximo às 17h", "vou tentar", "Vou tentar ir", "Posso tentar"]) {
      expect(classifyAvailabilityReply(t).verdict, t).toBe("unclear");
    }
  });
  it("'só às' é condição", () => {
    for (const t of ["Sim, só às 17h", "Ok, só às 18", "Só às 17h", "Não, só às 17h"]) {
      expect(classifyAvailabilityReply(t).verdict, t).toBe("unclear");
    }
  });
  it("'posso' com uma hora é condição", () => {
    for (const t of ["Posso às 17h", "posso as 17", "posso das 16 às 18", "posso 17:30", "posso 17h30", "Sim, posso às 17h", "posso até às 18", "às 17h posso", "posso 17", "posso ao meio-dia"]) {
      expect(classifyAvailabilityReply(t).verdict, t).toBe("unclear");
    }
  });
  it("sem hora nem condição fica como estava", () => {
    for (const t of ["Sim, posso segunda", "Sim", "Confirmo", "Sim, confirmo", "Posso", "Sim, posso dia 17", "posso até dia 17"]) {
      expect(classifyAvailabilityReply(t).verdict, t).toBe("yes");
    }
    // Negado com hora continua a ser um "não"; com um "posso" a seguir já é condição.
    expect(classifyAvailabilityReply("Não posso").verdict).toBe("no");
    expect(classifyAvailabilityReply("Não posso às 17h").verdict).toBe("no");
    expect(classifyAvailabilityReply("Não posso às 17h, posso às 18h").verdict).toBe("unclear");
  });
  it("'Confirmado' ainda não é um 'sim' (fica para a fase 3)", () => {
    expect(classifyAvailabilityReply("Confirmado").verdict).toBe("unclear");
  });
});

describe("isExplicitShiftConfirm", () => {
  it("só quem diz mesmo 'confirmo'", () => {
    for (const t of ["Confirmo", "Sim, confirmo", "confirmo obrigado", "CONFIRMO!", "Confirmo o turno"]) {
      expect(isExplicitShiftConfirm(t), t).toBe(true);
    }
  });
  it("sem a palavra não conta", () => {
    for (const t of ["Sim", "ok", "Sim, posso segunda", "Confirmado", "", "reconfirmo"]) {
      expect(isExplicitShiftConfirm(t), t).toBe(false);
    }
  });
  it("com negação, condição, hora, pergunta ou adiamento não conta", () => {
    for (const t of ["não confirmo", "confirmo mas só às 17h", "confirmo só às 17h", "confirmo às 17h", "Confirmo?", "talvez confirmo", "confirmo se for de manhã", "depois confirmo", "amanhã confirmo"]) {
      expect(isExplicitShiftConfirm(t), t).toBe(false);
    }
  });
  it("confirmar a disponibilidade não é confirmar o turno", () => {
    expect(isExplicitShiftConfirm("Confirmo a minha disponibilidade")).toBe(false);
    expect(isExplicitShiftConfirm("Confirmo, estou disponível")).toBe(false);
  });
  it("só conta a resposta, não a citação", () => {
    expect(isExplicitShiftConfirm("Não posso\n> Confirmo")).toBe(false);
    expect(isExplicitShiftConfirm("Confirmo\n> pedido das 17h?")).toBe(true);
  });
});

describe("rhAccess — permissões por finalidade", () => {
  const admin: RhViewer = { id: 1, role: "admin", employeeId: null, scopeProjectIds: null };
  const front: RhViewer = { id: 2, role: "frontoffice", employeeId: 20, scopeProjectIds: null };
  const sup: RhViewer = { id: 3, role: "supervisor", employeeId: 30, scopeProjectIds: [10, 11] };
  const extra: RhViewer = { id: 4, role: "extra", employeeId: 40, scopeProjectIds: null };
  const other = { id: 99, projectId: 11 };
  const outside = { id: 98, projectId: 50 };

  // Modelo de acessos: frontoffice = backoffice (nacional) sem Permissões.
  it("frontoffice (nacional) vê fichas e documentos de terceiros, mas não o salário", () => {
    expect(canViewEmployee(front, other)).toBe(true);
    expect(canViewSensitive(front, other)).toBe(false);
    expect(canViewDocuments(front, other)).toBe(true);
    expect(canViewDocuments(front, { id: 20, projectId: null })).toBe(true);   // os próprios
  });
  it("supervisor só no seu centro; extra só o próprio (incl. horário e ponto)", () => {
    expect(canViewDocuments(sup, other)).toBe(true);
    expect(canViewDocuments(sup, outside)).toBe(false);
    expect(canViewEmployee(sup, outside)).toBe(false);
    expect(canViewEmployee(extra, other)).toBe(false);
    expect(canViewTimeAndSchedule(extra, { id: 40, projectId: 10 })).toBe(true);
    expect(canViewTimeAndSchedule(extra, other)).toBe(false);
    expect(canViewDocuments(admin, outside)).toBe(true);
  });
  it("sanitize retira NIF/NIB/morada/salário para quem não pode ver", () => {
    const emp = { id: 99, projectId: 11, fullName: "X", nif: "123", nib: "PT50", address: "Rua", birthDate: "1990-01-01", monthlySalary: "1000", phone: "9" };
    const s = sanitizeEmployee(extra, emp);
    expect(s.nif).toBeNull(); expect(s.nib).toBeNull(); expect(s.address).toBeNull(); expect(s.monthlySalary).toBeNull();
    expect(s.phone).toBe("9"); expect(s.fullName).toBe("X");
    // frontoffice (nacional): dados pessoais sim, salário não
    expect(sanitizeEmployee(front, emp).nif).toBe("123");
    expect(sanitizeEmployee(front, emp).monthlySalary).toBeNull();
    expect(sanitizeEmployee(admin, emp).nif).toBe("123");
    const rows = sanitizeEmployeeRows(sup, [{ employee: emp }, { employee: { ...emp, id: 98, projectId: 50 } }]);
    expect(rows).toHaveLength(1);
    // supervisor do centro mexe nos dados pessoais → vê NIF; salário continua escondido
    expect(rows[0].employee.nif).toBe("123");
    expect(rows[0].employee.monthlySalary).toBeNull();
  });
});

// Pedido Jorge 17 set 2026: toda a gente mexe na PRÓPRIA ficha (dados
// pessoais, documentos, foto), nunca no contratual; gestores por centro;
// backoffice em todos; admin em tudo menos super_admin; super_admin em tudo.
describe("rhAccess — dados pessoais vs contratuais", () => {
  const superAdmin: RhViewer = { id: 1, role: "super_admin", employeeId: 10, scopeProjectIds: null };
  const admin: RhViewer = { id: 2, role: "admin", employeeId: 20, scopeProjectIds: null };
  const back: RhViewer = { id: 3, role: "backoffice", employeeId: 30, scopeProjectIds: null };
  const tl: RhViewer = { id: 4, role: "team_leader", employeeId: 40, scopeProjectIds: [100, 101] };
  const front: RhViewer = { id: 5, role: "frontoffice", employeeId: 50, scopeProjectIds: [100] };
  const sup: RhViewer = { id: 6, role: "supervisor", employeeId: 60, scopeProjectIds: [100, 101] };
  const extra: RhViewer = { id: 7, role: "extra", employeeId: 70, scopeProjectIds: null };
  const plainUser: RhViewer = { id: 8, role: "user", employeeId: null, scopeProjectIds: null };

  const driverInCenter = { id: 900, projectId: 101, role: "user" };
  const driverOutside = { id: 901, projectId: 200, role: "extra" };
  const noAccount = { id: 902, projectId: 100, role: null };
  const adminFile = { id: 20, projectId: 100, role: "admin" };
  const superFile = { id: 10, projectId: 100, role: "super_admin" };

  it("toda a gente mexe na própria ficha, mas só no pessoal", () => {
    expect(canEditPersonal(extra, { id: 70, projectId: null })).toBe(true);
    expect(canEditContract(extra, { id: 70, projectId: null })).toBe(false);
    expect(canViewDocuments(extra, { id: 70, projectId: null })).toBe(true);
    expect(canEditPersonal(front, { id: 50, projectId: 300 })).toBe(true);   // fora do seu centro, mas é ele
    expect(canEditPersonal(tl, { id: 40, projectId: null })).toBe(true);
    // sem ficha associada não há "próprio"
    expect(canEditPersonal(plainUser, driverInCenter)).toBe(false);
    expect(canEditPersonal(extra, driverInCenter)).toBe(false);
  });

  it("team_leader e supervisor: só o seu centro de custos; frontoffice: nacional", () => {
    for (const v of [tl, sup]) {
      expect(canEditPersonal(v, driverInCenter)).toBe(true);
      expect(canEditPersonal(v, noAccount)).toBe(true);
      expect(canEditPersonal(v, driverOutside)).toBe(false);
      expect(canEditContract(v, noAccount)).toBe(false);
      expect(canViewDocuments(v, noAccount)).toBe(true);
      expect(canViewDocuments(v, driverOutside)).toBe(false);
    }
    expect(canEditPersonal(front, driverOutside)).toBe(true);
    expect(canEditContract(front, driverOutside)).toBe(false);
  });

  it("team_leader: só quem está ABAIXO dele (utilizadores, extras, condutores)", () => {
    const tlFile = { id: 903, projectId: 100, role: "team_leader" };
    const supFile = { id: 904, projectId: 100, role: "supervisor" };
    const condutorFile = { id: 905, projectId: 100, role: "condutor" };
    const staffNoAccount = { id: 906, projectId: 100, role: null, position: "backoffice" };
    const driverNoAccount = { id: 907, projectId: 100, role: null, position: "driver" };
    expect(canEditPersonal(tl, condutorFile)).toBe(true);
    expect(canEditPersonal(tl, tlFile)).toBe(false);
    expect(canEditPersonal(tl, supFile)).toBe(false);
    expect(canViewEmployee(tl, supFile)).toBe(false);
    expect(canEditPersonal(tl, staffNoAccount)).toBe(false);
    expect(canEditPersonal(tl, driverNoAccount)).toBe(true);
    // o supervisor vê o centro todo (menos admins)
    expect(canEditPersonal(sup, tlFile)).toBe(true);
  });

  it("backoffice: todos os centros, nunca fichas de admin/super_admin", () => {
    expect(canEditPersonal(back, driverInCenter)).toBe(true);
    expect(canEditPersonal(back, driverOutside)).toBe(true);
    expect(canEditPersonal(back, adminFile)).toBe(false);
    expect(canEditPersonal(back, superFile)).toBe(false);
    expect(canEditContract(back, driverInCenter)).toBe(false);
    expect(canViewSensitive(back, driverInCenter)).toBe(false);   // salário continua fora
  });

  it("gestores de centro também não tocam em admin/super_admin do seu centro", () => {
    expect(isProtectedTarget(tl, adminFile)).toBe(true);
    expect(canEditPersonal(tl, adminFile)).toBe(false);
    expect(canEditPersonal(sup, superFile)).toBe(false);
    expect(canViewDocuments(front, adminFile)).toBe(false);
  });

  it("admin: tudo menos super_admin; super_admin: tudo", () => {
    expect(canEditPersonal(admin, driverOutside)).toBe(true);
    expect(canEditContract(admin, driverOutside)).toBe(true);
    expect(canEditContract(admin, adminFile)).toBe(true);        // outro admin: pode (mesmo nível)
    expect(canEditPersonal(admin, superFile)).toBe(false);
    expect(canEditContract(admin, superFile)).toBe(false);
    expect(canViewSensitive(admin, superFile)).toBe(false);
    expect(canViewDocuments(admin, superFile)).toBe(false);
    expect(canEditContract(superAdmin, superFile)).toBe(true);
    expect(canEditContract(superAdmin, adminFile)).toBe(true);
    expect(canEditPersonal(superAdmin, driverOutside)).toBe(true);
  });

  it("apagar (arquivar) documentos: admin+ e o RH da ficha, ou quem carregou e ainda mexe na ficha", () => {
    expect(canDeleteDocument(admin, driverInCenter, 99)).toBe(true);
    expect(canDeleteDocument(back, driverInCenter, back.id)).toBe(true);
    // Jorge (7 out 2026): o back office é o RH desta ficha — substitui (arquiva) o que outros carregaram.
    expect(canDeleteDocument(back, driverInCenter, 99)).toBe(true);
    expect(canDeleteDocument(tl, driverOutside, tl.id)).toBe(false);   // fora do centro
    expect(canDeleteDocument(extra, { id: 70, projectId: null }, extra.id)).toBe(true);
    expect(canDeleteDocument(extra, { id: 70, projectId: null }, 2)).toBe(false);
  });

  it("sanitize: pessoal visível a quem o pode editar; salário só admin+/próprio; ficha protegida esconde tudo", () => {
    const emp = { id: 900, projectId: 101, fullName: "X", nif: "123", nib: "PT50", address: "Rua", monthlySalary: "1000", deactivationReason: "other", phone: "9" };
    const asBack = sanitizeEmployee(back, emp, "user");
    expect(asBack.nif).toBe("123"); expect(asBack.address).toBe("Rua");
    expect(asBack.monthlySalary).toBeNull(); expect(asBack.deactivationReason).toBeNull();
    const asTlOutside = sanitizeEmployee(tl, { ...emp, projectId: 200 }, "user");
    expect(asTlOutside.nif).toBeNull(); expect(asTlOutside.phone).toBe("9");
    const adminEmp = { ...emp, id: 20, projectId: 100 };
    expect(sanitizeEmployee(back, adminEmp, "admin").nif).toBeNull();
    expect(sanitizeEmployee(admin, { ...emp, id: 10 }, "super_admin").nif).toBeNull();
    expect(sanitizeEmployee(admin, { ...emp, id: 10 }, "super_admin").monthlySalary).toBeNull();
    // o próprio vê tudo o que é seu
    expect(sanitizeEmployee(extra, { ...emp, id: 70 }, "extra").monthlySalary).toBe("1000");
    // lista: roleOf protege as fichas de admin no meio das outras
    const rows = sanitizeEmployeeRows(back, [{ employee: emp }, { employee: adminEmp }], (e) => (e.id === 20 ? "admin" : "user"));
    expect(rows[0].employee.nif).toBe("123");
    expect(rows[1].employee.nif).toBeNull();
  });

  it("employeeAccess resume o que o cliente pode mostrar", () => {
    expect(employeeAccess(extra, { id: 70, projectId: null })).toEqual({ isOwn: true, canEditPersonal: true, canEditContract: false, canManage: false, canViewSensitive: true, canViewDocuments: true, isRh: false, canChangeIban: false, canApproveIban: false, canValidateDocuments: false, canViewNotes: false });
    expect(employeeAccess(tl, driverOutside)).toEqual({ isOwn: false, canEditPersonal: false, canEditContract: false, canManage: false, canViewSensitive: false, canViewDocuments: false, isRh: false, canChangeIban: false, canApproveIban: false, canValidateDocuments: false, canViewNotes: false });
    expect(employeeAccess(admin, driverOutside)).toEqual({ isOwn: false, canEditPersonal: true, canEditContract: true, canManage: true, canViewSensitive: true, canViewDocuments: true, isRh: true, canChangeIban: true, canApproveIban: true, canValidateDocuments: true, canViewNotes: true });
  });
});

describe("csv seguro", () => {
  it("escapa separador, aspas, quebras e fórmulas", () => {
    expect(csvCell("Rua A; nº 3")).toBe('"Rua A; nº 3"');
    expect(csvCell('diz "olá"')).toBe('"diz ""olá"""');
    expect(csvCell("linha\nnova")).toBe('"linha\nnova"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+351 9")).toBe("'+351 9");
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [["1", "x;y"]])).toBe('a;b\n1;"x;y"');
  });
});
