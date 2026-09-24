// Regenera docs/permissoes.md a partir da matriz de shared/access.ts.
// Uso: pnpm tsx scripts/gen-permissoes-doc.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderPermissoesDoc } from "../shared/accessDoc";

const target = resolve(import.meta.dirname, "..", "docs", "permissoes.md");
writeFileSync(target, renderPermissoesDoc());
console.log(`Escrito ${target}`);
