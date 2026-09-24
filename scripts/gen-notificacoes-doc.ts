// Regenera docs/notificacoes.md a partir de shared/notificationRouting.ts.
// Uso: pnpm tsx scripts/gen-notificacoes-doc.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderNotificacoesDoc } from "../shared/notificationRoutingDoc";

const target = resolve(import.meta.dirname, "..", "docs", "notificacoes.md");
writeFileSync(target, renderNotificacoesDoc());
console.log(`Escrito ${target}`);
