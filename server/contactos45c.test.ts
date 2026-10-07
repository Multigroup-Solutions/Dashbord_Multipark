/**
 * Lote 45c (Jorge, 7 out 2026): Críticas e Reclamações sem os botões que não
 * faziam nada; Contactos com filtros e ordem por cima da lista (em todos os
 * tipos) e importar contactos de um ficheiro.
 */
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { mapCsvHeader, parseContactFile, parseContactsCsv, parseVcards, splitCsvLine } from "../shared/contactImport";
import { nextNameSort } from "../shared/contacts";
import { cityScope } from "./cityScope";
import { importCrmContacts } from "./contactsRouter";

const src = (p: string) => readFileSync(p, "utf8");
const dialect = new MySqlDialect();

describe("Críticas e Reclamações: sem botões que não faziam nada", () => {
  it("Críticas sem \"Sincronizar Gmail\" nem \"Importar Review\" no topo", () => {
    const s = src("client/src/pages/GoogleReviewsPage.tsx");
    expect(s).not.toContain('"Sincronizar Gmail"}');
    expect(s).not.toContain("Importar Review</Button>");
    expect(s).not.toContain("CreateReviewDialog");
    expect(s).not.toContain("syncFromGmail");
  });
  it("Reclamações sem \"Sincronizar emails\"", () => {
    const s = src("client/src/pages/ComplaintsPage.tsx");
    expect(s).not.toContain("<SyncEmailsButton");
    expect(s).not.toContain("runEmailInbound");
  });
});

describe("Importar contactos: ler o ficheiro", () => {
  it("CSV do Google Contactos (primeiro + último nome, vários emails num campo)", () => {
    const csv = [
      "First Name,Middle Name,Last Name,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Organization Name",
      'Ana,,Silva,* Home,ana@x.pt ::: ana2@x.pt,Mobile,+351 912 345 678,"Acme, Lda"',
      "Rui,,Costa,,,Mobile,913 000 111,",
      ",,,,,,,",
    ].join("\n");
    expect(parseContactsCsv(csv)).toEqual([
      { name: "Ana Silva", email: "ana@x.pt", phone: "+351 912 345 678", company: "Acme, Lda" },
      { name: "Rui Costa", email: null, phone: "913 000 111", company: null },
    ]);
  });
  it("CSV do Excel em português (ponto e vírgula, acentos no cabeçalho, BOM)", () => {
    const csv = "﻿Nome;Email;Telemóvel;Empresa\r\nJoão Sá;JOAO@SA.PT;912000000;Sá & Filhos\r\n";
    expect(parseContactsCsv(csv)).toEqual([{ name: "João Sá", email: "joao@sa.pt", phone: "912000000", company: "Sá & Filhos" }]);
  });
  it("CSV do Outlook e aspas com vírgulas e quebras de linha", () => {
    const csv = 'First Name,Last Name,E-mail Address,Mobile Phone,Company\n"Maria","Lopes","m@l.pt","+34 600 000 000","Empresa ""X"", SA"\n';
    expect(parseContactsCsv(csv)).toEqual([{ name: "Maria Lopes", email: "m@l.pt", phone: "+34 600 000 000", company: 'Empresa "X", SA' }]);
    expect(splitCsvLine('a;"b;c";"d""e"', ";")).toEqual(["a", "b;c", 'd"e']);
    expect(mapCsvHeader(["Nome", "E-mail", "Telefone"])).toMatchObject({ name: [0], email: [1], phone: [2] });
  });
  it("vCard (um ou vários; linhas dobradas; N quando não há FN)", () => {
    const vcf = [
      "BEGIN:VCARD", "VERSION:3.0", "FN:Carla Dias", "EMAIL;TYPE=INTERNET:carla@d.pt", "TEL;TYPE=CELL:+351 93", " 0 000 000", "ORG:Dias Lda;Vendas", "END:VCARD",
      "BEGIN:VCARD", "N:Pinto;Luís;;;", "TEL:tel:+351910000000", "END:VCARD",
      "BEGIN:VCARD", "NOTE:sem nada", "END:VCARD",
    ].join("\r\n");
    expect(parseVcards(vcf)).toEqual([
      { name: "Carla Dias", email: "carla@d.pt", phone: "+351 930 000 000", company: "Dias Lda" },
      { name: "Luís Pinto", email: null, phone: "+351910000000", company: null },
    ]);
    expect(parseContactFile(vcf, "contactos.txt")).toHaveLength(2);
    expect(parseContactFile("Nome,Email\nA B,a@b.pt", "x.csv")).toHaveLength(1);
  });
});

