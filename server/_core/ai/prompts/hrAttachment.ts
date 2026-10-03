/**
 * D39: anexos dos emails do RH (CV e documentos de candidatos a extra) —
 * saída estruturada. A IA não decide nada: o servidor valida cada campo
 * (NIF com dígito de controlo, cidade só se certa) e só preenche vazios.
 */
import { z } from "zod";

export const hrAttachmentSchema = z.object({
  docKind: z.enum(["cv", "id_card", "residence_permit", "driving_license", "other"]),
  fullName: z.string().nullable(),
  nif: z.string().nullable(),
  idDocNumber: z.string().nullable().describe("N.º do Bilhete de Identidade / Cartão de Cidadão (ou passaporte/título), tal como aparece"),
  drivingLicenseNumber: z.string().nullable().describe("N.º da carta de condução, tal como aparece"),
  city: z.string().nullable().describe("Cidade/localidade onde a pessoa vive"),
  cityCertain: z.boolean().describe("true só se o documento disser claramente onde a pessoa vive (morada ou 'reside em')"),
  phones: z.array(z.string()).describe("Telefones da pessoa que aparecem no documento"),
  emails: z.array(z.string()).describe("Emails da pessoa que aparecem no documento"),
  summary: z.string().nullable().describe("Só para CV: 3 a 6 linhas para quem vai entrevistar"),
});

export const HR_ATTACHMENT_SYSTEM =
  "És um assistente de recursos humanos português de uma empresa de parques de estacionamento com valet " +
  "(recrutamos condutores 'extra'). Lês o anexo de um email de candidatura e devolves os campos pedidos. " +
  "Usa null (ou lista vazia) quando um campo não aparece ou não é legível. Não inventes; copia os números tal como aparecem. " +
  "cityCertain só é true se a morada ou o texto disser claramente onde a pessoa vive. " +
  "No resumo (só CV), em português de Portugal, sem dados pessoais (nada de NIF, números de documentos, telefones ou emails): " +
  "experiência de condução e com clientes, carta (categorias e há quanto tempo), línguas, disponibilidade e outros pontos úteis para a entrevista.";

export const HR_ATTACHMENT_INSTRUCTION = "Lê este anexo de candidatura e extrai os campos.";
