#!/usr/bin/env node
/**
 * Multipark Dashboard MCP Server (stdio) — SEM DEPENDÊNCIAS.
 *
 * Implementa o protocolo MCP (JSON-RPC 2.0 por stdin/stdout, newline-delimited)
 * à mão, para não precisar de `npm install`. Basta o Node (>=18, para o fetch).
 *
 * Expõe a Dashboard Multipark como tools MCP, falando com a API REST /api/v1.
 * Cobre todos os parques e cidades. O que cada tool pode fazer depende do
 * scope da API key (read / write / admin) — ver README.
 *
 * Configuração via variáveis de ambiente:
 *   MULTIPARK_API_URL  (default: https://dashbord-multipark.vercel.app/api/v1)
 *   MULTIPARK_API_KEY  (obrigatório)
 */
import { createInterface } from "node:readline";

const BASE_URL = (process.env.MULTIPARK_API_URL || "https://dashbord-multipark.vercel.app/api/v1").replace(/\/$/, "");
const API_KEY = process.env.MULTIPARK_API_KEY;

if (!API_KEY) {
  console.error("[multipark-mcp] Falta a variável de ambiente MULTIPARK_API_KEY.");
  process.exit(1);
}
if (typeof fetch !== "function") {
  console.error("[multipark-mcp] Precisas de Node.js 18 ou superior (fetch nativo).");
  process.exit(1);
}

async function api(method, path, { query, body } = {}) {
  let url = BASE_URL + path;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])
    ).toString();
    if (qs) url += "?" + qs;
  }
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.error) || text || res.statusText;
    throw new Error(`HTTP ${res.status} — ${msg}`);
  }
  return data;
}

