// Ligar / WhatsApp / Email a partir das fichas (cliente, reserva, colaborador)
// — P3 lote 17f, parte 3. Nada é enviado daqui: o WhatsApp abre a conversa
// (cria-a só com o número se ainda não houver) e o email abre "Nova mensagem"
// na Comunicação já com o destinatário. Cada botão só aparece a quem pode.
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, Mail, MessageCircle, Phone } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { can } from "@shared/access";
import { composeEmailHref, contactEmails, contactPhones, whatsappConversationHref, type ContactPhone } from "@shared/contactActions";

const fmt = (p: ContactPhone) => {
  const m = p.e164?.match(/^\+351(\d{3})(\d{3})(\d{3})$/);
  return m ? `+351 ${m[1]} ${m[2]} ${m[3]}` : p.e164 ?? p.raw;
};

export function ContactActions({
  phones, emails, employeeId, mailbox, className,
}: {
  phones: ReadonlyArray<string | null | undefined>;
  emails: ReadonlyArray<string | null | undefined>;
  /** Ficha do colaborador: a conversa fica ligada a ele (se o número for o da ficha). */
  employeeId?: number | null;
  /** Caixa sugerida para o email (ex.: "rh"); sem ela, a da Comunicação. */
  mailbox?: string | null;
  className?: string;
}) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const ph = contactPhones(phones);
  const waPhones = ph.filter((p) => p.e164);
  const mails = contactEmails(emails);
  const canWa = !!user && can(user as any, "whatsapp", "view");
  const canWaEdit = !!user && can(user as any, "whatsapp", "edit");
  const canMail = !!user && can(user as any, "comunicacao", "view");
  // Interruptor WHATSAPP_CALLS (desligado por omissão): sem ele, "Ligar" é só pelo telemóvel.
  const callsFlag = trpc.whatsapp.calls.enabled.useQuery(undefined, { enabled: canWaEdit && waPhones.length > 0, staleTime: 5 * 60_000, retry: false });
  const callsOn = canWaEdit && !!callsFlag.data?.enabled;
  const open = trpc.whatsapp.conversations.openByPhone.useMutation({ onError: (e) => toast.error(e.message) });
  const openWa = async (p: ContactPhone, call = false) => {
    if (!p.e164) return;
    let r;
    try { r = await open.mutateAsync({ phone: p.e164, employeeId: employeeId ?? null }); } catch { return; } // o erro já foi mostrado
    if (r.created) toast.success("Conversa criada — escreve com um template (ainda não foi enviado nada).");
    navigate(whatsappConversationHref(r.conversationId, call));
  };

  if (!ph.length && !mails.length) return null;
  const btn = "h-8 gap-1.5";
  const busy = open.isPending;

  const waButton = canWa && waPhones.length > 0 && (
    waPhones.length === 1 ? (
      <Button size="sm" variant="outline" className={`${btn} text-green-700 dark:text-green-400`} disabled={busy} onClick={() => openWa(waPhones[0])} title={`WhatsApp ${fmt(waPhones[0])}`}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}WhatsApp
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className={`${btn} text-green-700 dark:text-green-400`} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}WhatsApp
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs">Abrir a conversa de</DropdownMenuLabel>
          {waPhones.map((p) => <DropdownMenuItem key={p.e164} onClick={() => openWa(p)}>{fmt(p)}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  );

  // "Ligar": pelo telemóvel (tel:) sempre; pelo WhatsApp só com o interruptor das chamadas.
  const callButton = ph.length > 0 && (
    ph.length === 1 && !callsOn ? (
      <Button size="sm" variant="outline" className={btn} asChild>
        <a href={`tel:${ph[0].e164 ?? ph[0].raw}`} title={`Ligar ${fmt(ph[0])}`}><Phone className="h-4 w-4" />Ligar</a>
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className={btn} disabled={busy}><Phone className="h-4 w-4" />Ligar</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {callsOn && waPhones.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs">Pelo WhatsApp</DropdownMenuLabel>
              {waPhones.map((p) => <DropdownMenuItem key={`w${p.e164}`} onClick={() => openWa(p, true)}>{fmt(p)}</DropdownMenuItem>)}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-xs">Pelo telemóvel</DropdownMenuLabel>
          {ph.map((p) => (
            <DropdownMenuItem key={`t${p.raw}`} asChild>
              <a href={`tel:${p.e164 ?? p.raw}`}>{fmt(p)}</a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  );

  // Email: pela Comunicação (fica na conversa da caixa); quem não a tem usa o programa de email do aparelho.
  const mailHref = (e: string) => (canMail ? composeEmailHref(e, mailbox) : `mailto:${e}`);
  const go = (e: string) => { if (canMail) navigate(mailHref(e)); else window.location.href = mailHref(e); };
  const mailButton = mails.length > 0 && (
    mails.length === 1 ? (
      <Button size="sm" variant="outline" className={btn} onClick={() => go(mails[0])} title={`Email ${mails[0]}`}>
        <Mail className="h-4 w-4" />Email
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className={btn}><Mail className="h-4 w-4" />Email</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs">Escrever para</DropdownMenuLabel>
          {mails.map((e) => <DropdownMenuItem key={e} onClick={() => go(e)}>{e}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  );

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      {callButton}
      {waButton}
      {mailButton}
    </div>
  );
}