describe("Importar contactos: no servidor", () => {
  const fakeDb = (existing: Array<{ email: string | null; phoneE164: string | null }>) => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    return {
      queries, params,
      execute: async (q: any) => {
        const r = dialect.sqlToQuery(q);
        queries.push(r.sql);
        params.push(r.params);
        return /^SELECT/.test(r.sql.trim()) ? [existing] : [{ insertId: 1 }];
      },
    };
  };
  const run = (d: any, rows: any[]) => cityScope.run({ all: false, defaultCityId: 50, cityName: "Porto", cityIds: [50], projectIds: [50, 65], missingCostCenter: false } as any, () => importCrmContacts(d, 7, "client", rows));

  it("não repete (no ficheiro nem no CRM), não muda o que existe, salta linhas sem email/telefone", async () => {
    const d = fakeDb([{ email: "ja@existe.pt", phoneE164: null }]);
    const r = await run(d, [
      { name: "Ana Silva", email: "ANA@x.pt", phone: "912 345 678" },
      { name: "Ana outra vez", email: "ana@x.pt" },
      { name: "Já existe", email: "ja@existe.pt" },
      { name: "Sem nada" },
      { name: "", phone: "913000111" },
    ]);
    expect(r).toEqual({ created: 2, duplicates: 2, invalid: 1 });
    const insert = d.queries.find((q) => q.startsWith("INSERT"))!;
    expect(insert).toContain("INSERT INTO crm_contacts (kind, name, email, phone, phoneE164, company, projectId, source, createdById) VALUES");
    expect(insert).toContain("'import'");
    expect(d.params.at(-1)).toEqual(["client", "Ana Silva", "ana@x.pt", "912 345 678", "+351912345678", null, 50, 7, "client", "+351913000111", null, "913000111", "+351913000111", null, 50, 7]);
    expect(d.queries.some((q) => /\b(UPDATE|DELETE)\b/.test(q))).toBe(false);
    // repetidos procurados só no âmbito de cidade de quem importa
    expect(d.queries.find((q) => q.startsWith("SELECT"))).toContain("c.projectId IN (?, ?)");
  });

  it("só quem pode editar Clientes importa; máximo de 2000 por vez", () => {
    const r = src("server/contactsRouter.ts");
    expect(r).toContain('requireAccess(ctx.user, "clientes", "edit");');
    expect(r).toContain(".min(1).max(CONTACT_IMPORT_MAX)");
    expect(src("shared/contactImport.ts")).toContain("export const CONTACT_IMPORT_MAX = 2000;");
  });
});

describe("Contactos: filtros e ordem por cima, em todos os tipos", () => {
  it("o cabeçalho \"Nome\" roda A–Z → Z–A → ordem normal", () => {
    expect(nextNameSort("recent")).toBe("name_asc");
    expect(nextNameSort("name_asc")).toBe("name_desc");
    expect(nextNameSort("name_desc")).toBe("recent");
  });
  it("os 8 tipos filtram (com email / com telefone) e ordenam no servidor", () => {
    const s = src("server/contactsSearch.ts");
    for (const fn of ["searchClients", "searchCrm", "searchLeads", "searchPartners", "searchSuppliers", "searchEmployees", "searchDirectory", "searchGoogle"]) {
      const body = s.slice(s.indexOf(`async function ${fn}(`), s.indexOf("return rows.map", s.indexOf(`async function ${fn}(`)));
      expect(body, fn).toContain("${hasCond(k, ");
      expect(body, fn).toContain("ORDER BY ${orderBy(k, ");
    }
    expect(s).toContain('sort: input.sort ?? "recent", has: input.has ?? null');
    expect(src("server/contactsRouter.ts")).toContain("sort: z.enum(CONTACT_SORTS).nullish(), has: z.enum(CONTACT_HAS).nullish(),");
  });
  it("a lista é uma tabela com cabeçalho; filtros e importar por cima", () => {
    const p = src("client/src/pages/ContactsPage.tsx");
    expect(p).toContain("<ContactTable items={items} onOpen={onOpen} sort={sort} onSort={onSort} />");
    expect(p).toContain("CONTACT_HAS.map((h) =>");
    expect(p).toContain("Importar contactos");
    expect(p).toContain("trpc.contacts.search.useQuery({ q, kind: \"all\", sort, has }");
  });
});
