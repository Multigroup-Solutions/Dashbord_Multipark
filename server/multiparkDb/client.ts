/**
 * Ligação SÓ DE LEITURA à base de dados da aplicação Multipark
 * (be-multipark), a partir da variável DATABASE_URL_MULTIPARK.
 *
 * Porquê: a BD da Multipark tem tudo sempre atualizado (reservas, todos os
 * movimentos — check-in/check-out com quem fez — condutores…), ao contrário
 * da API (/bookings/report, /bookings/:id), que obriga a sondagens de hora a
 * hora, fila de webhooks e reconciliação. Ver docs/multipark-db/README.md.
 *
 * Garantias de "só leitura" (defesa em profundidade — a garantia principal
 * deve ser um UTILIZADOR SÓ DE LEITURA criado por quem administra a BD):
 *   1. guarda de SQL (`assertReadOnlySql`): só SELECT / WITH / SHOW / EXPLAIN,
 *      uma instrução por pedido, sem palavras de escrita/bloqueio;
 *   2. sessão só de leitura: Postgres `SET SESSION CHARACTERISTICS AS
 *      TRANSACTION READ ONLY`; MySQL `SET SESSION TRANSACTION READ ONLY`
 *      (na 1.ª utilização de cada ligação, antes de qualquer consulta);
 *   3. cada consulta corre dentro de uma transação só de leitura
 *      (`BEGIN READ ONLY` / `START TRANSACTION READ ONLY`) que acaba SEMPRE
 *      em ROLLBACK.
 *
 * Serverless (Vercel): pool minúscula (2 ligações), abertura preguiçosa (só
 * na 1.ª consulta), tempos curtos de ligação e de instrução. O URL e as
 * credenciais NUNCA vão para logs nem mensagens de erro (`redactSecrets`).
 *
 * Este módulo é independente de server/db.ts (não dispara o
 * ensureRecentSchema) para poder ser usado pelo script
 * scripts/multipark-db-schema.ts.
 */

export type MultiparkDbEngine = "postgres" | "mysql";

export const MULTIPARK_DB_ENV = "DATABASE_URL_MULTIPARK";
/** Ligações por instância (serverless: cada função tem a sua pool). */
export const MULTIPARK_DB_POOL_MAX = 2;
export const MULTIPARK_DB_CONNECT_TIMEOUT_MS = 5_000;
export const MULTIPARK_DB_STATEMENT_TIMEOUT_MS = 15_000;
export const MULTIPARK_DB_IDLE_TIMEOUT_MS = 10_000;

// ─── Regras puras (testadas em server/multiparkDb/multiparkDb.test.ts) ──────

/** Motor a partir do esquema do URL. PURA. Lança se não for suportado. */
export function detectEngine(url: string | null | undefined): MultiparkDbEngine {
  const m = /^\s*([a-z][a-z0-9+.-]*):\/\//i.exec(String(url ?? ""));
  const scheme = (m?.[1] ?? "").toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") return "postgres";
  if (scheme === "mysql" || scheme === "mysql2" || scheme === "mariadb") return "mysql";
  throw new MultiparkDbError(
    scheme
      ? `${MULTIPARK_DB_ENV}: esquema "${scheme}://" não suportado (usar postgres://, postgresql:// ou mysql://).`
      : `${MULTIPARK_DB_ENV} não é um URL de ligação válido.`,
    "BAD_URL",
  );
}

/**
 * Tira URLs de ligação, credenciais e o utilizador/palavra-passe/anfitrião do
 * URL configurado de um texto (mensagens de erro do pg/mysql2 trazem às
 * vezes o utilizador ou o anfitrião). PURA.
 */
