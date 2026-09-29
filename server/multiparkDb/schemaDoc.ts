/**
 * Descoberta do esquema da BD Multipark — SÓ ESTRUTURA: tabelas, colunas
 * (tipo, nulo, omissão), chaves primárias/estrangeiras, índices, enums e
 * contagens APROXIMADAS de linhas (estatísticas do motor, sem COUNT(*)).
 * Nunca lê linhas de dados (nem amostras), por isso o resultado pode ir para
 * o repositório (docs/multipark-db/schema.md).
 *
 * Usado por scripts/multipark-db-schema.ts. `renderSchemaMarkdown` é PURA.
 */
import type { MultiparkDbClient, MultiparkDbEngine } from "./client";

export interface SchemaColumn { name: string; type: string; nullable: boolean; defaultValue: string | null; comment: string | null }
export interface SchemaForeignKey { name: string; columns: string[]; refTable: string; refColumns: string[] }
export interface SchemaIndex { name: string; columns: string[]; unique: boolean; primary: boolean }
export interface SchemaTable {
  schema: string;
  name: string;
  approxRows: number | null;
  columns: SchemaColumn[];
  primaryKey: string[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
}
export interface SchemaEnum { schema: string; name: string; values: string[] }
export interface SchemaSnapshot {
  engine: MultiparkDbEngine;
  version: string | null;
  generatedAt: string;
  tables: SchemaTable[];
  enums: SchemaEnum[];
}

const str = (v: unknown) => (v == null ? "" : String(v));
const nullable = (v: unknown) => /^(yes|true|1)$/i.test(str(v));

function table(map: Map<string, SchemaTable>, schema: string, name: string): SchemaTable {
  const key = `${schema}.${name}`;
  let t = map.get(key);
  if (!t) {
    t = { schema, name, approxRows: null, columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
    map.set(key, t);
  }
  return t;
}

/** Lê a estrutura (só catálogos do motor). `schemas` filtra no Postgres. */
export async function loadSchemaSnapshot(db: MultiparkDbClient, opts: { schemas?: string[] } = {}): Promise<SchemaSnapshot> {
  const map = new Map<string, SchemaTable>();
  const enums: SchemaEnum[] = [];
  let version: string | null = null;

  if (db.engine === "postgres") {
    version = str((await db.query("SELECT current_setting('server_version') AS v"))[0]?.v) || null;
    const schemaFilter = opts.schemas?.length
      ? `n.nspname IN (${opts.schemas.map((_, i) => `$${i + 1}`).join(", ")})`
      : "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'";
    const params = opts.schemas ?? [];
    for (const r of await db.query(`SELECT n.nspname AS s, c.relname AS t, c.reltuples AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND ${schemaFilter} ORDER BY 1, 2`, params)) {
      const rows = Number(r.rows);
      table(map, str(r.s), str(r.t)).approxRows = Number.isFinite(rows) && rows >= 0 ? Math.round(rows) : null;
    }
    for (const r of await db.query(`SELECT n.nspname AS s, c.relname AS t, a.attname AS col,
          format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
          pg_get_expr(d.adbin, d.adrelid) AS def, col_description(c.oid, a.attnum) AS note
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND ${schemaFilter}
        ORDER BY 1, 2, a.attnum`, params)) {
      table(map, str(r.s), str(r.t)).columns.push({ name: str(r.col), type: str(r.type), nullable: r.nullable === true || r.nullable === "t", defaultValue: r.def == null ? null : str(r.def), comment: r.note == null ? null : str(r.note) });
    }
    for (const r of await db.query(`SELECT n.nspname AS s, c.relname AS t, con.conname AS name, con.contype AS kind,
          ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord)::text[] AS cols,
          fn.nspname AS rs, fc.relname AS rt,
          ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord)::text[] AS rcols
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_class fc ON fc.oid = con.confrelid
        LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE con.contype IN ('p', 'f') AND ${schemaFilter}
        ORDER BY 1, 2, 3`, params)) {
      const t = table(map, str(r.s), str(r.t));
      const cols = pgArray(r.cols);
      if (r.kind === "p") t.primaryKey = cols;
      else t.foreignKeys.push({ name: str(r.name), columns: cols, refTable: r.rs && r.rs !== r.s ? `${str(r.rs)}.${str(r.rt)}` : str(r.rt), refColumns: pgArray(r.rcols) });
    }
    for (const r of await db.query(`SELECT n.nspname AS s, c.relname AS t, i.relname AS name, x.indisunique AS uniq, x.indisprimary AS prim,
          ARRAY(SELECT pg_get_indexdef(x.indexrelid, k + 1, true) FROM generate_series(0, x.indnkeyatts - 1) AS k ORDER BY k)::text[] AS cols
        FROM pg_index x
        JOIN pg_class c ON c.oid = x.indrelid
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND ${schemaFilter}
        ORDER BY 1, 2, 3`, params)) {
      table(map, str(r.s), str(r.t)).indexes.push({ name: str(r.name), columns: pgArray(r.cols), unique: r.uniq === true || r.uniq === "t", primary: r.prim === true || r.prim === "t" });
    }
    const enumMap = new Map<string, SchemaEnum>();
    for (const r of await db.query(`SELECT n.nspname AS s, t.typname AS name, e.enumlabel AS label
        FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE ${schemaFilter} ORDER BY 1, 2, e.enumsortorder`, params)) {
      const key = `${str(r.s)}.${str(r.name)}`;
      if (!enumMap.has(key)) enumMap.set(key, { schema: str(r.s), name: str(r.name), values: [] });
      enumMap.get(key)!.values.push(str(r.label));
    }
    enums.push(...enumMap.values());
  } else {
    version = str((await db.query("SELECT VERSION() AS v"))[0]?.v) || null;
    for (const r of await db.query(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_ROWS AS n_rows
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY 2`)) {
      const rows = Number(r.n_rows);
      table(map, str(r.s), str(r.t)).approxRows = Number.isFinite(rows) ? rows : null;
    }
    for (const r of await db.query(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS col, COLUMN_TYPE AS type,
          IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, COLUMN_COMMENT AS note
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`)) {
      if (!map.has(`${str(r.s)}.${str(r.t)}`)) continue; // vistas
      const type = str(r.type);
      table(map, str(r.s), str(r.t)).columns.push({ name: str(r.col), type, nullable: nullable(r.nullable), defaultValue: r.def == null ? null : str(r.def), comment: str(r.note) || null });
      const m = /^enum\((.*)\)$/i.exec(type);
      if (m) enums.push({ schema: str(r.s), name: `${str(r.t)}.${str(r.col)}`, values: Array.from(m[1].matchAll(/'((?:[^']|'')*)'/g)).map((x) => x[1].replace(/''/g, "'")) });
    }
    const fks = new Map<string, SchemaForeignKey & { s: string; t: string }>();
    for (const r of await db.query(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, CONSTRAINT_NAME AS name, COLUMN_NAME AS col,
          REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc
        FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`)) {
      const key = `${str(r.t)}.${str(r.name)}`;
      if (!fks.has(key)) fks.set(key, { s: str(r.s), t: str(r.t), name: str(r.name), columns: [], refTable: str(r.rt), refColumns: [] });
      fks.get(key)!.columns.push(str(r.col));
      fks.get(key)!.refColumns.push(str(r.rc));
    }
    for (const fk of fks.values()) {
      const { s, t, ...rest } = fk;
      if (map.has(`${s}.${t}`)) table(map, s, t).foreignKeys.push(rest);
    }
    const idx = new Map<string, SchemaIndex & { s: string; t: string }>();
    for (const r of await db.query(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)) {
      const key = `${str(r.t)}.${str(r.name)}`;
      if (!idx.has(key)) idx.set(key, { s: str(r.s), t: str(r.t), name: str(r.name), columns: [], unique: Number(r.non_unique) === 0, primary: str(r.name) === "PRIMARY" });
      idx.get(key)!.columns.push(str(r.col) || "(expressão)");
    }
    for (const ix of idx.values()) {
      const { s, t, ...rest } = ix;
      if (!map.has(`${s}.${t}`)) continue;
      const tb = table(map, s, t);
      tb.indexes.push(rest);
      if (rest.primary) tb.primaryKey = rest.columns;
    }
  }

  const tables = Array.from(map.values()).sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  return { engine: db.engine, version, generatedAt: new Date().toISOString(), tables, enums };
}

function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str);
  const s = str(v);
  if (!s || s === "{}") return [];
  return s.replace(/^\{|\}$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const fmtRows = (n: number | null) => (n == null ? "?" : n.toLocaleString("pt-PT"));

/** Markdown do esquema (só estrutura + contagens aproximadas). PURA. */
export function renderSchemaMarkdown(s: SchemaSnapshot): string {
  const multiSchema = new Set(s.tables.map((t) => t.schema)).size > 1;
  const tname = (t: { schema: string; name: string }) => (multiSchema ? `${t.schema}.${t.name}` : t.name);
  const lines: string[] = [];
  lines.push("# Esquema da BD Multipark (só estrutura)");
  lines.push("");
  lines.push(`Gerado por \`scripts/multipark-db-schema.ts\` em ${s.generatedAt} · ${s.engine === "postgres" ? "PostgreSQL" : "MySQL"}${s.version ? ` ${md(s.version)}` : ""} · ${s.tables.length} tabela(s).`);
  lines.push("");
  lines.push("Sem dados: só tabelas, colunas, chaves, índices, enums e contagens APROXIMADAS (estatísticas do motor). Voltar a gerar depois de migrações da Multipark.");
  lines.push("");
  lines.push("## Tabelas");
  lines.push("");
  lines.push("| Tabela | Linhas (aprox.) | Colunas | PK |");
  lines.push("|---|---:|---:|---|");
  for (const t of s.tables) lines.push(`| [${md(tname(t))}](#${anchor(tname(t))}) | ${fmtRows(t.approxRows)} | ${t.columns.length} | ${md(t.primaryKey.join(", ") || "—")} |`);
  lines.push("");
  if (s.enums.length) {
    lines.push("## Enums");
    lines.push("");
    for (const e of s.enums) lines.push(`- **${md(multiSchema ? `${e.schema}.${e.name}` : e.name)}**: ${e.values.map((v) => `\`${md(v)}\``).join(", ")}`);
    lines.push("");
  }
  for (const t of s.tables) {
    lines.push(`## ${md(tname(t))}`);
    lines.push("");
    lines.push(`Linhas (aprox.): ${fmtRows(t.approxRows)} · PK: ${md(t.primaryKey.join(", ") || "—")}`);
    lines.push("");
    lines.push("| Coluna | Tipo | Nulo | Omissão | Nota |");
    lines.push("|---|---|:---:|---|---|");
    for (const c of t.columns) lines.push(`| ${md(c.name)} | \`${md(c.type)}\` | ${c.nullable ? "sim" : "não"} | ${c.defaultValue == null ? "" : `\`${md(c.defaultValue).slice(0, 80)}\``} | ${md(c.comment ?? "").slice(0, 120)} |`);
    lines.push("");
    if (t.foreignKeys.length) {
      lines.push("Chaves estrangeiras:");
      for (const f of t.foreignKeys) lines.push(`- ${md(f.columns.join(", "))} → ${md(f.refTable)}(${md(f.refColumns.join(", "))})`);
      lines.push("");
    }
    const idx = t.indexes.filter((i) => !i.primary);
    if (idx.length) {
      lines.push("Índices:");
      for (const i of idx) lines.push(`- ${i.unique ? "único " : ""}\`${md(i.name)}\` (${md(i.columns.join(", "))})`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function anchor(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/ /g, "-");
}