// Cada tool: { name, description, inputSchema, run(args) }
const tools = [
  {
    name: "list_parks",
    description: "Lista todos os parques e cidades Multipark (Lisboa, Faro, Porto).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/parks"),
  },
  {
    name: "dashboard_summary",
    description: "Visão cruzada de toda a operação: stats de reservas, reclamações e totais por cidade. Opcional: from/to (YYYY-MM-DD).",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
    run: (a) => api("GET", "/dashboard/summary", { query: a }),
  },
  {
    name: "list_bookings",
    description: "Lista reservas (todos os parques/cidades). Filtros: city, parkId, status, parkingType, from, to (YYYY-MM-DD), search, limit (máx 500), offset.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" }, parkId: { type: "string" }, status: { type: "string" },
        parkingType: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        search: { type: "string" }, limit: { type: "number" }, offset: { type: "number" },
      },
    },
    run: (a) => api("GET", "/bookings", { query: a }),
  },
  {
    name: "booking_stats",
    description: "Estatísticas agregadas de reservas. Opcional: from, to (YYYY-MM-DD), projectId.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, projectId: { type: "number" } } },
    run: (a) => api("GET", "/bookings/stats", { query: a }),
  },
  {
    name: "get_booking",
    description: "Detalhe de uma reserva pelo externalId (local + ao vivo da API Multipark, tentando todos os parques).",
    inputSchema: { type: "object", properties: { externalId: { type: "string" } }, required: ["externalId"] },
    run: (a) => api("GET", `/bookings/${encodeURIComponent(a.externalId)}`),
  },
  {
    name: "list_complaints",
    description: "Lista reclamações. Filtros: status, type, projectId, assignedToId.",
    inputSchema: { type: "object", properties: { status: { type: "string" }, type: { type: "string" }, projectId: { type: "number" }, assignedToId: { type: "number" } } },
    run: (a) => api("GET", "/complaints", { query: a }),
  },
  {
    name: "complaint_stats",
    description: "Estatísticas das reclamações (por estado, em atraso). Opcional: projectId.",
    inputSchema: { type: "object", properties: { projectId: { type: "number" } } },
    run: (a) => api("GET", "/complaints/stats", { query: a }),
  },
  {
    name: "get_complaint",
    description: "Detalhe completo de uma reclamação (mensagens + fotos) pelo id.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    run: (a) => api("GET", `/complaints/${a.id}`),
  },
  {
    name: "create_complaint",
    description: "Cria uma reclamação. type: damage|dirt|delay|overcharge|staff|other. priority: low|medium|high|urgent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, type: { type: "string" }, priority: { type: "string" },
        description: { type: "string" }, clientName: { type: "string" }, clientEmail: { type: "string" },
        clientPhone: { type: "string" }, reservationRef: { type: "string" }, vehiclePlate: { type: "string" },
        slaHours: { type: "number" }, projectId: { type: "number" }, assignedToId: { type: "number" },
      },
      required: ["title", "type"],
    },
    run: (a) => api("POST", "/complaints", { body: a }),
  },
  {
    name: "update_complaint",
    description: "Atualiza uma reclamação. Campos: title, description, type, status (new|analyzing|waiting_client|resolved|closed), priority, assignedToId, penaltyPoints, slaHours.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" }, title: { type: "string" }, description: { type: "string" },
        type: { type: "string" }, status: { type: "string" }, priority: { type: "string" },
        assignedToId: { type: "number" }, penaltyPoints: { type: "number" }, slaHours: { type: "number" },
      },
      required: ["id"],
    },
    run: (a) => { const { id, ...body } = a; return api("PATCH", `/complaints/${id}`, { body }); },
  },
  {
    name: "add_complaint_message",
    description: "Adiciona uma mensagem/nota a uma reclamação. isInternal=true para nota interna (não visível ao cliente).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, message: { type: "string" }, isInternal: { type: "boolean" }, authorName: { type: "string" } },
      required: ["id", "message"],
    },
    run: (a) => { const { id, ...body } = a; return api("POST", `/complaints/${id}/messages`, { body }); },
  },
  {
    name: "delete_complaint",
    description: "Apaga uma reclamação (destrutivo — requer scope admin).",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    run: (a) => api("DELETE", `/complaints/${a.id}`),
  },
  {
    name: "list_campaigns",
    description: "Lista as campanhas de marketing (internas + ad) com id, tipo, projeto e orçamento diário.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/campaigns"),
  },
  {
    name: "get_campaign_daily",
    description: "Histórico diário de uma campanha (gasto, impressões, cliques, CTR, conversões, valor). campaignType: internal|ad.",
    inputSchema: {
      type: "object",
      properties: { campaignType: { type: "string" }, campaignId: { type: "number" } },
      required: ["campaignType", "campaignId"],
    },
    run: (a) => api("GET", `/campaigns/${encodeURIComponent(a.campaignType)}/${a.campaignId}/daily`),
  },
  {
    name: "list_reviews",
    description: "Lista avaliações Google. Filtros: rating (1-5), status, projectId.",
    inputSchema: { type: "object", properties: { rating: { type: "number" }, status: { type: "string" }, projectId: { type: "number" } } },
    run: (a) => api("GET", "/reviews", { query: a }),
  },
  {
    name: "create_review",
    description: "Regista uma avaliação Google. reviewerName e rating (1-5) obrigatórios.",
    inputSchema: {
      type: "object",
      properties: { reviewerName: { type: "string" }, rating: { type: "number" }, reviewText: { type: "string" }, reviewerEmail: { type: "string" }, reviewDate: { type: "string" }, projectId: { type: "number" }, vehiclePlate: { type: "string" } },
      required: ["reviewerName", "rating"],
    },
    run: (a) => api("POST", "/reviews", { body: a }),
  },
  {
    name: "list_vehicles",
    description: "Lista as viaturas internas.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/vehicles"),
  },
  {
    name: "list_employees",
    description: "Lista os colaboradores (RH).",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/employees"),
  },
  {
    name: "sync_recent",
    description: "Dispara a sincronização recente de reservas (report + enrich + history). Opcional: windowMinutes (default 30).",
    inputSchema: { type: "object", properties: { windowMinutes: { type: "number" } } },
    run: (a) => api("POST", "/sync/recent", { body: a }),
  },
  {
    name: "sync_future",
    description: "Sincroniza a janela futura de reservas. Opcional: weeksAhead (default 4).",
    inputSchema: { type: "object", properties: { weeksAhead: { type: "number" } } },
    run: (a) => api("POST", "/sync/future", { body: a }),
  },
  {
    name: "sync_day",
    description: "Sincroniza um dia específico (report + enrich + history) — útil para backfill histórico. date obrigatório (YYYY-MM-DD).",
    inputSchema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
    run: (a) => api("POST", "/sync/day", { body: a }),
  },
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ─── Transporte MCP: JSON-RPC 2.0 newline-delimited sobre stdin/stdout ──────────
const SERVER_INFO = { name: "multipark-dashboard", version: "1.0.0" };
let negotiatedProtocol = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      if (params?.protocolVersion) negotiatedProtocol = params.protocolVersion;
      reply(id, {
        protocolVersion: negotiatedProtocol,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notificação, sem resposta
    case "ping":
      if (isRequest) reply(id, {});
      return;
    case "tools/list": {
      if (isRequest) reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    }
    case "tools/call": {
      const tool = toolByName.get(params?.name);
      if (!tool) { if (isRequest) reply(id, { isError: true, content: [{ type: "text", text: `Tool desconhecida: ${params?.name}` }] }); return; }
      try {
        const result = await tool.run(params?.arguments ?? {});
        if (isRequest) reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        if (isRequest) reply(id, { isError: true, content: [{ type: "text", text: `Erro: ${err?.message || String(err)}` }] });
      }
      return;
    }
    default:
      if (isRequest) replyError(id, -32601, `Método não suportado: ${method}`);
      return;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  // Suporta batch (array) ou mensagem única
  const items = Array.isArray(msg) ? msg : [msg];
  for (const item of items) handle(item).catch((e) => console.error("[multipark-mcp]", e));
});
rl.on("close", () => {
  // Não forçamos process.exit: deixamos o event loop escoar respostas em curso
  // (fetches assíncronos) e o Node sai naturalmente quando não houver trabalho.
});

console.error(`[multipark-mcp] ligado a ${BASE_URL} — ${tools.length} tools disponíveis.`);
