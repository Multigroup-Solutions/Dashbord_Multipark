# Cidade de um colaborador — derivação (Lisboa / Porto / Faro)

## Summary
Como se sabe a que cidade pertence um colaborador quando **`employees` NÃO tem
coluna de cidade**. Documenta o módulo `server/employeeCity.ts` + o vocabulário
partilhado `shared/city.ts`, a ordem das três fontes de dados reais usadas, e o
primeiro consumidor: o filtro de cidade na tabela "Disponibilidade dos extras"
(`ExtrasDiaPage`). Nasceu de um pedido do Jorge em 2026-08-04 ("filtrar os extras
por Faro / Porto / Lisboa").

## Related
- `whatsapp-integration.md` — a tabela filtrada é o alvo do broadcast WhatsApp; o
  filtro tinha de compor-se com a Decisão 1 ("a todos" = conjunto visível).
- `identity-by-email.md` — define o conteúdo da tabela de extras (todos os ativos
  + quem respondeu sem ser extra) e a Decisão 1 que este filtro respeita.

## O terreno (verificado no schema, 2026-08-04)
- **`employees` não tem `city`.** Tem `address` (text livre), `projectId` (int) e
  `department` (varchar) — nada estruturado sobre cidade.
- **`projects` TEM** `level ENUM('group','brand','city','project')` + `parentId`.
  O seed real (`seedHierarchy`, db.ts ~1350) cria
  `Multipark (group) → Lisboa/Porto/Faro (city) → marca → parque`. É a hierarquia
  canónica da app e já era usada assim pelo Extras-Dia (`getLisbonProjectIds`).
- **`driver_applications.city`** (varchar 128) — cidade que a pessoa escreveu na
  candidatura do site multidriver, ligada por `employeeId`.
- **DECISÃO: não se criou coluna nem migração.** A cidade é DERIVADA do que já
  existe. Uma coluna `employees.city` (migração 0048) só se justifica se a
  cobertura das três fontes se revelar má em produção — ver "Se a cobertura for
  fraca".

## Ordem das fontes (mais fiável primeiro)
1. `employees.projectId` → sobe a árvore de `projects` até um nó `level='city'`
   → `source: "project"`.
2. `driver_applications.city` (texto livre da candidatura) → `source: "application"`.
3. `employees.address` (procura o nome da cidade na morada) → `source: "address"`.
4. Nada bate → `city: null`, `source: null` → aparece como **"Sem cidade"** na UI,
   que é um estado filtrável e honesto. **Nunca se adivinha.**

## Módulos
- **`shared/city.ts`** (cliente + servidor): `CITY_KEYS`, `CityKey`, `CITY_LABELS`,
  `CitySource`, `CITY_SOURCE_LABELS`, `matchCityKey`.
  - `matchCityKey` é **conservador e ancorado em fronteiras de palavra**:
    `/\blisb\w*/` (Lisboa/Lisbon), `/\b(porto|oporto)\b/`, `/\bfaro\b/`, sobre o
    texto sem acentos. **"Portimão" NÃO pode virar "Porto"** — é o teste que
    protege a regra. "Vila Nova de Gaia" fica sem cidade em vez de ser adivinhada.
- **`server/employeeCity.ts`**: `resolveCityFromProjects(byId, projectId)` (PURA,
  protegida contra ciclos, com recurso ao nome do próprio projeto quando a árvore
  não tem nó de cidade), `resolveEmployeeCities(people)` e
  `resolveCitiesForEmployeeIds(ids)` (usada pelo overview — precisa da `address`,
  que a lista de extras não carrega). Máximo 3 queries por chamada, nunca por linha.

## Consumidor: filtro na página "Disponibilidade dos extras"
- `getWeekOverview` devolve `city` + `citySource` por extra (`OverviewExtra`).
- UI: linha de botões `Todas | Lisboa | Porto | Faro | Sem cidade`, **cada um com
  a contagem**, + coluna "Cidade" na tabela (tooltip diz de que fonte veio).
- **Composição de filtros**: cidade → depois "Mostrar só quem marcou
  disponibilidade". O conjunto resultante (`shownExtras`) é o que a tabela mostra
  E o alvo de "a todos" (email e WhatsApp) — invariante "o que envio é o que vejo".
- Mudar o filtro **limpa a seleção** (nunca enviar a quem já não se vê).
- Contagens do cabeçalho e a linha de totais "Disponíveis" passaram a ser
  calculadas sobre o conjunto VISÍVEL (as do servidor contam o universo todo e
  mentiriam com um filtro aplicado).

## Se a cobertura for fraca (o que verificar em produção)
Não houve BD acessível ao implementar (não existe `.env` no repo), por isso a
cobertura real das 3 fontes **não foi medida**. Na página, o botão "Sem cidade"
mostra logo quantos ficaram por resolver:
- Muitos "sem cidade" **com projeto atribuído** → a árvore de `projects` dessa
  instalação não tem nós `level='city'`; corrigir a hierarquia é melhor que
  código.
- Muitos "sem cidade" **sem projeto atribuído** → ou se passa a atribuir
  `projectId` às fichas (preferível, alimenta tudo o resto), ou se cria mesmo a
  coluna `employees.city` numa migração NOVA (0048, SQL à mão, journal congelado
  no 24 — ver a regra em `whatsapp-integration.md`).

## Changelog

### 2026-08-04 — Filtro de cidade nos extras (sem schema novo)
**Type**: feature
**Scope**: `shared/city.ts` (novo), `server/employeeCity.ts` (novo),
`server/employeeCity.test.ts` (novo), `server/extrasAvailability.ts`,
`client/src/pages/ExtrasDiaPage.tsx`
**What**:
- Derivação da cidade por 3 fontes (projeto → candidatura → morada), com a parte
  pura testada (10 testes: variantes de nome, Portimão≠Porto, árvore
  parque→marca→cidade, parque direto na cidade, órfão, ciclo).
- `OverviewExtra` ganhou `city` + `citySource`; uma resolução por lista, não por linha.
- Filtro na UI + coluna Cidade + contagens por cidade; compõe com o filtro de
  disponibilidade e respeita a Decisão 1 do broadcast.
- **"Email a todos" passou a mandar a lista explícita do conjunto visível** (antes
  mandava `employeeIds: null` = TODOS os extras ativos no servidor). Sem isto, um
  filtro de cidade aplicado enviaria email a gente que não estava na tabela.
**Why**: o Jorge precisa de contactar só os extras de uma cidade; não havia como
distinguir. `employees` não tem cidade e inventar uma coluna vazia não resolvia.
**Notes**:
- **Sem migração** (ver "Se a cobertura for fraca" para quando isso muda).
- `tsc` limpo; 10 testes novos verdes; suite total 264 passa / 7 falhas
  pré-existentes de ambiente.
- Sem commits git (por instrução).
