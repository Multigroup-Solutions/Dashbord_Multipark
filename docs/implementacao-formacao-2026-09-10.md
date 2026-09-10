# Formação — implementação por etapas

## Integridade, acesso e preservação de resultados

- O servidor rejeita perguntas repetidas e perguntas que não pertencem à avaliação; a nota usa as pontuações das perguntas do exame. Avaliações sem perguntas válidas não são aceites.
- Validação de pontuações positivas, nota mínima entre 1 e 100 e duração configurada entre 1 e 240 minutos.
- Consulta de resultados limitada ao próprio colaborador; supervisores podem consultar os seus centros e administradores mantêm o acesso de gestão. O filtro pedido pelo navegador não alarga este âmbito.
- A operação anterior de eliminar exame passa a arquivar. As perguntas e tentativas anteriores permanecem; exames arquivados não aparecem entre os disponíveis e os resultados conservam o título do exame.
- A interface passa a indicar Arquivar, com o mesmo perfil autorizado no servidor. Atualiza o ranking/tentativas após submeter, mostra erros de envio e impede cliques durante a submissão.
- Aprovar um exame deixa de prometer progressão automática na carreira. Uma falha do aviso ao responsável não transforma um resultado já guardado numa resposta de erro.
- Retirados os dois cálculos antigos de notas; a regra é comum e testada. Migração 0070 aditiva, apenas para arquivo de exames.

## Validação

19 testes passaram: integridade do cálculo, validação das rotas e âmbito por perfil. TypeScript e compilações da aplicação/API concluídos. Os testes usam dados fictícios e não submetem exames nem enviam avisos na aplicação real. A leitura de produção confirmou quatro exames, 40 perguntas de exame e quatro tentativas, além de 42 perguntas de quiz e duas tentativas; sem pontuações inválidas.

## Próximas etapas autorizadas

1. Tentativas criadas no servidor: perguntas fixadas, início/prazo e respostas persistentes, retoma e submissão única.
2. Fila recuperável de avisos; neste primeiro bloco uma falha de envio é apenas registada.
3. Percursos, módulos, atribuições, progresso e revisão dos conteúdos existentes.
4. Tutor de IA limitado aos conteúdos aprovados, prática e explicação; sem decidir progressão profissional.

Este documento não declara o plano de Formação concluído.
