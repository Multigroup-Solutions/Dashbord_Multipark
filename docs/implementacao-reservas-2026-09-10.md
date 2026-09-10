# Reservas e operações — primeiro bloco de implementação

## Resultado da recuperação em produção

Em 10/09/2026 foram validadas e configuradas as chaves existentes do Top Parking Porto e do Boardingpark Faro. O primeiro parque estava ausente da configuração; o segundo estava excluído e tinha uma chave inválida.

- Marketplace, reservas criadas de 01 a 10/09: a base da dashboard passou de **33 para 44 reservas**, recuperando as 11 reservas identificadas na auditoria.
- Recuperação dos dois parques: 38 ocorrências nos relatórios de criação/recolha/entrega/cancelamento; 17 reservas novas; 21 atualizações; 19 detalhes atualizados; zero erros.
- Repetição do mesmo período: zero reservas novas, 38 atualizações e zero erros. As ocorrências repetidas nos vários relatórios não criam novas reservas.
- Janela de 11/09 a 10/10: nove ocorrências atualizadas e zero erros.
- Criado o projeto Top Parking Porto dentro de Multipark → Porto → Marketplace e associadas as reservas ao projeto. Não confundir com o Top-Parking de Lisboa, que continua excluído.

## Alterações de código

- Notificações guardadas numa fila durável antes da confirmação HTTP. Falhas ficam para nova tentativa; uma interrupção deixa o trabalho recuperável após expirar a reserva de processamento.
- Removida a deduplicação antiga que confundia receção com processamento concluído.
- Os eventos usam o detalhe atual da API; o estado/preço/matrícula de um evento antigo não são aplicados diretamente.
- Atualização forçada para notificações e rotação periódica dos detalhes, mesmo quando o estado da reserva não muda. Falhas deixam de marcar `enrichedAt` como sucesso.
- Datas da API interpretadas explicitamente em UTC; corrigida a dependência do fuso horário do servidor.
- Identificação do parque por código ou nome/cidade, evitando escolher um parque homónimo noutra cidade.
- Ciclo de cinco minutos para notificações e detalhes, separado da importação geral. O agendamento pode sofrer atrasos do GitHub Actions.
- Cobertura e pendências visíveis no separador de sincronização. “Chave configurada” não equivale a “acesso validado”.
- Limpar o filtro global limpa o filtro local, preservando a escolha local entre abas quando o filtro global não mudou.
- Contador de atualizações corrigido; uma janela futura com erro não avança o seu marcador; importações parciais deixam de ser tratadas como último sucesso global.
- Recuperações limitadas a parques têm um tipo de registo próprio e não avançam a referência da importação global.

## Validação

- 43 testes passaram em seis ficheiros: HTTP autenticado, persistência antes do ACK, falha/reenvio, processamento incompleto, perda de exclusividade, datas/fusos, identificação de parques, contagens e repetição da janela futura.
- Verificação TypeScript e compilação da aplicação e da API concluídas.
- Migração 0068 aplicada: tabela de trabalhos e campos de repetição/versão do detalhe. Não elimina dados anteriores.
- Credenciais mantidas fora do repositório; duas variáveis de produção configuradas como sensíveis.

## Trabalho que continua pendente

Este bloco não conclui a auditoria inteira nem os outros seis módulos.

1. Conciliação por identificador de todas as recolhas, entregas e cancelamentos, incluindo datas reais versus previstas e limites de dias em Lisboa.
2. Progresso persistente por parque/ação para a importação geral e recuperação de todo o histórico anterior a setembro.
3. Paginação, filtros e exportação sem corte silencioso a 5000 registos; separar origem original de campanha/parceiro.
4. Sincronização dos serviços sem perder identificadores/conclusões e com filtros comuns às operações.
5. Histórico das reservas: retirar também a marcação de sucesso em tentativas falhadas e completar o seguimento dos movimentos.
6. Formação: corrigir avaliações e permissões, depois percursos, conteúdos, atribuições e tutor de IA.
7. Restantes fases de Despesas, Faturação, Parcerias, Google Ads e RH conforme os planos e o relatório de estado.

## Recuperação operacional

O utilitário `scripts/recover-booking-coverage.ts` consulta a origem por defeito; só escreve com `--apply`. Indicar datas, lista de parques e ficheiro de ambiente local protegido. Exemplo sem credenciais no comando:

```powershell
pnpm exec tsx scripts/recover-booking-coverage.ts --from 2026-09-01 --to 2026-09-10 --parks 'PORTO_TOP_PARKING,FARO_BOARDINGPARK' --env .env.production.local --apply
```

O ficheiro de ambiente e os registos locais de execução estão excluídos do Git. A publicação e a verificação final são registadas no relatório de acompanhamento do projeto.

## Verificação após publicação

- Primeiro bloco publicado pela PR #32, revisão `893ffcab3854a649f78f89d99dd5c00823bcd031`.
- Uma reserva real desatualizada foi colocada duas vezes na fila: criou apenas um trabalho, concluído numa tentativa pelo GitHub Actions. A matrícula ficou igual à origem.
- O primeiro ciclo atualizou 59 de 60 detalhes; a API devolveu 404 para uma reserva antiga do Airpark Lisboa. A falha fica registada e recuperável, sem apagar a reserva nem marcar o detalhe como atualizado.
- A PR #33 preserva a origem Marketplace quando existe campanha/parceiro. A hipótese inicial de esta sobreposição explicar a diferença de uma reserva não se confirmou: a conferência por identificador mostrou que a reserva em falta no ecrã estava cancelada.
- O ecrã de sincronização passa também a apresentar as falhas de atualização dos detalhes, além das notificações pendentes. Os códigos distinguem HTTP 404 de erros de base de dados sem expor informação privada.

## Conferência das criações, incluindo canceladas

- A consulta de Reservas excluía silenciosamente todas as canceladas. Passa a devolver todas as criações do período, com filtro explícito Todas / Não canceladas / Canceladas.
- O resumo conta todas as reservas visíveis, mas separa o valor cancelado e exclui-o dos valores financeiros das não canceladas. A lista e o CSV mantêm o estado de cada reserva.
- Verificação direta do detalhe das 44 reservas Marketplace criadas entre 01 e 10/09: todos os preços coincidem entre a API e a base de dados, total de 2201,55 €. Inclui uma cancelada de 29,80 €; as 43 não canceladas somam 2171,75 €. A fotografia anterior de 2192,70 € não corresponde aos valores atuais da origem.
- Dois estados estavam desatualizados nesta conferência. A fila corrigiu ambos para CHECKED_IN numa tentativa por reserva. A segunda execução registou também falhas em reservas antigas: a base apresenta oito detalhes pendentes, sete com código HTTP 404 explícito e um com código antigo genérico cujo 404 já foi confirmado diretamente.
- O primeiro horário automático da nova rotina ainda não foi observado: as execuções de validação foram iniciadas manualmente no GitHub Actions. O horário configurado não é uma garantia de execução a cada cinco minutos.
- Cada notificação autenticada e persistida passa também a iniciar a recuperação em segundo plano no Vercel, sem esperar pela origem antes do HTTP 202. O agendamento mantém-se para falhas e detalhe periódico. Foi usado o mecanismo oficial [waitUntil](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil), limitado pela duração da função; os trabalhos interrompidos continuam recuperáveis pela fila.
- Validação final deste complemento: 50 testes passaram em oito ficheiros; TypeScript, compilação da aplicação e da API concluídos. Inclui criações/cancelamentos, separação dos valores e falha no arranque do processamento após receção durável.