export function redactSecrets(text: unknown, url: string | null | undefined = currentUrl()): string {
  let out = String((text as any)?.message ?? text ?? "");
  const parts = safeUrlParts(url);
  if (url) out = out.split(url).join("<DATABASE_URL_MULTIPARK>");
  for (const secret of [parts?.password, parts?.passwordDecoded, parts?.username, parts?.usernameDecoded, parts?.host]) {
    if (secret && secret.length >= 3) out = out.split(secret).join("***");
  }
  // Qualquer URL de ligação com credenciais que ainda lá esteja.
  out = out.replace(/\b(postgres(?:ql)?|mysql2?|mariadb):\/\/[^\s'"]+/gi, "<url-bd>");
  out = out.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//***:***@");
  return out;
}

function currentUrl(): string | undefined {
  return typeof process !== "undefined" ? process.env[MULTIPARK_DB_ENV]?.trim() || undefined : undefined;
}

function safeUrlParts(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
    return { username: u.username, usernameDecoded: dec(u.username), password: u.password, passwordDecoded: dec(u.password), host: u.hostname };
  } catch {
    return null;
  }
}

/**
 * Troca comentários (de linha "--" e de bloco) por espaços e o conteúdo de textos entre
 * plicas / identificadores entre aspas ou acentos por nada, da esquerda para
 * a direita (um "--" dentro de um texto não esconde o que vem a seguir). PURA.
 * Sem escapes com barra invertida: quem a usar é recusado antes (ver guarda).
 */
function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      // Fecho = a mesma aspa não duplicada ('' dentro de '…' é uma plica).
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += c + c;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const READ_START = /^(select|with|show|explain)\b/i;
/** Palavras que nunca aparecem numa leitura (escrita, DDL, permissões, bloqueios, efeitos). */
const FORBIDDEN = /\b(insert|update|delete|merge|truncate|drop|alter|create|rename|grant|revoke|comment|vacuum|analyze|reindex|cluster|refresh|copy|load|lock|unlock|call|do|execute|prepare|deallocate|set|reset|begin|commit|rollback|savepoint|release|start|handler|import|listen|notify|outfile|dumpfile|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|lo_import|lo_export|dblink|get_lock)\b/i;
const LOCKING_READ = /\bfor\s+(no\s+key\s+)?(update|share|key\s+share)\b|\block\s+in\s+share\s+mode\b/i;

/**
 * Guarda de SQL (defesa em profundidade). PURA. Lança MultiparkDbError
 * `NOT_READ_ONLY` para tudo o que não seja UMA leitura simples.
 * Nota: `set`/`analyze`/… são recusados mesmo em nomes de colunas sem aspas —
 * nas consultas usar aspas ("…" no Postgres, `…` no MySQL) nesses casos.
 */
export function assertReadOnlySql(sql: string): void {
  const text = String(sql ?? "");
  if (!text.trim()) throw new MultiparkDbError("Consulta vazia.", "NOT_READ_ONLY");
  // Barras invertidas e dollar-quoting mudam as regras dos textos entre motores
  // (e /*! … */ é código no MySQL): as nossas leituras não precisam deles.
  if (/\\/.test(text) || /\$[A-Za-z_]*\$/.test(text) || /\/\*[!+]/.test(text)) {
    throw new MultiparkDbError("Consulta com barra invertida, $$ ou /*! não é permitida.", "NOT_READ_ONLY");
  }
  // No MySQL "--" só é comentário seguido de espaço ("1--1" é aritmética):
  // exigir o espaço para a guarda e o motor lerem o mesmo.
  if (/--(?!\s)/.test(text)) throw new MultiparkDbError("Comentários \"--\" têm de ter um espaço a seguir.", "NOT_READ_ONLY");
  const clean = stripSqlNoise(text).trim();
  // Uma só instrução: aceita um ";" final, nada depois.
  const body = clean.replace(/;\s*$/, "");
  if (body.includes(";")) throw new MultiparkDbError("Só é permitida uma instrução por consulta.", "NOT_READ_ONLY");
  if (!READ_START.test(body)) throw new MultiparkDbError("Só são permitidas leituras (SELECT, WITH, SHOW, EXPLAIN).", "NOT_READ_ONLY");
  if (/^explain\s+(\(\s*)?analy[sz]e\b/i.test(body)) throw new MultiparkDbError("EXPLAIN ANALYZE executa a consulta — não permitido.", "NOT_READ_ONLY");
  const hit = FORBIDDEN.exec(body.replace(READ_START, ""));
  if (hit) throw new MultiparkDbError(`Palavra não permitida numa leitura: ${hit[1].toUpperCase()}.`, "NOT_READ_ONLY");
  if (LOCKING_READ.test(body)) throw new MultiparkDbError("Leituras com bloqueio (FOR UPDATE/SHARE) não são permitidas.", "NOT_READ_ONLY");
  if (/\binto\b/i.test(body)) throw new MultiparkDbError("SELECT … INTO não é permitido.", "NOT_READ_ONLY");
}

export type SslChoice = false | { rejectUnauthorized: boolean };

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|::1|\[::1\])$|\.internal$|\.local$/i;

/**
 * SSL a partir do URL (sslmode / ssl-mode / ssl), com `override` opcional
 * (env MULTIPARK_DB_SSL = off | require | verify). PURA.
 *  - disable/off/false → sem SSL;
 *  - require/prefer/allow/no-verify/true → SSL sem verificar o certificado
 *    (igual ao `require` do libpq: cifra, mas aceita certificado próprio);
 *  - verify-ca/verify-full/verify_identity/verify → SSL com verificação;
 *  - sem indicação: sem SSL em anfitriões locais/privados; SSL sem
 *    verificação nos restantes.
 * Devolve também o URL sem estes parâmetros (os drivers interpretam-nos de
 * maneira diferente entre versões).
 */
export function sslFromUrl(url: string, override?: string | null): { ssl: SslChoice; url: string } {
  let u: URL;
  try { u = new URL(url); } catch { throw new MultiparkDbError(`${MULTIPARK_DB_ENV} não é um URL de ligação válido.`, "BAD_URL"); }
  const keys = ["sslmode", "ssl-mode", "ssl_mode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];
  let mode = "";
  for (const k of keys) {
    const v = u.searchParams.get(k);
    if (v != null && !mode && (k === "sslmode" || k === "ssl-mode" || k === "ssl_mode" || k === "ssl")) mode = v.trim().toLowerCase();
    u.searchParams.delete(k);
  }
  const want = String(override ?? "").trim().toLowerCase() || mode;
  let ssl: SslChoice;
  if (["disable", "disabled", "off", "false", "0"].includes(want)) ssl = false;
  else if (["verify-ca", "verify-full", "verify_ca", "verify_identity", "verify-identity", "verify"].includes(want)) ssl = { rejectUnauthorized: true };
  else if (["require", "required", "prefer", "preferred", "allow", "no-verify", "true", "1", "on"].includes(want)) ssl = { rejectUnauthorized: false };
  else ssl = LOCAL_HOSTS.test(u.hostname) ? false : { rejectUnauthorized: false };
  return { ssl, url: u.toString() };
}

export function isMultiparkDbConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!String(env[MULTIPARK_DB_ENV] ?? "").trim();
}

// ─── Erros ──────────────────────────────────────────────────────────────────

export type MultiparkDbErrorCode = "NOT_CONFIGURED" | "BAD_URL" | "NOT_READ_ONLY" | "CONNECT_FAILED" | "QUERY_FAILED";

export class MultiparkDbError extends Error {
  code: MultiparkDbErrorCode;
  constructor(message: string, code: MultiparkDbErrorCode) {
    super(message);
    this.name = "MultiparkDbError";
    this.code = code;
  }
}

/** Erro de driver → MultiparkDbError com a mensagem já sem segredos. */
function wrapDriverError(err: unknown, code: MultiparkDbErrorCode): MultiparkDbError {
  if (err instanceof MultiparkDbError) return err;
  const driverCode = (err as any)?.code ? ` [${String((err as any).code).slice(0, 32)}]` : "";
  return new MultiparkDbError(`${redactSecrets(err).slice(0, 400)}${driverCode}`, code);
}

// ─── Cliente ────────────────────────────────────────────────────────────────

export type SqlParam = string | number | boolean | Date | null;

export interface MultiparkDbClient {
  engine: MultiparkDbEngine;
  /**
   * Uma leitura (passa pela guarda) dentro de uma transação só de leitura.
   * Parâmetros: `$1, $2…` no Postgres, `?` no MySQL (ver `placeholder`).
   */
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Estado da sessão: a transação corrente é só de leitura? (para o teste de ligação) */
  readOnlyCheck(): Promise<boolean>;
  close(): Promise<void>;
}

/** Marcador do parâmetro n (1-based) para o motor. PURA. */
export function placeholder(engine: MultiparkDbEngine, n: number): string {
  return engine === "postgres" ? `$${n}` : "?";
}

let clientPromise: Promise<MultiparkDbClient> | null = null;

/** Cliente preguiçoso (uma pool por processo). Lança NOT_CONFIGURED sem env. */
export function getMultiparkDb(): Promise<MultiparkDbClient> {
  if (!clientPromise) {
    const url = currentUrl();
    if (!url) return Promise.reject(new MultiparkDbError(`${MULTIPARK_DB_ENV} não está definida.`, "NOT_CONFIGURED"));
    clientPromise = openClient(url).catch((err) => {
      clientPromise = null;
      throw wrapDriverError(err, "CONNECT_FAILED");
    });
  }
  return clientPromise;
}

/** Fecha a pool (script local / testes). */
export async function closeMultiparkDb(): Promise<void> {
  const p = clientPromise;
  clientPromise = null;
  if (p) {
    try { await (await p).close(); } catch { /* já fechada */ }
  }
}

/** Atalho: uma leitura na BD Multipark. */
export async function multiparkDbQuery<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
  return (await getMultiparkDb()).query<T>(sql, params);
}

