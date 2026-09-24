/**
 * Certificado de formação/carreira em PDF (PDFKit — a mesma biblioteca dos
 * recibos de vencimento).
 */
import PDFDocument from "pdfkit";

export const CAREER_LEVEL_NAMES: Record<string, string> = {
  condutor_1: "Condutor N1", condutor_2: "Condutor N2", condutor_3: "Condutor N3", condutor_4: "Condutor N4",
  terminal_1: "Terminal N1", terminal_2: "Terminal N2", terminal_3: "Terminal N3", terminal_4: "Terminal N4",
  front_1: "Front N1", front_2: "Front N2", front_3: "Front N3", front_4: "Front N4",
  team_leader: "Team Leader", supervisor: "Supervisor",
};

function ptDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function renderCertificatePdf(data: {
  certificateId: number; fullName: string; examTitle: string; level: string; issuedAt: string; validUntil: string | null;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 50, info: { Title: `Certificado — ${data.fullName}`, Author: "Multipark" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, H = doc.page.height;
    doc.lineWidth(3).strokeColor("#1e3a8a").rect(25, 25, W - 50, H - 50).stroke();
    doc.lineWidth(1).strokeColor("#93c5fd").rect(35, 35, W - 70, H - 70).stroke();

    doc.fillColor("#1e3a8a").font("Helvetica-Bold").fontSize(14).text("MULTIPARK", 0, 70, { align: "center", characterSpacing: 4 });
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(34).text("Certificado", 0, 105, { align: "center" });
    doc.font("Helvetica").fontSize(13).fillColor("#374151").text("Certifica-se que", 0, 170, { align: "center" });
    doc.font("Helvetica-Bold").fontSize(28).fillColor("#111827").text(data.fullName, 60, 195, { align: "center", width: W - 120 });
    doc.font("Helvetica").fontSize(13).fillColor("#374151")
      .text(`concluiu com aproveitamento o exame "${data.examTitle}"`, 60, 250, { align: "center", width: W - 120 })
      .moveDown(0.4)
      .text(`e está certificado(a) no nível`, { align: "center", width: W - 120 });
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#1e3a8a").text(CAREER_LEVEL_NAMES[data.level] ?? data.level, 60, 305, { align: "center", width: W - 120 });

    doc.font("Helvetica").fontSize(12).fillColor("#374151");
    doc.text(`Data de emissão: ${ptDate(data.issuedAt)}`, 90, H - 150);
    doc.text(data.validUntil ? `Válido até: ${ptDate(data.validUntil)}` : "Validade: sem prazo", 90, H - 130);
    doc.text(`Certificado n.º ${String(data.certificateId).padStart(6, "0")}`, W - 330, H - 150, { width: 240, align: "right" });
    doc.moveTo(W - 330, H - 105).lineTo(W - 90, H - 105).strokeColor("#9ca3af").stroke();
    doc.fontSize(10).fillColor("#6b7280").text("A Direção", W - 330, H - 98, { width: 240, align: "center" });
    doc.end();
  });
}
