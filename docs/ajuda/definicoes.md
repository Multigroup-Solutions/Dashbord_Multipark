---
modulo: definicoes
titulo: Definições
rotas: /definicoes
palavras: definições, definicoes, configuração, automações, interruptores, parâmetros, iva, tsu, sla, prazos, emails, integrações, segurança, sessões, api keys, inteligência artificial, ia, orçamento da ia, assistente, calendário, escala da cidade, passagem de turno, google calendar, serviços, tarefas dos serviços, lavagem, carregamento elétrico
---
# Definições

Só admin e acima. Separadores:

- **Estado**: saúde do sistema (tarefas automáticas/crons), o cartão **Agendador** (só o super admin: cada trabalho automático, última corrida, erro e próxima vez — ver a ajuda do Agendador) e o cartão **IA — custo do mês**. O antigo painel "Saúde dos dados Multipark" (sync pela API) saiu: o webhook tem a linha **Fila do webhook Multipark** no Estado do sistema e o cartão **Webhook Multipark** nas Integrações; a ligação à BD da Multipark tem o cartão **BD Multipark**.
- **Automações**: interruptores das automações, incluindo a **Inteligência artificial** (interruptor geral e um por funcionalidade, ex.: assistente, faturas, WhatsApp).
- **Integrações**: estado das ligações externas (o cartão "API Multipark" saiu com a sincronização pela API); atalho para Integrações.
- **Parâmetros**: no topo, o cartão **Serviços → tarefas** — por cidade (Lisboa, Porto, Faro) e por tipo de serviço extra (a lista vem do catálogo de serviços da Multipark, agrupada: Lavagem, Carregamento elétrico…), liga **Gera tarefa** e escolhe, se quiseres, um **responsável** da cidade; os team leaders do turno da saída e do turno anterior entram sempre (ver a ajuda das Tarefas). Carrega em **Guardar**. Depois, IVA e TSU com data de efeito, prazos (SLA) das ocorrências, destinatários de email, responsável das disponibilidades, orçamento mensal da IA, limites do assistente e, em **Operação (GPS / Zello / parques)**, as **Contas Zello excluídas do GPS** (um utilizador Zello por linha: consolas de despacho, contas de teste; vazio = recolhe todos — ser "admin" no Zello já não exclui ninguém) e os **Parques que a operação não faz** (lista de parques lida ao vivo da BD da Multipark; os escolhidos deixam de aparecer em Reservas do dia, na previsão e nos blocos dos Extras do dia e no estado ao vivo da Pressão / Passagem de turno — ex.: Porto). Cada alteração fica no **Histórico de alterações** e aplica-se em até 30 s.
- **Comunicação** (só o super admin edita): caixas de email, **Calendários partilhados da escala** — incluindo os **eventos automáticos dos TL/supervisores** no Google Calendar ("Escala da cidade" diária para 30 dias e "Passagem de turno" das 15h), **desligados por omissão**; os turnos de cada pessoa vão sempre para o calendário dela —, Contactos Google e Google Drive.
- **Segurança**: validade das API keys e **Terminar sessões** (as tuas ou de todas as contas).
