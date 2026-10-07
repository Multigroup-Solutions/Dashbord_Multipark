/**
 * Lote 43b — o Zello de cada PDA bate certo? (Jorge, 7 out 2026: "tem que ter
 * o mesmo nome que tem no Zello, ou não?… o Zello tem que se ligar… mede e
 * põe o nome"). Compara o utilizador Zello gravado no PDA com a lista do
 * Zello. PURA.
 *   - ok: existe no Zello, escrito igual;
 *   - sem_zello: o PDA não tem Zello;
 *   - maiusculas: existe, mas escrito com outras maiúsculas (corrige-se);
 *   - parecido: não existe, mas há um com o mesmo nome sem pontuação ("extra12" ↔ "Extra_12");
 *   - nao_existe: não há ninguém assim no Zello;
 *   - duplicado: o mesmo Zello está em mais do que um PDA.
 */
import { matchKey } from "./textKey";
import { zelloKey } from "./zelloKey";

export type PdaZelloStatus = "ok" | "sem_zello" | "maiusculas" | "parecido" | "nao_existe" | "duplicado";
export interface PdaZelloCheck { pdaId: number; status: PdaZelloStatus; suggestion: string | null; detail: string }

export const PDA_ZELLO_LABELS: Record<PdaZelloStatus, string> = {
  ok: "Zello certo",
  sem_zello: "sem Zello",
  maiusculas: "Zello com outras maiúsculas",
  parecido: "Zello escrito de outra maneira",
  nao_existe: "Zello não existe",
  duplicado: "Zello repetido noutro PDA",
};

export function checkPdaZello(
  pdas: ReadonlyArray<{ id: number; name: string; zelloUsername: string | null }>,
  zelloUsers: ReadonlyArray<{ name: string }>,
): PdaZelloCheck[] {
  const exact = new Set(zelloUsers.map((u) => u.name));
  const byKey = new Map<string, string>();
  const byMatch = new Map<string, string>();
  for (const u of zelloUsers) {
    if (!byKey.has(zelloKey(u.name))) byKey.set(zelloKey(u.name), u.name);
    if (!byMatch.has(matchKey(u.name))) byMatch.set(matchKey(u.name), u.name);
  }
  const used = new Map<string, number>();
  for (const p of pdas) { const k = zelloKey(p.zelloUsername); if (k) used.set(k, (used.get(k) ?? 0) + 1); }
  return pdas.map((p) => {
    const z = String(p.zelloUsername ?? "").trim();
    if (!z) return { pdaId: p.id, status: "sem_zello", suggestion: byMatch.get(matchKey(p.name)) ?? null, detail: "Este PDA não tem utilizador do Zello." };
    if ((used.get(zelloKey(z)) ?? 0) > 1) return { pdaId: p.id, status: "duplicado", suggestion: null, detail: `O Zello ${z} está em mais do que um PDA.` };
    if (exact.has(z)) return { pdaId: p.id, status: "ok", suggestion: null, detail: `Zello ${z}` };
    const sameKey = byKey.get(zelloKey(z));
    if (sameKey) return { pdaId: p.id, status: "maiusculas", suggestion: sameKey, detail: `No Zello está escrito ${sameKey}.` };
    const similar = byMatch.get(matchKey(z));
    if (similar) return { pdaId: p.id, status: "parecido", suggestion: similar, detail: `No Zello não há ${z}; há ${similar}.` };
    return { pdaId: p.id, status: "nao_existe", suggestion: null, detail: `Não há nenhum ${z} no Zello.` };
  });
}
