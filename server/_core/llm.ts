import { ENV } from "./env";
import { fetchWithTimeout } from "./fetchWithTimeout";

/** Prazo de uma chamada ao LLM (abaixo dos 60 s do Vercel). */
const LLM_TIMEOUT_MS = 45_000;

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const resolveApiUrl = () => {
  // .trim() defensivo: vars de ambiente coladas no Vercel trazem por vezes
  // espaços/newline no fim, que partem o URL ou os headers HTTP.
  const url = (process.env.LLM_API_URL || process.env.OPENAI_API_URL || "").trim();
  if (!url) throw new Error("LLM_API_URL or OPENAI_API_URL is not configured");
  const base = url.replace(/\/$/, "");
  // Gemini OpenAI-compatible endpoint already includes /v1beta/openai
  if (base.includes("/openai")) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
};

/** IA configurada? (chave presente) — fonte única para toda a app. */
export function llmConfigured(): boolean {
  return !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

const resolveApiKey = () => {
  const key = (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "").trim();
  if (!key) throw new Error("LLM_API_KEY or OPENAI_API_KEY is not configured");
  return key;
};

// Modelo das env vars, sem espaços/newline; fallback por provider.
const resolveModel = (fallback: string) => (process.env.LLM_MODEL || "").trim() || fallback;

/** Modelos por omissão quando LLM_MODEL não está definido. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * Estado do modelo configurado (para o hub de Integrações): qual o
 * fornecedor, que modelo vai ser usado e se é o de omissão (aviso: o de
 * omissão pode ser retirado pelo fornecedor sem ninguém dar conta). PURA.
 */
export function llmModelStatus(env: Record<string, string | undefined> = process.env): {
  provider: "anthropic" | "openai_compatible"; model: string; source: "env" | "default"; warning: string | null;
} {
  const anthropic = (env.LLM_API_URL || "").trim().includes("anthropic");
  const def = anthropic ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
  const raw = (env.LLM_MODEL || "").trim();
  const provider = anthropic ? "anthropic" as const : "openai_compatible" as const;
  if (!raw) return { provider, model: def, source: "default", warning: "LLM_MODEL não definido — a usar o modelo por omissão do código." };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,127}$/.test(raw)) return { provider, model: raw, source: "env", warning: "LLM_MODEL tem um formato inválido (espaços ou caracteres estranhos)." };
  if (raw === def) return { provider, model: raw, source: "env", warning: "LLM_MODEL igual ao modelo por omissão — confirma que continua disponível." };
  return { provider, model: raw, source: "env", warning: null };
}

/**
 * Erro do fornecedor → mensagem CURTA para a UI (nunca o corpo da resposta,
 * que pode trazer o pedido, dados de clientes ou pistas da chave). O corpo
 * vai só para o log do servidor, cortado. PURA (exceto o log).
 */
export function llmErrorMessage(status: number, bodyText: string): string {
  let type: string | null = null;
  try {
    const j = JSON.parse(bodyText);
    const t = j?.error?.type ?? j?.error?.code ?? j?.type;
    if (typeof t === "string" && /^[a-z0-9_.-]{1,60}$/i.test(t)) type = t;
  } catch { /* texto */ }
  const hint = status === 401 || status === 403 ? "chave inválida ou sem permissão"
    : status === 404 ? "modelo ou endereço inexistente (ver LLM_MODEL/LLM_API_URL)"
    : status === 429 ? "limite de pedidos atingido"
    : status >= 500 ? "serviço indisponível" : "pedido recusado";
  return `Falha no serviço de IA (HTTP ${status}: ${hint}${type ? `, ${type}` : ""}).`;
}

async function failLLM(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  const scrubbed = body.replace(/(sk-|sk_|key-)[A-Za-z0-9_-]{8,}/g, "***").slice(0, 500);
  console.warn(`[LLM] HTTP ${response.status}: ${scrubbed}`);
  throw new Error(llmErrorMessage(response.status, body));
}

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

function isAnthropic(): boolean {
  const url = (process.env.LLM_API_URL || "").trim();
  return url.includes("anthropic");
}

