/**
 * Assistente (chat da equipa) — regras partilhadas servidor ↔ cliente:
 * perguntas sugeridas por página (filtradas pelo que a pessoa pode ver).
 */
import { can, type ModuleId } from "./access";

export interface AssistantSuggestion {
  text: string;
  /** Só aparece a quem tem este módulo (ver). */
  module?: ModuleId;
}

const BY_PATH: Array<{ prefix: string; items: AssistantSuggestion[] }> = [
  { prefix: "/extras-dia", items: [
    { text: "Quantos extras estão escalados para amanhã?", module: "extras_dia" },
    { text: "Em que horas faltam condutores amanhã?", module: "extras_dia" },
    { text: "Como aviso a equipa por WhatsApp?" },
    { text: "Como uso o \"Preencher com disponíveis\"?" },
  ] },
  { prefix: "/disponibilidade", items: [
    { text: "Como marco a minha disponibilidade?" },
    { text: "Posso alterar a disponibilidade depois de guardar?" },
  ] },
  { prefix: "/rh", items: [
    { text: "Como pico o ponto?" },
    { text: "Que documentos tenho de carregar?" },
    { text: "Como crio um novo colaborador?", module: "rh" },
  ] },
  { prefix: "/perfil", items: [
    { text: "Como pico o ponto?" },
    { text: "Como está a minha avaliação este mês?" },
  ] },
  { prefix: "/reclamacoes", items: [
    { text: "Quantas reclamações estão abertas?", module: "reclamacoes" },
    { text: "Como crio uma reclamação?" },
    { text: "Como envio um email ao cliente?" },
  ] },
  { prefix: "/ocorrencias", items: [
    { text: "Quantas ocorrências estão em aberto?", module: "ocorrencias" },
    { text: "O que é \"confirmar envolvimento\"?" },
  ] },
  { prefix: "/perdidos-achados", items: [
    { text: "Quantos perdidos estão por devolver?", module: "perdidos" },
    { text: "Como registo a devolução ao cliente?" },
  ] },
  { prefix: "/whatsapp", items: [
    { text: "Quantas conversas estão por responder?", module: "whatsapp" },
    { text: "O que é a janela de 24 horas?" },
    { text: "Como envio um template?" },
  ] },
  { prefix: "/passagem-turno", items: [
    { text: "Como preencho a passagem de turno?" },
    { text: "Quem pode alterar uma passagem depois de 24 h?" },
  ] },
  { prefix: "/tarefas", items: [
    { text: "Que tarefas tenho por fazer?", module: "tarefas" },
    { text: "Como crio uma checklist recorrente?", module: "tarefas" },
  ] },
  { prefix: "/formacao", items: [
    { text: "Como faço a minha formação obrigatória?" },
    { text: "Como subo de nível (exames de carreira)?" },
  ] },
  { prefix: "/despesas", items: [
    { text: "Como registo uma despesa com a fatura?" },
    { text: "Como marco uma despesa como paga?" },
  ] },
  { prefix: "/faturacao", items: [
    { text: "O que é o \"fecho previsto\"?" },
    { text: "Qual foi o valor das reservas este mês?", module: "financeiro" },
  ] },
  { prefix: "/financeiro", items: [
    { text: "Qual foi o valor das reservas este mês?", module: "financeiro" },
  ] },
  { prefix: "/marketing", items: [
    { text: "O que significa o aviso vermelho do Google Ads?" },
    { text: "Onde vejo o ROAS por campanha?" },
  ] },
  { prefix: "/permissoes", items: [
    { text: "Como dou acesso a um módulo a uma pessoa?" },
    { text: "Porque é que alguém vê \"Acesso não autorizado\"?" },
  ] },
  { prefix: "/definicoes", items: [
    { text: "Como desligo uma funcionalidade de IA?" },
    { text: "Onde mudo o IVA?" },
  ] },
  { prefix: "/operacoes", items: [
    { text: "Quantos check-ins há hoje?", module: "reservas_operacoes" },
    { text: "Quantas reservas foram criadas ontem?", module: "reservas_operacoes" },
  ] },
];

const GENERAL: AssistantSuggestion[] = [
  { text: "Quantos check-ins e check-outs há hoje?", module: "reservas_operacoes" },
  { text: "Que tarefas tenho por fazer?", module: "tarefas" },
  { text: "Como pico o ponto?" },
  { text: "O que consegues fazer?" },
];

type UserLike = Parameters<typeof can>[0];

/** Até `max` perguntas para a página atual (as da página primeiro). PURA. */
export function assistantSuggestions(path: string | null | undefined, user: UserLike, max = 4): string[] {
  const p = (path ?? "/").split("?")[0];
  const page = BY_PATH.find((x) => p === x.prefix || p.startsWith(`${x.prefix}/`))?.items ?? [];
  const out: string[] = [];
  for (const s of [...page, ...GENERAL]) {
    if (out.length >= max) break;
    if (s.module && !can(user, s.module, "view")) continue;
    if (!out.includes(s.text)) out.push(s.text);
  }
  return out;
}

/** Limite por omissão da pergunta (o servidor manda o valor em vigor). */
export const ASSISTANT_DEFAULT_MAX_INPUT = 1000;
