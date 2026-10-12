#!/usr/bin/env node
/**
 * Multipark Dashboard MCP Server (stdio) — SEM DEPENDÊNCIAS.
 *
 * Implementa o protocolo MCP (JSON-RPC 2.0 por stdin/stdout, newline-delimited)
 * à mão, para não precisar de `npm install`. Basta o Node (>=18, para o fetch).
 *
 * Expõe a Dashboard Multipark como tools MCP, falando com a API REST /api/v1.
 * Cobre todos os parques e cidades. O que cada tool pode fazer depende das
 * capacidades da API key (relatórios, caixa, marketing, dados pessoais,
 * reclamações…) — ver README.
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
    description: "Detalhe de uma reserva pelo externalId (cópia local + ao vivo da BD Multipark).",
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
    description: "Arquiva uma reclamação (não apaga: fica nas arquivadas, com mensagens e fotos). Requer a capacidade admin.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    run: (a) => api("DELETE", `/complaints/${a.id}`),
  },
  {
    name: "list_campaigns",
    description: "Lista as campanhas de marketing (internas, ad antigas e 'api' = Google Ads/Meta) com id, tipo, projeto e orçamento diário.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("GET", "/campaigns"),
  },
  {
    name: "get_campaign_daily",
    description: "Histórico diário de uma campanha das APIs Google Ads/Meta (gasto, moeda, impressões, cliques, conversões, valor). campaignType: api (os tipos antigos internal|ad devolvem 410).",
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
  // ── Relatórios (só leitura): caixa, condutores, parceiros, passagens de turno ──
  {
    name: "cash_counts",
    description: "Contagens de caixa por parque e dia (recebido em dinheiro, gastos, previsto, contado, diferença, quem contou) com totais por dia e por cidade. from e to (AAAA-MM-DD) obrigatórios, máx. 366 dias. Opcional: parkId, city (lisbon|porto|faro). difference = contado − previsto.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, parkId: { type: "string" }, city: { type: "string" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/cash/counts", { query: a }),
  },
  {
    name: "cash_count_detail",
    description: "Uma contagem de caixa (parque + dia): gastos pagos e cada versão gravada, com quem alterou e quando.",
    inputSchema: { type: "object", properties: { parkId: { type: "string" }, day: { type: "string" } }, required: ["parkId", "day"] },
    run: (a) => api("GET", `/cash/counts/${encodeURIComponent(a.parkId)}/${encodeURIComponent(a.day)}`),
  },
  {
    name: "cash_cases",
    description: "Fila da 'Correção de caixa' (divergências de preço, método, pago, contagem). Filtros: view (abertos|fechados|todos), severity (critical|high|medium), code, parkId, day, limit, offset.",
    inputSchema: { type: "object", properties: { view: { type: "string" }, severity: { type: "string" }, code: { type: "string" }, parkId: { type: "string" }, day: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } } },
    run: (a) => api("GET", "/cash/cases", { query: a }),
  },
  {
    name: "cash_case_detail",
    description: "Um caso da 'Correção de caixa' com a linha do tempo: quem abriu, analisou, fechou, motivo e explicação.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    run: (a) => api("GET", `/cash/cases/${a.id}`),
  },
  {
    name: "drivers_daily",
    description: "Condutores por dia: km, horas trabalhadas e paradas, velocidade média e máxima, excessos de velocidade, bateria, com resumo por condutor. from e to obrigatórios (máx. 366 dias). Opcional: employeeId.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, employeeId: { type: "number" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/drivers/daily", { query: a }),
  },
  {
    name: "partners_billing",
    description: "A faturar por parceiro num período: reservas, receita bruta e líquida, comissão ou avença (aFaturar). from e to obrigatórios. Opcional: partnerType, projectId.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, partnerType: { type: "string" }, projectId: { type: "number" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/partners/billing", { query: a }),
  },
  {
    name: "partners_close",
    description: "Fecho de parceiros de um mês (AAAA-MM): por parceiro, valores da Multipark vs cópia, faturas, reservas sem fatura, diferenças e quem fechou e quando.",
    inputSchema: { type: "object", properties: { month: { type: "string" } }, required: ["month"] },
    run: (a) => api("GET", "/partners/close", { query: a }),
  },
  {
    name: "shift_handovers",
    description: "Passagens de turno por dia e cidade: caixa no cofre, bolsas, gastos pagos, quem preencheu e quem confirmou. from e to obrigatórios. Opcional: city.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, city: { type: "string" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/shift-handovers", { query: a }),
  },
  {
    name: "marketing_stats",
    description: "Marketing (mesmos números do ecrã Marketing do Dashboard): gasto em anúncios (Google Ads, Meta), reservas, custo por reserva e ROAS no período. from e to obrigatórios (máx. 366 dias). Opcional: projectId (cidade).",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, projectId: { type: "number" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/marketing/stats", { query: a }),
  },
  {
    name: "marketing_channels",
    description: "Mix de canais de marketing: de onde vêm as reservas (pago, orgânico, direto, parceiros...) e o gasto associado. from e to obrigatórios. Opcional: projectId.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, projectId: { type: "number" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/marketing/channels", { query: a }),
  },
  {
    name: "marketing_brands",
    description: "Gasto em anúncios e reservas por marca (AirPark, RedPark, SkyPark, Multipark...), com o mesmo gasto do ecrã. from e to obrigatórios. Opcional: projectId.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, projectId: { type: "number" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/marketing/brands", { query: a }),
  },
  {
    name: "marketing_campaign_roas",
    description: "ROAS por campanha: reservas ligadas a cada campanha por utm_campaign ou código de desconto, versus o gasto. from e to obrigatórios. Opcional: projectId.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, projectId: { type: "number" } }, required: ["from", "to"] },
    run: (a) => api("GET", "/marketing/campaign-roas", { query: a }),
  },
  {
    name: "web_overview",
    description: "Visitas aos sites: Google Analytics (sessões, eventos-chave, receita) e Search Console (cliques, impressões, posição), totais e por dia, com comparação com o período anterior ou o ano anterior. from e to obrigatórios. Opcional: brand (multipark|multibags|redpark|skypark|airpark|multidriver), compare (previous|yoy).",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, brand: { type: "string" }, compare: { type: "string", enum: ["previous", "yoy"] } }, required: ["from", "to"] },
    run: (a) => api("GET", "/web/overview", { query: a }),
  },
  {
    name: "web_list",
    description: "Tabelas de web analytics. source=ga: dim = channel|landing|device|country|city|event; source=sc: dim = query|page|device|country. Opcional: brand, compare, sort, pageSize (5-100), search. from e to obrigatórios.",
    inputSchema: { type: "object", properties: { source: { type: "string", enum: ["ga", "sc"] }, dim: { type: "string" }, from: { type: "string" }, to: { type: "string" }, brand: { type: "string" }, compare: { type: "string", enum: ["previous", "yoy"] }, sort: { type: "string" }, pageSize: { type: "number" }, search: { type: "string" } }, required: ["source", "dim", "from", "to"] },
    run: (a) => api("GET", "/web/list", { query: a }),
  },
  // ── MCP pessoal: qualquer leitura dos ecrãs, como quem criou a chave (capacidade owner:read) ──
  {
    name: "dashboard_procedures",
    description: "Lista as LEITURAS do Dashboard (os mesmos procedimentos dos ecrãs): RH, ponto, horários, férias, salários, CRM, despesas, extras, tarefas, ocorrências, perdidos e achados, WhatsApp, email, formação, reservas da Multipark, etc. Usa search com palavras do caminho (ex.: \"rh\", \"expenses\", \"crm client\", \"whatsapp\", \"multipark\"). Com withInput=true devolve também o input de cada uma (JSON Schema) — pede-o só depois de filtrar, porque é grande. Depois chama dashboard_query. Requer a capacidade 'MCP pessoal' na chave.",
    inputSchema: { type: "object", properties: { search: { type: "string" }, withInput: { type: "boolean" } } },
    run: (a) => api("GET", "/procedures", { query: { search: a.search, withInput: a.withInput ? "1" : undefined } }),
  },
  {
    name: "dashboard_query",
    description: "Corre uma leitura do Dashboard pelo caminho (ex.: \"rh.list\") com o input em JSON, como quem criou a chave: vê exatamente o que essa pessoa vê na app. Datas podem ir em texto (AAAA-MM-DD ou ISO). Só leituras; as alterações respondem 403. Se o resultado for grande, usa filtros/paginação do input.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, input: {} }, required: ["path"] },
    run: (a) => api("POST", "/procedures/call", { body: { path: a.path, input: a.input } }),
  },
  {
    name: "dashboard_actions",
    description: "Lista as ALTERAÇÕES que o MCP pode fazer no Dashboard, por área: Faltas, Ponto, Avaliação (pontos), Utilizadores (juntar/separar), Clientes (juntar/separar), Tarefas, Críticas, Reclamações, Perdidos e achados, Ocorrências. search filtra pelo caminho ou pela área. withInput=true traz o input de cada uma. external=true quer dizer que sai para fora (Google ou email ao cliente). Requer a capacidade 'MCP pessoal (alterar)'.",
    inputSchema: { type: "object", properties: { search: { type: "string" }, withInput: { type: "boolean" } } },
    run: (a) => api("GET", "/procedures/actions", { query: { search: a.search, withInput: a.withInput ? "1" : undefined } }),
  },
  {
    name: "dashboard_action",
    description: "Faz uma alteração no Dashboard em nome de quem criou a chave (fica nos Logs em nome dessa pessoa, com as permissões dela). Antes de alterar, confirma com o Jorge o que vais fazer (o quê, a quem, valores). Para as que saem para fora (external: publicar resposta no Google, email ao cliente) mostra-lhe o texto final e só depois manda confirmExternal: true. Só as da lista de dashboard_actions.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, input: {}, confirmExternal: { type: "boolean" } }, required: ["path"] },
    run: (a) => api("POST", "/procedures/action", { body: { path: a.path, input: a.input, confirmExternal: a.confirmExternal === true } }),
  },
];

/** Texto devolvido ao Claude acima disto é cortado (com aviso), para não rebentar o contexto. */
const MAX_TEXT = 200_000;

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ─── Transporte MCP: JSON-RPC 2.0 newline-delimited sobre stdin/stdout ──────────
const SERVER_INFO = { name: "multipark-dashboard", version: "1.1.0" };
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
        let text = JSON.stringify(result, null, 2);
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n\n… [cortado: ${text.length} caracteres no total — usa filtros ou paginação]`;
        if (isRequest) reply(id, { content: [{ type: "text", text }] });
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