async function invokeClaude(params: InvokeParams): Promise<InvokeResult> {
  const apiKey = resolveApiKey();
  // Usa o LLM_MODEL (limpo) se definido; senão o modelo por omissão (aviso no hub).
  const model = resolveModel(DEFAULT_ANTHROPIC_MODEL);

  // Separate system message from user/assistant messages
  const normalized = params.messages.map(normalizeMessage);
  let system = "";
  const msgs: any[] = [];
  for (const m of normalized) {
    if (m.role === "system") {
      system += (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) + "\n";
    } else {
      // Convert OpenAI image_url format to Anthropic format
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.map((part: any) => {
          if (part.type === "image_url" && part.image_url?.url) {
            const url = part.image_url.url;
            // If it's a data URI, extract base64
            const dataMatch = url.match(/^data:(image\/\w+);base64,(.+)$/);
            if (dataMatch) {
              return {
                type: "image",
                source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] },
              };
            }
            // Otherwise it's a URL
            return {
              type: "image",
              source: { type: "url", url },
            };
          }
          // PDF em data URI → bloco "document" do Claude (ex.: documentos do RH)
          if (part.type === "file_url" && part.file_url?.url) {
            const pdf = String(part.file_url.url).match(/^data:application\/pdf;base64,(.+)$/);
            if (pdf) return { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf[1] } };
          }
          return part;
        });
      }
      msgs.push({ role: m.role, content });
    }
  }

  const maxTokens = params.maxTokens ?? params.max_tokens ?? 4096;
  const payload: Record<string, unknown> = {
    model,
    max_tokens: Math.max(1, Math.floor(maxTokens)),
    messages: msgs,
  };

  // JSON pedido: json_schema → ferramenta com esse schema (a resposta vem
  // estruturada no tool_use); json_object → instrução "só JSON".
  const format = normalizeResponseFormat(params);
  const JSON_TOOL = "responder_json";
  if (format?.type === "json_schema") {
    payload.tools = [{ name: JSON_TOOL, description: format.json_schema.name || "Resposta estruturada", input_schema: format.json_schema.schema }];
    payload.tool_choice = { type: "tool", name: JSON_TOOL };
  } else if (format?.type === "json_object") {
    system += "Responde APENAS com um objeto JSON válido, sem texto antes ou depois e sem blocos de código.\n";
  }
  if (system.trim()) payload.system = system.trim();

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
    timeoutMs: LLM_TIMEOUT_MS,
  });

  if (!response.ok) await failLLM(response);

  const data = await response.json() as any;

  // Convert Anthropic response to OpenAI format
  const toolUse = format?.type === "json_schema" ? data.content?.find((c: any) => c.type === "tool_use" && c.name === JSON_TOOL) : null;
  const textContent = toolUse ? JSON.stringify(toolUse.input ?? {}) : data.content?.find((c: any) => c.type === "text")?.text || "";
  return {
    id: data.id || "",
    created: Date.now(),
    model: data.model || model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: textContent },
      finish_reason: data.stop_reason || "stop",
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    } : undefined,
  };
}

async function invokeOpenAI(params: InvokeParams): Promise<InvokeResult> {
  const apiKey = resolveApiKey();
  const apiUrl = resolveApiUrl();

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  const model = resolveModel(DEFAULT_OPENAI_MODEL);

  const payload: Record<string, unknown> = {
    model,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  payload.max_tokens = params.maxTokens ?? params.max_tokens ?? 32768;

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetchWithTimeout(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    timeoutMs: LLM_TIMEOUT_MS,
  });

  if (!response.ok) await failLLM(response);

  return (await response.json()) as InvokeResult;
}

/** Teste barato (Integrações → Testar): 1 token de resposta. */
export async function testLLM(): Promise<{ model: string }> {
  const r = await invokeLLM({ messages: [{ role: "user", content: "Responde só: ok" }], maxTokens: 1 });
  return { model: r.model || llmModelStatus().model };
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (isAnthropic()) {
    return invokeClaude(params);
  }
  return invokeOpenAI(params);
}
