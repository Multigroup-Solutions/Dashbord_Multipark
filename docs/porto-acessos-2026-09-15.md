# Acessos por centro de custos

O centro de custos determina a cidade disponível. Um colaborador de um centro dentro do Porto recebe os projetos dessa cidade; o centro de grupo Multipark recebe as três cidades. O papel de administrador e as antigas permissões adicionais de cidade deixam de alargar esse âmbito.

Sem ficha, sem centro válido ou com vínculos incompatíveis, o acesso às operações é recusado. O perfil continua acessível e apresenta: «Sem centro de custos atribuído. O acesso às cidades fica indisponível até à atribuição.» Não se altera o estado de ativação da conta nem se inventa um centro de custos.

Os seletores são bloqueados quando existe uma única cidade. A lista de projetos é limitada no servidor. Pedidos com filtros de projeto/cidade fora do âmbito são recusados. Reservas, estatísticas de reservas, resumo de operações, snapshots e lista de RH recebem o filtro do centro quando o cliente o omite.

Validação: 33 testes passaram, incluindo chamadas às rotas sem centro, com administrador de uma cidade, com filtros estrangeiros e sem filtros. TypeScript e compilações da aplicação e API passaram. Os testes usam dados fictícios, sem mensagens nem alterações a pessoas reais.

A importação da lista do Porto foi feita separadamente, com verificação na base de dados: 28 pessoas, 24 extras, três supervisores e um chefe de turno; quatro fichas reutilizadas e 24 criadas. Foram confirmadas 26 ligações por email e identificador na API Multipark. Duas ligações a agentes aguardam confirmação. Os dados pessoais e a cópia anterior à alteração ficam fora do repositório público.

Limite: esta alteração não constitui uma auditoria completa de todas as rotas de detalhe e todos os agregados dos restantes módulos. A revisão de autorização por recurso deve continuar nesses módulos, para além dos filtros aqui corrigidos.
