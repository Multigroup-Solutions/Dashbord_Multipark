/**
 * Pesquisa global (Ctrl/Cmd+K) — uma caixa para reservas, clientes e
 * contactos, reclamações, emails, WhatsApp, tarefas, colaboradores,
 * utilizadores, parceiros, base de conhecimento, ajuda e atalhos (páginas e
 * ações). O servidor (`search.global`) aplica o acesso e as cidades de cada
 * fonte; aqui só se mostra, navega e guarda as pesquisas recentes (no
 * browser, localStorage).
 *
 * Teclado: ↑/↓ para escolher, Enter para abrir, Esc para fechar. No
 * telemóvel abre em ecrã inteiro.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import { Command as CommandPrimitive } from "cmdk";
import {
  BookOpen, Briefcase, CalendarCheck, Clock, Compass, FileText, Handshake, HelpCircle, ListTodo, Loader2, Mail, MessageCircle,
  MessageSquareWarning, Search, Sparkles, UserCog, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Kbd } from "@/components/ui/kbd";
import { useIsMobile } from "@/hooks/useMobile";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { openAssistantWith } from "@/components/assistant/AssistantWidget";
import {
  RECENT_SEARCHES_KEY, SEARCH_MIN_CHARS, addRecentSearch, parseRecentSearches, type SearchGroup, type SearchItem,
} from "@shared/globalSearch";

const GROUP_ICON: Record<SearchGroup, React.ElementType> = {
  navegacao: Compass, reservas: CalendarCheck, contactos: Users, reclamacoes: MessageSquareWarning, tarefas: ListTodo, email: Mail,
  whatsapp: MessageCircle, pessoas: Briefcase, utilizadores: UserCog, parceiros: Handshake, conhecimento: BookOpen, ajuda: HelpCircle,
};

/** Evento para abrir a paleta de qualquer lado (ex.: botão no topo). */
export const GLOBAL_SEARCH_EVENT = "mp:global-search";
export function openGlobalSearch() {
  window.dispatchEvent(new Event(GLOBAL_SEARCH_EVENT));
}

function loadRecent(): string[] {
  try { return parseRecentSearches(localStorage.getItem(RECENT_SEARCHES_KEY)); } catch { return []; }
}
function saveRecent(list: string[]) {
  try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list)); } catch { /* modo privado */ }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Botão do topo (abre a paleta). */
export function GlobalSearchButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openGlobalSearch}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      aria-label="Pesquisar (Ctrl+K)"
      title="Pesquisar em tudo (Ctrl+K)"
    >
      <Search className="h-4 w-4" />
      <span className="hidden lg:inline">Pesquisar…</span>
      <Kbd className="hidden lg:inline-flex">{isMac ? "⌘" : "Ctrl"} K</Kbd>
    </button>
  );
}

