/**
 * Cidade do template WhatsApp nos diálogos de envio aos motoristas extra
 * (Disponibilidade, Leads de Extras, inbox).
 *
 * - Cidade por defeito: a do destinatário (ficha, turno ou lead); senão a do
 *   utilizador da dashboard; senão fica por escolher. Nunca Lisboa em silêncio.
 * - Lote com várias cidades: "Cidade de cada motorista" agrupa por cidade e
 *   mostra quantos vão em cada uma; quem não tem cidade só segue depois de lhe
 *   ser atribuída uma.
 * - Só se pode escolher uma cidade cujo template esteja APPROVED na Meta (o
 *   estado vem de `whatsapp.templatePreview`, que consulta a Meta).
 * - Pré-visualização do texto final do template de cada cidade (cabeçalho,
 *   corpo, rodapé e links dos botões: é aí que estão a morada, o telefone e o
 *   valor à hora), com o nome e o campo do diálogo substituídos.
 *
 * O nome e a língua de cada template vêm do registo `shared/driverTemplates.ts`;
 * este componente nunca escreve nomes de template.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  citiesWithTemplate,
  driverCityFrom,
  driverCityLabel,
  planCityGroups,
  type City,
  type CityChoice,
  type CityPlan,
} from "@shared/driverTemplates";
import { findWhatsAppTemplate, previewTemplateBody, resolveBodyParamRoles } from "@shared/whatsappTemplate";

const AUTO = "AUTO";
const UNSET = "__unset__";

export interface DriverCityRecipient {
  id: number;
  city: City | null;
  /** Nome usado na pré-visualização (primeiro nome). */
  name?: string | null;
}

export type PreviewCity = {
  city: City;
  templateName: string;
  languageCode: string;
  ok: boolean;
  inspected: boolean;
  approved: boolean;
  reason?: string;
  params: { recipient: string; shared: string } | null;
  bodyText?: string;
  /** Cabeçalho + corpo + rodapé + links dos botões, como aprovado na Meta. */
  fullText?: string;
  paramNames?: string[];
  paramCount?: number;
  hasDynamicUrlButton?: boolean;
};

export interface DriverCityState {
  plan: CityPlan;
  /** Motivo para bloquear o envio (cidade por escolher, template por aprovar). */
  blockReason: string | null;
  /** Cidade a usar num envio de teste. */
  testCity: City | null;
  choice: CityChoice | null;
  setChoice: (c: CityChoice | null) => void;
  missingCity: City | null;
  setMissingCity: (c: City | null) => void;
  allowAuto: boolean;
  userCity: City | null;
  /** Cidades com template para esta mensagem (Faro não tem todas). */
  available: City[];
  previews: PreviewCity[];
  previewLoading: boolean;
  recipients: DriverCityRecipient[];
}

/**
 * Estado da cidade de um diálogo. Reinicia os valores por defeito sempre que o
 * diálogo abre ou o conjunto de destinatários muda.
 */
