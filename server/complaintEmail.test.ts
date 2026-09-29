import { describe, expect, it } from "vitest";
import {
  clientSignalEmail,
  clientSignalName,
  complaintSlaDeadline,
  htmlToPlainText,
  isAutoAckRecipient,
  isComplaintAutoAckEnabled,
  isGenericSenderName,
  isInternalEmail,
  isLivroReclamacoes,
  normalizePlate,
  parseComplaintCaseTag,
  replySubject,
  tagComplaintSubject,
} from "./complaintEmail";
import { parseInboundBody } from "./emailParse";
import { MIGRATION_0085_STATEMENTS } from "./migrations/migration_0085";

describe("migração 0085", () => {
  it("'processing' fica no FIM do enum (alteração instantânea do InnoDB)", () => {
    const modify = MIGRATION_0085_STATEMENTS.find((s) => s.includes("MODIFY COLUMN `status`"))!;
    expect(modify).toMatch(/ENUM\('processed','skipped','error','processing'\)/);
  });
});

describe("remetentes internos", () => {
  it("deteta os domínios da casa (e subdomínios)", () => {
    expect(isInternalEmail("reservas@multipark.pt")).toBe(true);
    expect(isInternalEmail("Info@SkyPark.pt")).toBe(true);
    expect(isInternalEmail("x@airpark.pt")).toBe(true);
    expect(isInternalEmail("x@redpark.pt")).toBe(true);
    expect(isInternalEmail("x@mail.multigroup.pt")).toBe(true);
    expect(isInternalEmail("joao@gmail.com")).toBe(false);
    expect(isInternalEmail("joao@notmultipark.pt")).toBe(false);
    expect(isInternalEmail(undefined)).toBe(false);
  });

  it("nomes genéricos/da marca não identificam o cliente", () => {
    expect(isGenericSenderName("Multipark")).toBe(true);
    expect(isGenericSenderName("Sky Park")).toBe(true);
    expect(isGenericSenderName("Multipark Reclamações")).toBe(true);
    expect(isGenericSenderName("Reclamações")).toBe(true);
    expect(isGenericSenderName("reservas@multipark.pt")).toBe(true);
    expect(isGenericSenderName("")).toBe(true);
    expect(isGenericSenderName("João Silva")).toBe(false);
  });

  it("sinais do cliente ignoram endereços internos e nomes genéricos", () => {
    expect(clientSignalEmail("reclamacoes@multipark.pt")).toBeUndefined();
    expect(clientSignalEmail("não é email")).toBeUndefined();
    expect(clientSignalEmail("ana@gmail.com")).toBe("ana@gmail.com");
    expect(clientSignalName("Multipark")).toBeUndefined();
    expect(clientSignalName("Ana")).toBeUndefined();
    expect(clientSignalName("Ana Costa")).toBe("Ana Costa");
  });
});

describe("matrícula normalizada", () => {
  it("remove espaços/hífens e passa a maiúsculas", () => {
    expect(normalizePlate("aa-11-bb")).toBe("AA11BB");
    expect(normalizePlate(" 12 AB 34 ")).toBe("12AB34");
    expect(normalizePlate(null)).toBe("");
  });
});

describe("etiqueta [REC-id] no assunto", () => {
  it("lê o id da etiqueta", () => {
    expect(parseComplaintCaseTag("Re: Carro riscado [REC-123]")).toBe(123);
    expect(parseComplaintCaseTag("RE: [rec-7] algo")).toBe(7);
    expect(parseComplaintCaseTag("Reclamação 123")).toBeNull();
    expect(parseComplaintCaseTag(undefined)).toBeNull();
  });

  it("acrescenta a etiqueta só uma vez", () => {
    expect(tagComplaintSubject("Carro riscado", 5)).toBe("Carro riscado [REC-5]");
    expect(tagComplaintSubject("Carro riscado [REC-5]", 5)).toBe("Carro riscado [REC-5]");
    expect(tagComplaintSubject(tagComplaintSubject("X", 9), 9)).toBe("X [REC-9]");
    expect(tagComplaintSubject("", 3)).toBe("[REC-3]");
  });

  it("assunto de resposta não acumula Re:", () => {
    expect(replySubject("Carro")).toBe("Re: Carro");
    expect(replySubject("RE: Carro")).toBe("RE: Carro");
  });
});

describe("HTML → texto", () => {
  const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head>
    <body><h1>Reclamação</h1><p>Nome: <b>João&nbsp;Silva</b><br>Email: <a href="mailto:joao@gmail.com">joao@gmail.com</a></p>
    <div>Matrícula: AA-11-BB</div><p>Ol&aacute; &amp; adeus</p><img src="x.png"></body></html>`;

  it("mantém linhas, descodifica entidades e ignora style/script", () => {
    const t = htmlToPlainText(html);
    expect(t).not.toMatch(/color:red|alert/);
    expect(t).toContain("Olá & adeus");
    expect(t).toMatch(/^Nome: João Silva$/m);
    expect(t).toMatch(/^Email: joao@gmail\.com$/m);
    expect(t).toMatch(/^Matrícula: AA-11-BB$/m);
    expect(t).not.toContain("<");
  });

  it("o parsing Etiqueta: valor continua a funcionar", () => {
    const p = parseInboundBody(htmlToPlainText(html));
    expect(p.clientName).toBe("João Silva");
    expect(p.clientEmail).toBe("joao@gmail.com");
    expect(p.vehiclePlate).toBe("AA-11-BB");
  });

  it("vazio → string vazia", () => {
    expect(htmlToPlainText(null)).toBe("");
  });
});

describe("Livro de Reclamações / SLA / auto-ack", () => {
  it("deteta o Livro de Reclamações", () => {
    expect(isLivroReclamacoes("Nova reclamação ROR123456789", "")).toBe(true);
    expect(isLivroReclamacoes("x", "via Livro de Reclamações eletrónico")).toBe(true);
    expect(isLivroReclamacoes("Carro riscado", "")).toBe(false);
  });

  it("SLA = agora + horas", () => {
    expect(complaintSlaDeadline(48, Date.UTC(2026, 0, 1, 10, 0, 0))).toBe("2026-01-03 10:00:00");
  });

  it("aviso de receção só para emails externos e não automáticos", () => {
    expect(isAutoAckRecipient("ana@gmail.com")).toBe(true);
    expect(isAutoAckRecipient("reclamacoes@multipark.pt")).toBe(false);
    expect(isAutoAckRecipient("noreply@livroreclamacoes.pt")).toBe(false);
    expect(isAutoAckRecipient("no-reply@x.com")).toBe(false);
    expect(isAutoAckRecipient("mailer-daemon@googlemail.com")).toBe(false);
    expect(isAutoAckRecipient(undefined)).toBe(false);
  });

  it("COMPLAINT_AUTO_ACK=off desliga", () => {
    expect(isComplaintAutoAckEnabled({})).toBe(true);
    expect(isComplaintAutoAckEnabled({ COMPLAINT_AUTO_ACK: "off" })).toBe(false);
    expect(isComplaintAutoAckEnabled({ COMPLAINT_AUTO_ACK: "OFF" })).toBe(false);
    expect(isComplaintAutoAckEnabled({ COMPLAINT_AUTO_ACK: "on" })).toBe(true);
  });
});
