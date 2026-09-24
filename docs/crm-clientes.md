# CRM de clientes — versão para revisão

Data: 24 de setembro de 2026. Branch: `feat/crm-clientes`.

## O que está disponível

A página **Suporte → Clientes** (`/clientes`) reúne as reservas sincronizadas por email. A ficha mostra reservas concluídas, futuras e canceladas, valor das estadias, valor médio, frequência, primeira/última visita, próxima reserva, contactos e viaturas observados. Inclui um gráfico mensal e as interações já associadas por email em reclamações, perdidos e achados e críticas.

Há pesquisa por nome, email, telefone ou matrícula, paginação e filtros de recorrência, primeira estadia, inatividade e identidade a validar. O período do CRM filtra a última visita; as métricas mantêm todo o histórico autorizado. O gráfico mostra o mês atual e os 11 anteriores. As reservas e o cartão de histórico existente têm atalhos para o CRM.

O aspeto segue o design existente da dashboard: cores e tipografia do tema global, cartões claros, azul Multipark e os componentes partilhados `Card`, `Button`, `Input`, `Select` e `Tabs`. O CSS específico limita-se à composição da lista/ficha e aos elementos do histórico; não redefine o tema das outras páginas.

O CRM consulta as reservas existentes: acompanha os dados da sincronização Multipark nas novas consultas, ao regressar à janela ou ao atualizar. Não introduz uma segunda importação nem uma cópia de reservas para manter manualmente. Não substitui nem corrige o processo de sincronização da origem.

## Como experimentar

- `/crm-preview` ou `/crm-preview.html`: demonstração autónoma, sem autenticação nem chamadas à API, com dados explicitamente fictícios. Inclui simulação de carregamento e erro.
- `/clientes`: versão integrada, com autenticação e permissões da dashboard.
- Localmente: iniciar Vite e abrir `/crm-preview.html`. A aplicação integrada requer o servidor e a configuração habitual do projeto.

Sugestão de revisão: pesquisar um contacto, abrir a ficha, alternar os separadores, abrir uma reserva, experimentar recorrentes/inativos/identidades a validar e reduzir a janela ao tamanho de um telemóvel.

## Regras dos dados

| Tema | Comportamento |
|---|---|
| Identidade | Email sem espaços exteriores, em minúsculas; preserva pontos e sufixos `+`. A comparação é sensível a acentos. |
| Vários nomes | Mostra «Contacto com vários nomes» e pede validação. Não apresenta esse contacto no indicador de clientes recorrentes. |
| Email inválido/em falta | Reserva continua intacta; é contabilizada como não identificada. Não se cria um cliente comum para todas as reservas sem email. |
| Histórico | Agrupamento calculado apenas em leitura; não funde, edita ou elimina clientes/reservas na origem. |
| Estadias | Concluídas quando o estado normalizado é `CHECKED_OUT`. Cancelamentos e reservas futuras têm contagens separadas. |
| Datas | Visitas calculadas a partir da entrada registada na reserva; não representam uma auditoria dos eventos reais de entrada/saída. |
| Dinheiro | Soma de `totalPrice` das estadias concluídas. Não equivale a recebimentos líquidos, não reconcilia reembolsos e não desconta comissões. |
| Lacunas/moedas | Total e média ficam indisponíveis se faltam valores/moeda ou existem várias moedas. Ordenação financeira compara apenas EUR. |
| Pesquisa | Encontrar uma matrícula/telefone não reduz as métricas às reservas que contêm esse termo. |
| Interações | Associação exata pelo email, dentro do âmbito autorizado; 50 mais recentes, com aviso quando há mais. Links abrem o módulo de origem. |

## Permissões e implementação

- A API exige pelo menos `frontoffice`; valores exigem pelo menos `backoffice` e a ausência de negação de `finance.view_totals`.
- O servidor aplica a cidade/projeto autorizado **antes** de agrupar, contar ou consultar detalhes. A seleção global restringe também este âmbito.
- Sem contexto de acesso, a consulta é recusada. Uma chave existente apenas noutra cidade devolve `NOT_FOUND`.
- Dinheiro é removido da resposta, incluindo reservas e séries mensais, quando não há permissão; não fica apenas escondido no ecrã.
- Os erros de base de dados expõem uma mensagem genérica; o registo técnico contém apenas o código, sem email nem parâmetros SQL.
- Não há novas migrações, tabelas, escritas de clientes, envios de mensagens ou tarefas agendadas.

Ficheiros principais: `server/crm.ts`, `shared/crm.ts`, `client/src/pages/ClientsPage.tsx` e `client/src/components/crm/`. As consultas são `clients.crmList` e `clients.crmDetail`.

## Validação realizada

- 50 testes de CRM, rotas e isolamento por cidade passaram.
- Comparação com reservas reais numa transação explicitamente `READ ONLY`: contagens e valores de uma ficha comparados com consulta independente; âmbito vazio recusado e valores financeiros removidos sem permissão. Não é uma reconciliação integral de todos os clientes.
- Navegador, computador e telemóvel: pesquisa, segmentos, separadores, reserva, recuperação de erro e navegação lista/ficha. Sem erros de execução nem pedidos à API na demonstração; sem transbordo horizontal no ecrã de 390 px.
- TypeScript e compilação da interface/API passaram. A compilação mantém o aviso de tamanho de alguns pacotes da aplicação; não é um erro de compilação.

## Limites desta primeira versão

O email identifica um **contacto**, não prova que todas as reservas pertencem à mesma pessoa. Emails partilhados por agências/famílias ficam assinalados quando há nomes diferentes. Emails diferentes da mesma pessoa ainda produzem fichas diferentes; nomes iguais num email partilhado não permitem detetar a ambiguidade automaticamente.

Ainda não existem identidades persistentes com aliases, união/separação manual auditável, notas internas, caixa de correio integrada ou campanhas. Antes de acrescentar essas escritas, é necessário definir o identificador canónico do cliente na origem e a política de correção de associações, preservando o histórico.

A primeira versão agrega as reservas por consulta. Para volumes maiores, medir o desempenho e depois considerar uma projeção materializada com atualização incremental; não introduzir essa complexidade sem medir a necessidade.

Esta entrega destina-se a revisão na branch. A integração em `main` e a publicação em produção ficam para uma decisão posterior.
