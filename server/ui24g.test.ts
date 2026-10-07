/**
 * P3 lote 24g — Jorge (3 out 2026): "os botões são todos em branco; os que
 * estão clicados são azuis". No modo claro todos os botões ficam brancos com
 * borda azul; azul cheio só o botão ESCOLHIDO num grupo (filtro, vista,
 * opção ligada) — variante `selected` — e o separador ativo. Modo escuro igual.
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("botões brancos; o escolhido azul", () => {
  const b = src("client/src/components/ui/button.tsx");
  it("principal (default) e secundário brancos com borda azul no modo claro; escuro como antes", () => {
    expect(b).toContain('"border border-primary bg-white text-primary shadow-xs hover:bg-primary/10 dark:border-transparent dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"');
    expect(b).toContain('"border border-primary bg-white text-secondary-foreground shadow-xs hover:bg-accent dark:border-transparent dark:bg-secondary dark:hover:bg-secondary/80"');
  });
  it("variante 'selected' = azul cheio; botões com cor própria (verde do WhatsApp) ficam sem a borda azul", () => {
    expect(b).toContain('"border border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"');
    expect(b).toContain('ownColor && "border-transparent"');
  });
  it("o separador ativo já é azul; a página ativa da paginação também", () => {
    expect(src("client/src/components/ui/tabs.tsx")).toContain("data-[state=active]:bg-primary data-[state=active]:text-primary-foreground");
    expect(src("client/src/components/ui/pagination.tsx")).toContain('variant: isActive ? "selected" : "ghost",');
  });
  it("nenhum botão de escolha ficou com 'default'/'secondary' para marcar o escolhido", () => {
    const files = globSync("client/src/**/*.tsx", { cwd: fileURLToPath(new URL("..", import.meta.url)) })
      .map((file) => file.replaceAll("\\", "/"));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = src(f).split("\n");
      lines.forEach((l, i) => {
        if (/<Badge/.test(l)) return;
        if (/variant=\{[^}]*\?\s*"(default|secondary)"\s*:\s*"(outline|ghost)"\s*\}/.test(l)) offenders.push(`${f}:${i + 1}`);
      });
    }
    // Exceções de propósito: destaque de uma ação (não é escolha).
    expect(offenders.sort()).toEqual(["client/src/components/CameraCapture.tsx:115", "client/src/pages/GoogleReviewsPage.tsx:684"]);
    expect(src("client/src/pages/TasksPage.tsx")).toContain('variant={viewMode === "kanban" ? "selected" : "ghost"}');
    expect(src("client/src/pages/HRPage.tsx")).toContain('variant={d.isWorkDay ? "selected" : "outline"}');
  });
});
