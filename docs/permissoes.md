# Permissões — modelo de acessos v2

> Ficheiro gerado a partir de `shared/access.ts` (`pnpm tsx scripts/gen-permissoes-doc.ts`).
> Não editar à mão: alterar a matriz no código e regenerar. Um teste garante que está em dia.

## Princípios

- **Uma só fonte de verdade.** A matriz de `shared/access.ts` decide o menu (`DashboardLayout.tsx`) e o servidor (`requireAccess` em `server/_core/access.ts`). O que não está no menu também é recusado pela API.
- **Hierarquia.** Utilizador < Extra < Condutor < Team Leader < Supervisor < Frontoffice = Backoffice < Admin < Super Admin. Cada papel tem tudo o que os papéis abaixo têm, salvo indicação em contrário.
- **Alcance.** `próprio` = só o que é da pessoa (a sua ficha, as suas despesas, os casos em que é o condutor envolvido); `equipa (cidade)` = na sua cidade, o que é dele ou de quem está abaixo dele; `cidade` = tudo na sua cidade (centro de custos da ficha + cidades dadas por permissão); `nacional` = todas as cidades.
- **Ações.** V = ver · E = criar/alterar no dia a dia · X = exportar (Excel/PDF) · G = gerir (configuração, apagar, aprovar).
- **Cidade.** Supervisor, Team Leader, Condutor, Extra e Utilizador ficam limitados à sua cidade pelo servidor (`cityScope`); Frontoffice, Backoffice, Admin e Super Admin são nacionais.

## Papéis

| Papel | Resumo |
| --- | --- |
| Utilizador (`user`) | A própria ficha (documentos e dados pessoais), Formação e Disponibilidade. |
| Extra (`extra`) | Utilizador + a própria Avaliação, Serviços pendentes, o próprio Histórico diário, PDAs (registar o seu), Tarefas e as próprias ocorrências/reclamações/críticas. |
| Condutor (`condutor`) | Extra + as próprias Despesas, Reservas & Operações e Extras-dia da cidade (ver), os próprios Perdidos e Achados. |
| Team Leader (`team_leader`) | Condutor + Despesas dele e da equipa, Parcerias, RH da equipa, Leads de extras, Formação (gestão da equipa), Avaliação da equipa, Serviços/Actividade diária/Tarefas da cidade, preencher Extras-dia, Passagem de turno (sem o Resumo do dia), Disponibilidade dos extras, WhatsApp, Clientes e o Suporte da cidade. |
| Supervisor (`supervisor`) | Team Leader + Utilizadores da cidade (sem tocar em admins), Permissões (não de admins), Sincronização e Integrações — tudo na sua cidade. |
| Frontoffice (`frontoffice`) | Backoffice sem Permissões. |
| Backoffice (`backoffice`) | Supervisor com alcance nacional. |
| Admin (`admin`) | Backoffice + Permissões de quem está abaixo dele, Financeiro (sem Faturação) e Dashboards. Sem Marketing, Logs nem Faturação. |
| Super Admin (`super_admin`) | Tudo (inclui Marketing, Logs, Faturação, API Keys e manutenção). |

## Matriz

| Módulo | Utilizador | Extra | Condutor | Team Leader | Supervisor | Frontoffice | Backoffice | Admin | Super Admin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Pessoal** |  |  |  |  |  |  |  |  |  |
| Minha ficha | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE |
| Disponibilidade (própria) | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE | próprio VE |
| **Pessoas** |  |  |  |  |  |  |  |  |  |
| Formação | próprio VE | próprio VE | próprio VE | equipa (cidade) VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| Avaliação Individual | — | próprio V | próprio V | equipa (cidade) V | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| Avaliação Operacional | — | — | — | — | cidade V | nacional V | nacional V | nacional VX | nacional VX |
| Recursos Humanos | — | — | — | equipa (cidade) VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| RH — ordenados e processamento | — | — | — | — | — | — | — | nacional VEXG | nacional VEXG |
| Leads de Extras | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| **Operações** |  |  |  |  |  |  |  |  |  |
| Serviços | — | cidade V | cidade V | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Histórico diário (GPS) | — | próprio V | próprio V | cidade V | cidade V | nacional V | nacional V | nacional VEG | nacional VEG |
| PDAs | — | próprio VE | próprio VE | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Tarefas | — | próprio VE | próprio VE | equipa (cidade) VE | cidade VEG | nacional VEG | nacional VEG | nacional VEG | nacional VEG |
| Reservas & Operações | — | — | cidade V | cidade V | cidade V | nacional V | nacional V | nacional VEXG | nacional VEXG |
| Actividade Diária | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Rádio | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Extras Dia | — | — | cidade V | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Passagem de Turno | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Passagem — Resumo do dia | — | — | — | — | cidade V | nacional V | nacional V | nacional V | nacional V |
| Disponibilidade dos extras | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| WhatsApp | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| **Suporte** |  |  |  |  |  |  |  |  |  |
| Clientes | — | — | — | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| Reclamações | — | próprio V | próprio V | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| Críticas Google | — | próprio V | próprio V | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| Ocorrências | — | próprio V | próprio V | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| Perdidos e Achados | — | — | próprio V | cidade VE | cidade VE | nacional VE | nacional VE | nacional VEXG | nacional VEXG |
| **Financeiro** |  |  |  |  |  |  |  |  |  |
| Despesas | — | — | próprio VE | equipa (cidade) VE | cidade VEX | nacional VEX | nacional VEX | nacional VEXG | nacional VEXG |
| Parcerias | — | — | — | cidade V | cidade V | nacional V | nacional V | nacional VEXG | nacional VEXG |
| Projetos | — | — | — | — | — | — | — | nacional VEG | nacional VEG |
| Marketing | — | — | — | — | — | — | — | — | nacional VEXG |
| Financeiro (totais e dashboards) | — | — | — | — | — | — | — | nacional VEXG | nacional VEXG |
| Anual | — | — | — | — | — | — | — | — | nacional VEXG |
| Faturação | — | — | — | — | — | — | — | — | nacional VEXG |
| **Dashboards** |  |  |  |  |  |  |  |  |  |
| Dashboards (sem Faturação) | — | — | — | — | — | — | — | nacional V | nacional V |
| **Sistema** |  |  |  |  |  |  |  |  |  |
| Utilizadores | — | — | — | — | cidade VEG | nacional VEG | nacional VEG | nacional VEG | nacional VEG |
| Permissões | — | — | — | — | cidade VEG | — | nacional VEG | nacional VEG | nacional VEG |
| Sincronização | — | — | — | — | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Integrações | — | — | — | — | cidade VE | nacional VE | nacional VE | nacional VEG | nacional VEG |
| Definições | — | — | — | — | — | — | — | nacional VEG | nacional VEG |
| Logs | — | — | — | — | — | — | — | — | nacional V |
| API Keys | — | — | — | — | — | — | — | — | nacional VEG |
| Manutenção (migrações, correções) | — | — | — | — | — | — | — | — | nacional VEG |

