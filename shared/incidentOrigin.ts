/**
 * Origem de uma ocorrência na página /ocorrencias.
 *
 *  - "multipark": lida ao vivo da BD da Multipark ("Occurrence") — só leitura;
 *  - "email": criada pelo leitor de emails (jobs/emailInboundSync.ts);
 *  - "api": importada pela API externa (/gmail-import em externalApi.ts);
 *  - "manual": criada no dashboard;
 *  - "multipark_legacy": criada pelo antigo parser das notas do histórico
 *    (sourceEmailId "mp:<historyId>"). Ficam na BD, mas escondem-se quando as
 *    ocorrências da Multipark estão disponíveis (seriam duplicados).
 * PURA — usada no cliente e no servidor.
 */
export type IncidentOrigin = "multipark" | "email" | "api" | "manual" | "multipark_legacy";

export const LEGACY_MULTIPARK_SOURCE_PREFIX = "mp:";

export function isLegacyMultiparkIncident(inc: { sourceEmailId?: string | null }): boolean {
  return String(inc.sourceEmailId ?? "").startsWith(LEGACY_MULTIPARK_SOURCE_PREFIX);
}

export function incidentOrigin(inc: { sourceEmailId?: string | null; importedAt?: string | null }): Exclude<IncidentOrigin, "multipark"> {
  if (isLegacyMultiparkIncident(inc)) return "multipark_legacy";
  // A API (/gmail-import) marca sempre importedAt; o leitor de emails não.
  if (inc.importedAt) return "api";
  if (inc.sourceEmailId) return "email";
  return "manual";
}

export const INCIDENT_ORIGIN_LABEL: Record<IncidentOrigin, string> = {
  multipark: "Multipark",
  email: "Email",
  api: "API",
  manual: "Manual",
  multipark_legacy: "Multipark (antigo)",
};
