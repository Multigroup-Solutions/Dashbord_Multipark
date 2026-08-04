import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { ChevronDown, ChevronRight, Mail } from "lucide-react";

export type CaseMessage = {
  id: number | string;
  author?: string | null;
  createdAt?: string | null;
  message: string;
  isInternal?: number | boolean | null;
};

/**
 * Uma mensagem de caso (Reclamações / Perdidos). Emails transcritos (📧/📤) e
 * mensagens longas aparecem FECHADOS — só autor + assunto + data — e abrem ao
 * clicar. Evita que um email de 3 páginas estique a ficha toda.
 */
function MessageBubble({ m }: { m: CaseMessage }) {
  const [open, setOpen] = useState(false);
  const text = m.message ?? "";
  const trimmed = text.trim();
  const isEmail = /^(📧|📤)/.test(trimmed);
  const lines = text.split("\n");
  const isLong = isEmail || text.length > 300 || lines.length > 4;
  const subject = (lines[0] ?? "").replace(/^(📧|📤)\s*/, "").trim() || "(sem assunto)";
  const internal = !!m.isInternal;

  return (
    <div className={`rounded-lg text-sm border ${internal ? "bg-amber-50 border-amber-200" : "bg-muted border-transparent"}`}>
      <div
        className={`flex items-start gap-2 p-3 ${isLong ? "cursor-pointer select-none" : ""}`}
        onClick={isLong ? () => setOpen((v) => !v) : undefined}
      >
        {isLong && (
          open
            ? <ChevronDown className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
            : <ChevronRight className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
        )}
        {isEmail && <Mail className="w-4 h-4 shrink-0 mt-0.5 text-blue-600" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{m.author || "—"}</span>
            {isEmail && <Badge variant="outline" className="text-[10px] text-blue-700">Email</Badge>}
            {internal && <Badge variant="outline" className="text-[10px] text-amber-700">Nota interna</Badge>}
            <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">
              {m.createdAt ? fmtPTDateTime(m.createdAt) : ""}
            </span>
          </div>
          {isLong && !open && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {subject.slice(0, 140)} <span className="italic">— clicar para abrir</span>
            </p>
          )}
        </div>
      </div>
      {(!isLong || open) && (
        <p className="px-3 pb-3 pt-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
      )}
    </div>
  );
}

/**
 * Lista de mensagens com altura FIXA e scroll próprio — a ficha nunca estica
 * por causa das mensagens (div nativo; o ScrollArea do Radix com max-h não
 * trava a altura).
 */
export default function CaseMessageList({
  messages,
  emptyText = "Sem mensagens",
}: {
  messages: CaseMessage[];
  emptyText?: string;
}) {
  return (
    <div className="max-h-[45vh] overflow-y-auto overflow-x-hidden pr-1 space-y-2">
      {messages.length === 0 && (
        <p className="text-center text-muted-foreground py-8 text-sm">{emptyText}</p>
      )}
      {messages.map((m) => <MessageBubble key={m.id} m={m} />)}
    </div>
  );
}