async function openClient(url: string): Promise<MultiparkDbClient> {
  const engine = detectEngine(url);
  const { ssl, url: cleanUrl } = sslFromUrl(url, process.env.MULTIPARK_DB_SSL);
  return engine === "postgres" ? openPostgres(cleanUrl, ssl) : openMysql(cleanUrl, ssl);
}

async function openPostgres(url: string, ssl: SslChoice): Promise<MultiparkDbClient> {
  const mod: any = await import("pg");
  const Pool = mod.Pool ?? mod.default?.Pool;
  const pool = new Pool({
    connectionString: url,
    ssl: ssl || undefined,
    max: MULTIPARK_DB_POOL_MAX,
    idleTimeoutMillis: MULTIPARK_DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: MULTIPARK_DB_CONNECT_TIMEOUT_MS,
    query_timeout: MULTIPARK_DB_STATEMENT_TIMEOUT_MS + 2_000,
    application_name: "multipark-dashboard-readonly",
    allowExitOnIdle: true,
  });
  // Erros de ligações paradas na pool não podem derrubar o processo.
  pool.on("error", (err: unknown) => console.warn("[multiparkDb] ligação da pool falhou:", redactSecrets(err).slice(0, 160)));
  const ready = new WeakSet<object>();

  async function withReadOnly<T>(fn: (client: any) => Promise<T>): Promise<T> {
    let client: any;
    try { client = await pool.connect(); } catch (err) { throw wrapDriverError(err, "CONNECT_FAILED"); }
    let broken: unknown = undefined;
    try {
      if (!ready.has(client)) {
        await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
        // Datas e cursores em UTC (to_char de timestamptz usa o fuso da sessão).
        await client.query("SET TIME ZONE 'UTC'");
        ready.add(client);
      }
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${MULTIPARK_DB_STATEMENT_TIMEOUT_MS}`);
      return await fn(client);
    } catch (err) {
      if (!(err instanceof MultiparkDbError) && isConnectionError(err)) broken = err;
      throw wrapDriverError(err, "QUERY_FAILED");
    } finally {
      if (!broken) {
        try { await client.query("ROLLBACK"); } catch (err) { broken = err; }
      }
      client.release(broken instanceof Error ? broken : broken ? new Error("ligação inválida") : undefined);
    }
  }

  return {
    engine: "postgres",
    async query<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      assertReadOnlySql(sql);
      return withReadOnly(async (c) => (await c.query(sql, params)).rows as T[]);
    },
    async readOnlyCheck() {
      return withReadOnly(async (c) => String((await c.query("SHOW transaction_read_only")).rows?.[0]?.transaction_read_only ?? "").toLowerCase() === "on");
    },
    async close() { await pool.end(); },
  };
}

async function openMysql(url: string, ssl: SslChoice): Promise<MultiparkDbClient> {
  const u = new URL(url);
  const mysql: any = await import("mysql2/promise");
  const createPool = mysql.createPool ?? mysql.default?.createPool;
  const pool = createPool({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || undefined,
    ssl: ssl || undefined,
    connectionLimit: MULTIPARK_DB_POOL_MAX,
    maxIdle: MULTIPARK_DB_POOL_MAX,
    idleTimeout: MULTIPARK_DB_IDLE_TIMEOUT_MS,
    connectTimeout: MULTIPARK_DB_CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
    multipleStatements: false,
    timezone: "Z",
  });
  const ready = new WeakSet<object>();

  async function withReadOnly<T>(fn: (conn: any) => Promise<T>): Promise<T> {
    let conn: any;
    try { conn = await pool.getConnection(); } catch (err) { throw wrapDriverError(err, "CONNECT_FAILED"); }
    let broken = false;
    try {
      if (!ready.has(conn.connection ?? conn)) {
        await conn.query("SET SESSION TRANSACTION READ ONLY");
        await conn.query("SET time_zone = '+00:00'");
        // Teto por instrução (MySQL 5.7+; MariaDB usa max_statement_time em s).
        try { await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${MULTIPARK_DB_STATEMENT_TIMEOUT_MS}`); } catch {
          try { await conn.query(`SET SESSION max_statement_time = ${Math.ceil(MULTIPARK_DB_STATEMENT_TIMEOUT_MS / 1000)}`); } catch { /* o timeout do driver continua a valer */ }
        }
        ready.add(conn.connection ?? conn);
      }
      await conn.query("START TRANSACTION READ ONLY");
      return await fn(conn);
    } catch (err) {
      if (!(err instanceof MultiparkDbError) && isConnectionError(err)) broken = true;
      throw wrapDriverError(err, "QUERY_FAILED");
    } finally {
      if (!broken) {
        try { await conn.query("ROLLBACK"); } catch { broken = true; }
      }
      if (broken) { try { conn.destroy(); } catch { /* já fechada */ } } else conn.release();
    }
  }

  return {
    engine: "mysql",
    async query<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      assertReadOnlySql(sql);
      return withReadOnly(async (c) => {
        const [rows] = await c.query({ sql, values: params, timeout: MULTIPARK_DB_STATEMENT_TIMEOUT_MS + 2_000 });
        return rows as T[];
      });
    },
    async readOnlyCheck() {
      return withReadOnly(async (c) => {
        for (const v of ["@@transaction_read_only", "@@tx_read_only"]) {
          try {
            const [rows] = await c.query(`SELECT ${v} AS ro`);
            return Number((rows as any[])?.[0]?.ro) === 1;
          } catch { /* variável da outra versão */ }
        }
        return false;
      });
    },
    async close() { await pool.end(); },
  };
}