## Regras adicionais

- **Permissão "Pode ser Team Leader na escala"** (`extras_dia.team_leader`): só torna a pessoa elegível como TL na escala do Extras-Dia. Não dá nenhum acesso de team leader na aplicação — é o papel da conta que decide.
- **Papel Condutor**: novo (migração 0096). Nenhuma conta existente é convertida automaticamente; a passagem a condutor faz-se à mão em Utilizadores.
- **Utilizadores**: o supervisor gere as contas da sua cidade até supervisor; frontoffice/backoffice até backoffice; admin tudo abaixo de admin; super_admin tudo. Ninguém mexe em contas acima de si.
- **Permissões**: supervisor e backoffice dão/retiram permissões a qualquer conta que não seja admin/super_admin; admin a quem está abaixo dele; super_admin a todos. Frontoffice não tem Permissões. As cidades extra (`city.*`) só as dá quem é nacional e os totais financeiros só quem tem o Financeiro.
- **Totais financeiros** (`finance.view_totals`): por defeito só admin/super_admin (módulo Financeiro). Um deny retira-os; um grant abre-os a supervisor, frontoffice ou backoffice.
- **Marketing, Logs e Faturação**: só super_admin (correção do dono).
- **Despesas do Team Leader**: as dele e as registadas por contas abaixo dele (condutores, extras, utilizadores) na sua cidade.
- **RH do Team Leader**: fichas da sua cidade de quem está abaixo dele; fichas sem conta contam pelo posto (extra, condutor, condutor sénior).

## Acessos por pessoa (overrides)

A matriz acima é o **padrão do papel**. Em Sistema → Permissões → *Por pessoa* pode-se dar ou retirar a uma pessoa em concreto o acesso a **qualquer módulo** da matriz:

- **O override substitui o padrão do papel** nesse módulo (alcance e ações). *Sem acesso* retira o módulo; *Repor padrão* apaga o override e a pessoa volta ao que o papel dá.
- **Alcance**: próprio, equipa (cidade), cidade ou nacional. **Ações**: V, E, X, G (ver está sempre incluído).
- **Validade opcional**: último dia (hora de Lisboa, inclusivo) em que o override vale. Depois disso deixa de contar sozinho e a pessoa volta ao padrão do papel.
- **Onde se aplica**: no servidor (`requireAccess`), no menu e nos botões (`can()` no cliente, com os overrides que vêm do `auth.me`). As permissões da pessoa são lidas uma vez por pedido.
- **Cidade**: um override *nacional* a quem é de cidade abre todas as cidades nesse módulo; um override de *cidade* (ou mais estreito) a quem é nacional limita-o à cidade do seu centro de custos nesse módulo.
- **Auditoria**: cada override guarda quem o deu e quando; cada mudança fica nos Logs (`set_module_access`, antes → depois).
- **"Quem tem acesso"**: por módulo, lista quem tem acesso e se vem do papel ou de um override.

Regras para dar/retirar:

- **Ninguém dá mais do que tem**: o alcance tem de ser igual ou mais estreito e as ações só as que a própria pessoa tem nesse módulo. Mudar ou repor um override dado por alguém com mais acesso também não é possível.
- **Marketing, Logs, Faturação e API Keys**: só o super admin dá ou retira.
- **Supervisor**: só a contas da sua cidade e nunca a admins (nem a papéis nacionais). Admin: só a quem está abaixo dele. Super admin: a todos.
- **Ninguém altera os seus próprios acessos** (nem os overrides de módulo nem as permissões especiais).
- **Permissões especiais** (TL na escala, totais financeiros, cidades extra) continuam a existir ao lado, no separador *Permissões especiais*. Os totais financeiros acompanham também um override do módulo Financeiro.