export function GlobalSearch() {
  const isMobile = useIsMobile();
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const debounced = useDebounced(q.trim(), 250);
  const enabled = open && debounced.length >= SEARCH_MIN_CHARS;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(GLOBAL_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(GLOBAL_SEARCH_EVENT, onOpen);
    };
  }, []);

  const search = trpc.search.global.useQuery({ q: debounced }, { enabled, staleTime: 30_000, placeholderData: keepPreviousData, retry: false });
  const openKb = trpc.knowledge.open.useMutation();
  const groups = enabled ? search.data?.groups ?? [] : [];
  const loading = enabled && (search.isFetching || debounced !== q.trim());

  const remember = (text: string) => {
    const next = addRecentSearch(recent, text);
    setRecent(next);
    saveRecent(next);
  };

  const close = () => { setOpen(false); };

  const goHref = (href: string) => {
    // Ficheiros (Drive, ligação temporária do armazenamento) abrem noutro separador.
    if (/^https:\/\//.test(href) || href.startsWith("/uploads/")) { window.open(href, "_blank", "noopener,noreferrer"); return; }
    const [path] = href.split("?");
    // Mesma página com outros parâmetros: recarrega para a página ler o filtro.
    if (path === location.split("?")[0] && href !== location) window.location.assign(href);
    else navigate(href);
  };

  const select = (item: SearchItem) => {
    remember(q);
    close();
    if (item.kbDocId) {
      openKb.mutate({ id: item.kbDocId }, {
        onSuccess: (r) => { if (r.url) goHref(r.url); else toast.error("Documento sem ligação."); },
        onError: (e) => toast.error(e.message),
      });
      return;
    }
    if (item.href) goHref(item.href);
  };

  const askAi = () => {
    const text = q.trim();
    if (!text) return;
    remember(text);
    close();
    openAssistantWith(text);
  };

  const total = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  const body = (
    <CommandPrimitive
      shouldFilter={false}
      loop
      className="flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground"
      onKeyDown={(e) => { if (e.key === "Escape") close(); }}
    >
      <div className="flex items-center gap-2 border-b px-3">
        <Search className="h-4 w-4 shrink-0 opacity-50" />
        <CommandPrimitive.Input
          autoFocus
          value={q}
          onValueChange={setQ}
          placeholder="Pesquisar reservas, clientes, reclamações, emails, tarefas, manuais…"
          className="flex h-12 w-full bg-transparent text-base sm:text-sm outline-none placeholder:text-muted-foreground"
          aria-label="Pesquisar"
        />
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {isMobile && (
          <button type="button" onClick={close} className="p-2 -mr-2 text-muted-foreground" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>
      <CommandPrimitive.List className={cn("overflow-y-auto overflow-x-hidden p-1", isMobile ? "flex-1" : "max-h-[60vh]")}>
        {q.trim().length < SEARCH_MIN_CHARS ? (
          recent.length ? (
            <CommandPrimitive.Group heading="Pesquisas recentes" className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
              {recent.map((r) => (
                <CommandPrimitive.Item key={`recent:${r}`} value={`recent:${r}`} onSelect={() => setQ(r)} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm data-[selected=true]:bg-accent">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">{r}</span>
                </CommandPrimitive.Item>
              ))}
              <CommandPrimitive.Item value="recent:clear" onSelect={() => { setRecent([]); saveRecent([]); }} className="cursor-pointer rounded-sm px-2 py-1.5 text-xs text-muted-foreground data-[selected=true]:bg-accent">
                Limpar pesquisas recentes
              </CommandPrimitive.Item>
            </CommandPrimitive.Group>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Escreve pelo menos {SEARCH_MIN_CHARS} letras. Ex.: nº de reserva, matrícula, nome, email, "nova reclamação".
            </p>
          )
        ) : (
          <>
            {!loading && enabled && total === 0 && !search.isError && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Sem resultados para «{debounced}».</p>
            )}
            {search.isError && <p className="px-3 py-4 text-center text-sm text-destructive">{search.error.message}</p>}
            {groups.map((g) => {
              const Icon = GROUP_ICON[g.group] ?? FileText;
              return (
                <CommandPrimitive.Group key={g.group} heading={g.label} className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
                  {g.timedOut && !g.items.length && <p className="px-2 py-1 text-xs text-muted-foreground">Sem resposta a tempo — abre a página para pesquisar.</p>}
                  {g.items.map((it) => (
                    <CommandPrimitive.Item
                      key={it.key}
                      value={it.key}
                      onSelect={() => select(it)}
                      className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-sm data-[selected=true]:bg-accent"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{it.title}</span>
                        {it.subtitle && <span className="block truncate text-xs text-muted-foreground">{it.subtitle}</span>}
                      </span>
                    </CommandPrimitive.Item>
                  ))}
                  {g.seeAllHref && g.items.length > 0 && (
                    <CommandPrimitive.Item
                      value={`seeall:${g.group}`}
                      onSelect={() => { remember(q); close(); goHref(g.seeAllHref!); }}
                      className="cursor-pointer rounded-sm px-2 py-1.5 pl-8 text-xs text-primary data-[selected=true]:bg-accent"
                    >
                      Ver todos em {g.label} →
                    </CommandPrimitive.Item>
                  )}
                </CommandPrimitive.Group>
              );
            })}
            <CommandPrimitive.Group heading="Assistente" className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
              <CommandPrimitive.Item value="ask-ai" onSelect={askAi} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm data-[selected=true]:bg-accent">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="truncate">Perguntar à IA: «{q.trim()}»</span>
              </CommandPrimitive.Item>
            </CommandPrimitive.Group>
          </>
        )}
      </CommandPrimitive.List>
      {!isMobile && (
        <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> escolher</span>
          <span><Kbd>Enter</Kbd> abrir</span>
          <span><Kbd>Esc</Kbd> fechar</span>
        </div>
      )}
    </CommandPrimitive>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="top" className="h-[100dvh] max-h-[100dvh] gap-0 p-0 [&>button:last-child]:hidden">
          <SheetTitle className="sr-only">Pesquisa global</SheetTitle>
          <SheetDescription className="sr-only">Pesquisa em reservas, contactos, reclamações, emails, tarefas e manuais.</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">Pesquisa global</DialogTitle>
        <DialogDescription className="sr-only">Pesquisa em reservas, contactos, reclamações, emails, tarefas e manuais.</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}

export default GlobalSearch;
