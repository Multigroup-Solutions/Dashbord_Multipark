import { describe, expect, it } from "vitest";
import { classifyAvailabilityReply, replyOnly } from "./availabilityReply";
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
});

describe("rhAccess — permissões por finalidade", () => {
  const admin: RhViewer = { id: 1, role: "admin", employeeId: null, scopeProjectIds: null };
  const front: RhViewer = { id: 2, role: "frontoffice", employeeId: 20, scopeProjectIds: null };
  const sup: RhViewer = { id: 3, role: "supervisor", employeeId: 30, scopeProjectIds: [10, 11] };
  const extra: RhViewer = { id: 4, role: "extra", employeeId: 40, scopeProjectIds: null };
  const other = { id: 99, projectId: 11 };
  const outside = { id: 98, projectId: 50 };

  it("frontoffice vê a lista operacional mas não documentos nem dados sensíveis de terceiros", () => {
    expect(canViewEmployee(front, other)).toBe(true);
    expect(canViewSensitive(front, other)).toBe(false);
    expect(canViewDocuments(front, other)).toBe(false);
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
    const s = sanitizeEmployee(front, emp);
    expect(s.nif).toBeNull(); expect(s.nib).toBeNull(); expect(s.address).toBeNull(); expect(s.monthlySalary).toBeNull();
    expect(s.phone).toBe("9"); expect(s.fullName).toBe("X");
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

  it("team_leader, supervisor e frontoffice: só o seu centro de custos", () => {
    for (const v of [tl, sup, front]) {
      expect(canEditPersonal(v, driverInCenter)).toBe(v !== front);   // 101 só está no scope de tl/sup
      expect(canEditPersonal(v, noAccount)).toBe(true);               // 100 está em todos
      expect(canEditPersonal(v, driverOutside)).toBe(false);
      expect(canEditContract(v, noAccount)).toBe(false);
      expect(canViewDocuments(v, noAccount)).toBe(true);
      expect(canViewDocuments(v, driverOutside)).toBe(false);
    }
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

  it("apagar documentos: admin+, ou quem carregou e ainda mexe na ficha", () => {
    expect(canDeleteDocument(admin, driverInCenter, 99)).toBe(true);
    expect(canDeleteDocument(back, driverInCenter, back.id)).toBe(true);
    expect(canDeleteDocument(back, driverInCenter, 99)).toBe(false);
    expect(canDeleteDocument(tl, driverOutside, tl.id)).toBe(false);   // fora do centro
    expect(canDeleteDocument(extra, { id: 70, projectId: null }, extra.id)).toBe(true);
    expect(canDeleteDocument(extra, { id: 70, projectId: null }, 2)).toBe(false);
  });

  it("sanitize: pessoal visível a quem o pode editar; salário só admin+/próprio; ficha protegida esconde tudo", () => {
    const emp = { id: 900, projectId: 101, fullName: "X", nif: "123", nib: "PT50", address: "Rua", monthlySalary: "1000", deactivationReason: "other", phone: "9" };
    const asBack = sanitizeEmployee(back, emp, "user");
    expect(asBack.nif).toBe("123"); expect(asBack.address).toBe("Rua");
    expect(asBack.monthlySalary).toBeNull(); expect(asBack.deactivationReason).toBeNull();
    const asFrontOutside = sanitizeEmployee(front, emp, "user");
    expect(asFrontOutside.nif).toBeNull(); expect(asFrontOutside.phone).toBe("9");
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
    expect(employeeAccess(extra, { id: 70, projectId: null })).toEqual({ isOwn: true, canEditPersonal: true, canEditContract: false, canViewSensitive: true, canViewDocuments: true });
    expect(employeeAccess(tl, driverOutside)).toEqual({ isOwn: false, canEditPersonal: false, canEditContract: false, canViewSensitive: false, canViewDocuments: false });
    expect(employeeAccess(admin, driverOutside)).toEqual({ isOwn: false, canEditPersonal: true, canEditContract: true, canViewSensitive: true, canViewDocuments: true });
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
