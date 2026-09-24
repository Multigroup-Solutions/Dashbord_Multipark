import { ENV } from "./env";

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
  // Usa o LLM_MODEL (limpo) se definido; senão um Sonnet 4 válido por defeito.
  const model = resolveModel("claude-sonnet-4-20250514");

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

  const payload: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: msgs,
  };
  if (system.trim()) payload.system = system.trim();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  const data = await response.json() as any;

  // Convert Anthropic response to OpenAI format
  const textContent = data.content?.find((c: any) => c.type === "text")?.text || "";
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

  const model = resolveModel("gpt-4o-mini");

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

  payload.max_tokens = 32768;

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as InvokeResult;
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  if (isAnthropic()) {
    return invokeClaude(params);
  }
  return invokeOpenAI(params);
}
