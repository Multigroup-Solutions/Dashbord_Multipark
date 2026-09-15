# Cidades autorizadas e ficha do colaborador

## Comportamento implementado

| Área | Resultado |
| --- | --- |
| Atividade diária e avaliação operacional | Consultas e indicadores limitados às cidades autorizadas; a seleção de cidade também restringe os dados no servidor. |
| Despesas | Listagens, totais, vencimentos, recorrências e operações por identificador respeitam a cidade. |
| Marketing | Campanhas, custos, receitas e métricas Google Ads respeitam os projetos autorizados. |
| Parcerias | Parceiros e reservas filtrados pela operação da cidade; transações com centro de custos validado. |
| Avaliação individual | Mantida a consulta conjunta. |
| Ficha de colaborador | Conta e tipo de utilizador, acesso direto à gestão da conta, permissões, avisos de acessos adicionais e disponibilidade semanal. |

O centro de custos continua a ser obrigatório. A ausência de centro não é ultrapassada por cargo administrativo nem por permissões adicionais. As permissões de cidade já guardadas (`city.extra.*` e `city.all`) passam a ser consideradas na autorização efetiva. Esta alteração não atribui centros nem modifica permissões guardadas.

As operações que recebem apenas um identificador verificam a cidade do registo existente antes de o ler ou alterar. As restrições aplicam-se antes das agregações, incluindo quando o cliente não envia filtro de cidade.

Na ficha, os avisos identificam permissões adicionais, elevação efetiva a chefe de turno e perfil administrativo. São sinais para revisão, não uma conclusão automática de que a autorização está errada. A disponibilidade distingue uma semana não submetida, um dia não indicado e um dia marcado como indisponível.

## Limitação de faturação das parcerias

As faturas existentes e determinadas avenças são globais e não têm cidade associada. Na consulta por cidade, os respetivos totais e saldos aparecem como **Indisponível**; não são apresentados como zero nem como valores dessa cidade. A consulta e alteração de informação global exigem acesso global. A distribuição contabilística desses valores por cidade exige atribuição explícita na origem.

## Validação

- 109 testes aprovados em 11 ficheiros: autorização por cidade, isolamento entre pedidos, consultas sem filtro, acesso por identificador, despesas, disponibilidade, RH, formação e Google Ads.
- TypeScript sem erros; compilação da aplicação e da API concluídas.
- Ficha verificada no navegador com dados fictícios: ligação à conta, avisos, permissões, horários e navegação para uma semana sem disponibilidade.
- Sem migrações, alterações de dados ou testes contra a base de produção nesta execução.
- A compilação mantém o aviso de tamanho de alguns blocos JavaScript.

## Entrega

Alteração preparada na branch `codex/cidades-ficha-colaborador-2026-09-15`, baseada em `092c9637e57f231f6ce08eae6ced36c14760767a`. Não integrada em `main` nem publicada em produção nesta execução.
