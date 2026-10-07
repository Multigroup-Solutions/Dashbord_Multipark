/**
 * Lote 40a — Xsi da One Net (Jorge, 7 out 2026: "O XSI está ativo. Como é que
 * tenho que configurar agora?"). Regras puras: endereço do servidor e leitura
 * das respostas XML do BroadWorks.
 */
import { describe, expect, it } from "vitest";
import {
  decodeXml, last9, normalizeXsiBase, normalizeXsiUserId, parseXsiCallLogs, parseXsiDirectory, parseXsiProfile, xmlBlocks, xmlText,
} from "../shared/centralXsi";

describe("40a — endereço e utilizador do Xsi", () => {
  it("aceita o anfitrião ou o URL completo e fica com a origem https", () => {
    expect(normalizeXsiBase("xsi.onenet.example.pt")).toBe("https://xsi.onenet.example.pt");
    expect(normalizeXsiBase("https://xsi.onenet.example.pt/com.broadsoft.xsi-actions/v2.0/user/x/profile")).toBe("https://xsi.onenet.example.pt");
    expect(normalizeXsiBase("https://portal.example.pt:8443/xsi/com.broadsoft.xsi-actions/v2.0")).toBe("https://portal.example.pt:8443/xsi");
    expect(normalizeXsiBase("https://xsi.example.pt/")).toBe("https://xsi.example.pt");
  });
  it("recusa http, credenciais no URL, localhost e IPs internos", () => {
    for (const bad of ["http://xsi.example.pt", "https://a:b@xsi.example.pt", "https://localhost", "https://10.0.0.5", "https://192.168.1.10", "https://127.0.0.1", "https://172.20.0.1", "https://169.254.169.254", "https://servidor", "", "ftp://x.y"]) {
      expect(normalizeXsiBase(bad)).toBeNull();
    }
    expect(normalizeXsiBase("https://81.20.30.40")).toBe("https://81.20.30.40"); // IP público serve
  });
  it("utilizador do BroadWorks", () => {
    expect(normalizeXsiUserId(" 351210000000@onenet.example.pt ")).toBe("351210000000@onenet.example.pt");
    expect(normalizeXsiUserId("+351210000000")).toBe("+351210000000");
    expect(normalizeXsiUserId("a b")).toBeNull();
    expect(normalizeXsiUserId("x")).toBeNull();
  });
});

describe("40a — XML do BroadWorks", () => {
  it("blocos e texto, com ou sem prefixo, e entidades", () => {
    const x = `<a xmlns="http://schema.broadsoft.com/xsi"><b>1</b><x:b>2</x:b><c/><d>R&amp;D &#233;</d></a>`;
    expect(xmlBlocks(x, "b")).toEqual(["1", "2"]);
    expect(xmlText(x, "c")).toBeNull();
    expect(xmlText(x, "d")).toBe("R&D é");
    expect(decodeXml("&lt;&gt;&quot;&apos;&#x41;")).toBe(`<>"'A`);
  });

  it("perfil", () => {
    const x = `<?xml version="1.0" encoding="UTF-8"?><Profile xmlns="http://schema.broadsoft.com/xsi"><details><userId>351210000000@onenet.pt</userId><firstName>Jorge</firstName><lastName>Tabuada</lastName><groupId>MULTIPARK</groupId><number>210000000</number><extension>410</extension></details></Profile>`;
    expect(parseXsiProfile(x)).toEqual({ userId: "351210000000@onenet.pt", firstName: "Jorge", lastName: "Tabuada", number: "210000000", extension: "410", groupId: "MULTIPARK" });
  });

  it("diretório da empresa", () => {
    const x = `<Enterprise xmlns="http://schema.broadsoft.com/xsi"><startIndex>1</startIndex><numberOfRecords>2</numberOfRecords><totalAvailableRecords>2</totalAvailableRecords><enterpriseDirectory>
      <directoryDetails><userId>a@onenet.pt</userId><firstName>Ana</firstName><lastName>Silva</lastName><groupId>G1</groupId><number>+351210000001</number><extension>411</extension><mobile>+351912345678</mobile><emailAddress>ana@x.pt</emailAddress></directoryDetails>
      <directoryDetails><userId>b@onenet.pt</userId><firstName>Rui</firstName><lastName/><extension>412</extension></directoryDetails>
    </enterpriseDirectory></Enterprise>`;
    const d = parseXsiDirectory(x);
    expect(d.total).toBe(2);
    expect(d.entries).toEqual([
      { userId: "a@onenet.pt", name: "Ana Silva", number: "+351210000001", extension: "411", mobile: "+351912345678", email: "ana@x.pt", groupId: "G1" },
      { userId: "b@onenet.pt", name: "Rui", number: null, extension: "412", mobile: null, email: null, groupId: null },
    ]);
  });

  it("registos de chamadas: feitas, recebidas e não atendidas", () => {
    const x = `<CallLogs xmlns="http://schema.broadsoft.com/xsi">
      <placed><callLogsEntry><countryCode>351</countryCode><phoneNumber>912345678</phoneNumber><name>Cliente</name><time>2026-10-07T10:00:00.000+01:00</time><callLogId>1:0</callLogId></callLogsEntry></placed>
      <received><callLogsEntry><countryCode>351</countryCode><phoneNumber>410</phoneNumber><time>2026-10-07T10:05:00.000+01:00</time><callLogId>2:0</callLogId></callLogsEntry></received>
      <missed><callLogsEntry><phoneNumber>+351934000000</phoneNumber><time>2026-10-07T10:10:00.000+01:00</time><callLogId>3:0</callLogId></callLogsEntry></missed>
    </CallLogs>`;
    expect(parseXsiCallLogs(x)).toEqual([
      { type: "placed", callLogId: "1:0", phone: "+351912345678", name: "Cliente", time: "2026-10-07T10:00:00.000+01:00" },
      { type: "received", callLogId: "2:0", phone: "410", name: null, time: "2026-10-07T10:05:00.000+01:00" },
      { type: "missed", callLogId: "3:0", phone: "+351934000000", name: null, time: "2026-10-07T10:10:00.000+01:00" },
    ]);
  });

  it("últimos 9 dígitos para cruzar com as fichas", () => {
    expect(last9("+351 912 345 678")).toBe("912345678");
    expect(last9("410")).toBeNull();
  });
});
