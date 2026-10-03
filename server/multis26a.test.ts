/**
 * P3 lote 26a — Jorge (3 out 2026): a IA da equipa chama-se **Multis**, o
 * ícone é o símbolo da Multipark com uma estrelinha de IA, e no computador
 * fica um painel acoplado ao lado que não fecha ao navegar e volta à mesma
 * conversa. Respostas menos "tralhocas": regras de estilo no prompt.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSISTANT_NAME, MULTIS_PANEL_WIDTH_PX } from "../shared/assistant";
import { assistantSystemPrompt } from "./_core/ai/prompts/assistant";
import { CHAT_MESSAGES } from "./_core/ai/chat/engine";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Multis", () => {
  it("nome e ícone (P da Multipark + estrela)", () => {
    expect(ASSISTANT_NAME).toBe("Multis");
    const icon = src("client/src/components/assistant/MultisIcon.tsx");
    expect(icon).toContain('src="/icon-192.png"');
    expect(icon).toContain('fill="#FBBF24"');
    const w = src("client/src/components/assistant/AssistantWidget.tsx");
    expect(w).toContain("<MultisIcon");
    expect(w).not.toContain("Sparkles");
    expect(w).toContain("aria-label={`Abrir o ${ASSISTANT_NAME}`}");
    expect(w).toContain("Olá! Eu sou o {ASSISTANT_NAME}. Em que posso ajudar?");
  });

  it("computador: painel acoplado (sem bloquear o ecrã), o conteúdo encolhe; telemóvel: folha de baixo", () => {
    const w = src("client/src/components/assistant/AssistantWidget.tsx");
    expect(w).toContain("const docked = open && !isMobile;");
    expect(w).toMatch(/<aside[\s\S]*?className="fixed right-0 top-0 z-30 flex h-dvh flex-col border-l/);
    expect(w).toContain('<SheetContent side="bottom"');
    expect(MULTIS_PANEL_WIDTH_PX).toBe(400);
    const layout = src("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain("<SidebarInset style={multisDocked ? { marginRight: MULTIS_PANEL_WIDTH_PX } : undefined}>");
  });

  it("não fecha ao navegar e volta à mesma conversa (estado guardado fora da página)", () => {
    const store = src("client/src/components/assistant/multisStore.ts");
    expect(store).toContain('"mp.multis.open"');
    expect(store).toContain('"mp.multis.conversationId"');
    expect(store).toContain("useSyncExternalStore");
    // no telemóvel não reabre sozinha ao carregar
    expect(store).toContain('isDesktop() && localStorage.getItem(OPEN_KEY) === "1"');
    const w = src("client/src/components/assistant/AssistantWidget.tsx");
    expect(w).toContain("const { open, conversationId } = useMultisState();");
  });

  it("prompt: chama-se Multis e responde primeiro, passos numerados, tabelas para números", () => {
    const p = assistantSystemPrompt("(índice)");
    expect(p).toContain("Chamas-te Multis");
    expect(p).toContain("responde PRIMEIRO à pergunta");
    expect(p).toContain("passos numerados");
    expect(p).toContain("faz UMA pergunta curta em vez de adivinhar");
    expect(CHAT_MESSAGES.disabled).toContain("O Multis");
    expect(p).toContain("Olá! Eu sou o Multis. Em que posso ajudar?");
  });

  it("ajuda própria e nomes nos outros sítios", () => {
    expect(src("docs/ajuda/multis.md")).toContain("painel fixo à direita");
    expect(src("client/src/components/GlobalSearch.tsx")).toContain("Perguntar ao Multis");
  });
});