function isConnectionError(err: unknown): boolean {
  const code = String((err as any)?.code ?? "");
  return /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|PROTOCOL_CONNECTION_LOST|57P01|57P02|57P03|08)/.test(code)
    || /Connection terminated|connection is closed|Client has encountered a connection error|Query read timeout/i.test(String((err as any)?.message ?? ""));
}

// ─── Teste de ligação (Integrações → "Testar", só super_admin) ──────────────

export interface MultiparkDbTestResult {
  connected: boolean;
  engine: MultiparkDbEngine | null;
  version: string | null;
  readOnly: boolean;
  latencyMs: number;
  tables: number | null;
  error?: string;
}

/**
 * Liga, confirma que a sessão/transação é só de leitura, lê a versão e conta
 * as tabelas. Nada mais (nem nomes de tabelas, nem dados). Nunca lança.
 */
export async function testMultiparkDbConnection(): Promise<MultiparkDbTestResult> {
  const started = Date.now();
  let engine: MultiparkDbEngine | null = null;
  try {
    const db = await getMultiparkDb();
    engine = db.engine;
    const t0 = Date.now();
    const readOnly = await db.readOnlyCheck();
    const latencyMs = Date.now() - t0;
    const versionRows = db.engine === "postgres"
      ? await db.query<{ v: string }>("SELECT current_setting('server_version') AS v")
      : await db.query<{ v: string }>("SELECT VERSION() AS v");
    const countRows = db.engine === "postgres"
      ? await db.query<{ n: string | number }>("SELECT count(*) AS n FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'")
      : await db.query<{ n: string | number }>("SELECT count(*) AS n FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE()");
    return {
      connected: true,
      engine,
      version: String(versionRows[0]?.v ?? "").slice(0, 60) || null,
      readOnly,
      latencyMs,
      tables: countRows[0]?.n == null ? null : Number(countRows[0].n),
    };
  } catch (err) {
    return { connected: false, engine, version: null, readOnly: false, latencyMs: Date.now() - started, tables: null, error: redactSecrets(err).slice(0, 300) };
  }
}

/** Mensagem curta para o cartão das Integrações. PURA. */
export function describeMultiparkDbTest(r: MultiparkDbTestResult): string {
  if (!r.connected) return `Sem ligação: ${r.error ?? "erro desconhecido"}`;
  const engine = r.engine === "postgres" ? "PostgreSQL" : "MySQL";
  return [
    "Ligado",
    `${engine}${r.version ? ` ${r.version}` : ""}`,
    r.readOnly ? "só leitura confirmada" : "ATENÇÃO: a sessão NÃO ficou só de leitura",
    `${r.latencyMs} ms`,
    `${r.tables ?? "?"} tabela(s)`,
  ].join(" · ");
}