export function useDriverCity(opts: {
  templateId: string;
  open: boolean;
  recipients: DriverCityRecipient[];
}): DriverCityState {
  const { templateId, open, recipients } = opts;
  const message = findWhatsAppTemplate(templateId)?.message;
  const available = useMemo(() => (message ? citiesWithTemplate(message) : []), [message]);
  const access = trpc.permissions.myCityAccess.useQuery(undefined, { enabled: open, staleTime: 5 * 60_000 });
  const userCityRaw = driverCityFrom(access.data?.cityName ?? (access.data?.cityNames?.length === 1 ? access.data.cityNames[0] : null));
  // A cidade do utilizador só serve de omissão se tiver template para esta mensagem.
  const userCity = userCityRaw && available.includes(userCityRaw) ? userCityRaw : null;
  const preview = trpc.whatsapp.templatePreview.useQuery({ templateId }, { enabled: open, staleTime: 5 * 60_000, retry: false });
  const previews = (preview.data?.cities ?? []) as PreviewCity[];

  const allowAuto = recipients.length > 1;
  const signature = recipients.map((r) => `${r.id}:${r.city ?? ""}`).join(",");
  const [choice, setChoice] = useState<CityChoice | null>(null);
  const [missingCity, setMissingCity] = useState<City | null>(null);

  useEffect(() => {
    if (!open) return;
    if (allowAuto) {
      setChoice(AUTO);
      setMissingCity(userCity);
    } else {
      const own = recipients[0]?.city;
      setChoice((own && available.includes(own) ? own : null) ?? userCity ?? null);
      setMissingCity(null);
    }
    // Só no abrir/mudar de destinatários (e quando a cidade do utilizador chega).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature, userCity, templateId]);

  const plan = useMemo(() => planCityGroups(recipients, choice, missingCity, available), [recipients, choice, missingCity, available]);

  const blockReason = useMemo(() => {
    if (!choice) return "Escolhe a cidade do template.";
    if (plan.missing.length) return `${plan.missing.length} sem cidade com este template: escolhe a cidade para esses.`;
    for (const g of plan.groups) {
      const p = previews.find((x) => x.city === g.city);
      if (p && p.inspected && !p.approved) return `O template de ${driverCityLabel(g.city)} não está disponível: ${p.reason ?? "por aprovar na Meta"}`;
    }
    return null;
  }, [choice, plan, previews]);

  const testCity: City | null = choice && choice !== AUTO ? choice : plan.groups[0]?.city ?? missingCity ?? userCity;

  return {
    plan,
    blockReason,
    testCity,
    choice,
    setChoice,
    missingCity,
    setMissingCity,
    allowAuto,
    userCity,
    available,
    previews,
    previewLoading: preview.isLoading,
    recipients,
  };
}

/** Pares id + cidade de um plano, prontos para o servidor. */
export function planEntries(plan: CityPlan): { id: number; city: City }[] {
  return plan.groups.flatMap((g) => g.ids.map((id) => ({ id, city: g.city })));
}

function cityOptionLabel(city: City, p: PreviewCity | undefined): string {
  if (p && p.inspected && !p.approved) return `${driverCityLabel(city)} (indisponível)`;
  return driverCityLabel(city);
}

function cityDisabled(p: PreviewCity | undefined): boolean {
  return !!p && p.inspected && !p.approved;
}

/**
 * Texto final de uma cidade, com o nome e o campo partilhado substituídos. Os
 * `{{...}}` do corpo são os primeiros do texto completo (cabeçalho de texto
 * sem variáveis), por isso os papéis do envio continuam a bater certo; um
 * `{{1}}` num link de botão fica à vista (é o link pessoal do formulário).
 */
function renderPreview(p: PreviewCity, name: string, shared: string): string {
  const slots = resolveBodyParamRoles(p.paramNames ?? [], p.paramCount ?? 0, p.params);
  return previewTemplateBody(p.fullText || p.bodyText || "", slots, { recipient: name, shared });
}

export function DriverCityPanel({
  state,
  sharedValue,
  noun = "motorista(s)",
}: {
  state: DriverCityState;
  /** Valor do campo do diálogo (dia/semana), para a pré-visualização. */
  sharedValue: string;
  noun?: string;
}) {
  const { choice, setChoice, missingCity, setMissingCity, allowAuto, plan, previews, previewLoading, recipients, userCity, available } = state;
  const usable = (r: DriverCityRecipient) => !!r.city && available.includes(r.city);
  const previewOf = (city: City) => previews.find((p) => p.city === city);
  const nameOf = (id: number | undefined) => recipients.find((r) => r.id === id)?.name || "Nome";

  // Cidades a pré-visualizar: as do plano; sem plano ainda, nenhuma.
  const shownCities = plan.groups.map((g) => g.city);
  const ownCount = recipients.filter(usable).length;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Cidade do template</Label>
        <Select
          value={choice ?? UNSET}
          onValueChange={(v) => setChoice(v === UNSET ? null : (v as CityChoice))}
        >
          <SelectTrigger>
            <SelectValue placeholder="Escolher cidade" />
          </SelectTrigger>
          <SelectContent>
            {!choice && <SelectItem value={UNSET} disabled>Escolher cidade</SelectItem>}
            {allowAuto && <SelectItem value={AUTO}>Cidade de cada {noun.replace(/\(s\)$/, "")}</SelectItem>}
            {available.map((c) => (
              <SelectItem key={c} value={c} disabled={cityDisabled(previewOf(c))}>
                {cityOptionLabel(c, previewOf(c))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!allowAuto && recipients[0] && (
          <p className="text-[11px] text-muted-foreground">
            {usable(recipients[0])
              ? `Cidade do destinatário: ${driverCityLabel(recipients[0].city!)}.`
              : recipients[0].city
                ? `${driverCityLabel(recipients[0].city)} ainda não tem este template: escolhe a cidade.`
                : userCity
                  ? `O destinatário não tem cidade; por defeito usa a tua (${driverCityLabel(userCity)}).`
                  : "O destinatário não tem cidade: escolhe uma."}
          </p>
        )}
        {allowAuto && choice === AUTO && (
          <p className="text-[11px] text-muted-foreground">
            {ownCount} de {recipients.length} com cidade própria.
          </p>
        )}
      </div>

      {allowAuto && choice === AUTO && recipients.some((r) => !usable(r)) && (
        <div className="space-y-1">
          <Label className="text-xs">
            Sem cidade com este template ({recipients.filter((r) => !usable(r)).length})
          </Label>
          <Select
            value={missingCity ?? UNSET}
            onValueChange={(v) => setMissingCity(v === UNSET ? null : (v as City))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Escolher cidade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Por escolher (não seguem)</SelectItem>
              {available.map((c) => (
                <SelectItem key={c} value={c} disabled={cityDisabled(previewOf(c))}>
                  {cityOptionLabel(c, previewOf(c))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Quantos vão em cada cidade */}
      {(plan.groups.length > 0 || plan.missing.length > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {plan.groups.map((g) => (
            <span key={g.city} className="rounded-full border px-2 py-0.5">
              {driverCityLabel(g.city)}: {g.ids.length}
            </span>
          ))}
          {plan.missing.length > 0 && (
            <span className="rounded-full border border-amber-400 text-amber-700 px-2 py-0.5">
              Sem cidade: {plan.missing.length}
            </span>
          )}
        </div>
      )}

      {/* Pré-visualização por cidade */}
      <div className="space-y-2">
        <Label className="text-xs">Pré-visualização</Label>
        {previewLoading ? (
          <p className="text-xs text-muted-foreground">A ler os templates na Meta…</p>
        ) : shownCities.length === 0 ? (
          <p className="text-xs text-muted-foreground">Escolhe a cidade para ver o texto.</p>
        ) : (
          shownCities.map((city) => {
            const p = previewOf(city);
            const firstId = plan.groups.find((g) => g.city === city)?.ids[0];
            if (!p) return null;
            if (!p.ok) {
              return (
                <p key={city} className="text-xs text-amber-700">
                  {driverCityLabel(city)} ({p.templateName}, {p.languageCode}):{" "}
                  {p.inspected ? p.reason : `${p.reason}. O envio continua a funcionar sem pré-visualização.`}
                </p>
              );
            }
            return (
              <div key={city} className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  {driverCityLabel(city)} · {p.templateName} · {p.languageCode}
                </p>
                <div className="rounded-md bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 p-3 text-sm whitespace-pre-wrap max-h-72 overflow-y-auto">
                  {renderPreview(p, nameOf(firstId), sharedValue)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
