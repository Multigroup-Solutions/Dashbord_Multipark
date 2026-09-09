import { describe, expect, it } from "vitest";
import { classifyAvailabilityReply, replyOnly } from "./availabilityReply";
import { canViewDocuments, canViewEmployee, canViewSensitive, canViewTimeAndSchedule, sanitizeEmployee, sanitizeEmployeeRows, type RhViewer } from "./rhAccess";
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
    expect(rows[0].employee.nif).toBeNull();
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
