/**
 * Frente A (Jorge, 7 out 2026) — o que a interface tem de mostrar: carta,
 * documentos por validar e notas internas. As regras estão testadas em
 * cartaConducao.test.ts e rhDocsNotas.test.ts; aqui só se confirma que o
 * cliente as usa (o cliente não tem testes próprios).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("Extras-dia: carta no seletor e aviso ao escalar; atalho das notas", () => {
  it("etiqueta só quando a carta NÃO está validada; aviso ao escolher, sem bloquear o Adicionar", () => {
    expect(src("client/src/pages/extrasDia/PersonPicker.tsx")).toMatch(/c\.licence && c\.licence !== "validated" && <LicenceBadge/);
    const page = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(page).toMatch(/<LicenceWarning status=\{\[\.\.\.candidates, \.\.\.\(others \?\? \[\]\)\]\.find\(x => x\.id === employeeId\)\?\.licence\}/);
    expect(page).toMatch(/const valid = employeeId != null && !pickedOther && span >= 3 && span <= 12;/);
  });
  it("nota interna a partir da linha da escala, já com o dia e a linha; só TL e acima com RH", () => {
    expect(src("client/src/pages/ExtrasDiaPage.tsx")).toMatch(/<QuickNoteButton employeeId=\{a\.employeeId\} name=\{a\.personName\} workDate=\{a\.assignmentDate\} assignmentId=\{a\.id\} \/>/);
    const q = src("client/src/pages/extrasDia/QuickNoteButton.tsx");
    expect(q).toMatch(/roleRank\(user\.role\) >= roleRank\("team_leader"\) && can\(user as any, "rh", "view"\)/);
    expect(q).toMatch(/<EmployeeNotesPanel employeeId=\{employeeId\} workDate=\{workDate\} assignmentId=\{assignmentId\} limit=\{5\} \/>/);
  });
});

describe("RH: ficha, lista e ecrã de bloqueio", () => {
  const hr = src("client/src/pages/HRPage.tsx");
  it("separador 'Notas internas' só com canViewNotes (nunca na própria ficha)", () => {
    expect(hr).toMatch(/\{access\.canViewNotes && <TabsTrigger value="notes">/);
    expect(hr).toMatch(/\{access\.canViewNotes && <TabsContent value="notes"/);
  });
  it("documentos: estado em cada ficheiro, Validar/Recusar para o RH, trancado depois de validado", () => {
    expect(hr).toMatch(/<DocStatusBadge status=\{\(doc as any\)\.status\} reason=\{\(doc as any\)\.rejectedReason\} \/>/);
    expect(hr).toMatch(/validateDoc\.mutate\(\{ id: doc\.id \}\)/);
    expect(hr).toMatch(/<RejectDocumentDialog doc=\{rejecting\}/);
    expect(hr).toMatch(/const lockedType = \(t: DocType\) => !canValidate && t !== "other" && docs\.some/);
  });
  it("lista: etiqueta da carta, 'N por validar' e filtros Carta / Documentos por validar", () => {
    expect(hr).toMatch(/<SelectItem value="to_validate">Documentos por validar<\/SelectItem>/);
    expect(hr).toMatch(/LICENCE_STATUSES\.map\(\(s\) => <SelectItem key=\{s\} value=\{s\}>\{LICENCE_STATUS_LABELS\[s\]\}<\/SelectItem>\)/);
    expect(hr).toMatch(/\{status\.pendingCount\} por validar/);
    expect(hr).toMatch(/docsSummaryLabel\(docs\)/);
  });
  it("o ecrã de bloqueio mostra o que está pendente e o que foi recusado", () => {
    const b = src("client/src/components/BlockedOwnDocuments.tsx");
    expect(b).toMatch(/Enviado — pendente de validação/);
    expect(b).toMatch(/Recusado: /);
  });
});
