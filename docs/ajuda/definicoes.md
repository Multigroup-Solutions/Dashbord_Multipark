---
modulo: definicoes
titulo: Definições
rotas: /definicoes
palavras: definições, definicoes, configuração, automações, interruptores, parâmetros, iva, tsu, sla, prazos, emails, integrações, segurança, sessões, api keys, inteligência artificial, ia, orçamento da ia, assistente, calendário, escala da cidade, passagem de turno, google calendar, serviços, tarefas dos serviços, lavagem, carregamento elétrico, estado desconhecido, saltado, último ok, parado, alguém mudou isto entretanto, histórico de alterações, remetente, juntar fichas, telefones dos alertas, sem pda
---
# Definições

**Quem entra**: administradores e super admin (pela matriz de permissões, com as exceções por pessoa). Algumas coisas são só do **super admin**: o remetente dos emails de sistema, "CRM: juntar sozinho as fichas óbvias", notificações, calendários/contactos/Drive Google, Web & SEO, Google Business, API keys e terminar as sessões de todos. Os admins veem-nas mas não as mudam (aparece "só o super admin muda").

Separadores (um link com `?tab=estado`, `?tab=automacoes`… abre o separador certo, mesmo com a página já aberta):

- **Estado**: saúde das tarefas automáticas (crons), o cartão **Agendador** (só o super admin) e **IA — custo do mês**.
  - Se a leitura falhar aparece **Estado desconhecido** com "Tentar de novo" — nunca "Tudo a correr" sem dados.
  - **Parado** = sem corridas há mais de 2× o intervalo esperado. O mail-sync é medido pela cadência em vigor (5 em 5 min sem o push do Gmail, 1×/dia com ele). Um cron parado há mais de 30 dias continua a aparecer como Parado (a última corrida de cada um nunca se apaga).
  - **Saltado** (Agendador) = correu mas não fez o trabalho (ex.: interruptor desligado, sem configuração). Não conta como **Último OK**.
  - Os erros mostrados nunca levam segredos (tokens, passwords em endereços).
- **Automações**: interruptores de cada automação, incluindo a **Inteligência artificial**. Cada um diz o estado **agora** e de onde vem: *definido aqui*, *pela variável do servidor* ou *por omissão*. "Seguir o servidor" tira o que foi definido aqui.
- **Integrações**: resumo; o estado, os testes e a gestão de cada ligação vivem na página **Integrações**.
- **Comunicação**: caixas de email, **Envio de email (Gmail)** — o remetente só o super admin muda (os admins podem testá-lo) —, calendários partilhados da escala, Google em tempo real, Contactos Google e Google Drive. Um cartão que não consegue ler mostra o erro e "Tentar de novo" (antes desaparecia).
- **Parâmetros**:
  - **Serviços → tarefas** no topo: por cidade e tipo de serviço extra, **Gera tarefa** e um responsável opcional. Se as regras gravadas não carregarem, não se pode gravar (antes apareciam as regras por omissão e gravar apagava as verdadeiras).
  - IVA e TSU com data de efeito, prazos (SLA), destinatários de email, disponibilidades, IA, contas Zello excluídas do GPS, parques que a operação não faz.
  - **Alertas sem PDA/Zello**: os telefones por cidade e a **cópia** (todas as cidades), um número por linha.
  - Um valor gravado que já não é válido fica assinalado (a aplicação usa a omissão até se gravar de novo).
- **Notificações**: quem recebe cada aviso (só o super admin muda).
- **Segurança**: validade das API keys (até ao fim do dia escolhido, hora de Lisboa) e **Terminar sessões**.

**Duas pessoas a mudar ao mesmo tempo**: se outra pessoa gravou a mesma definição ou interruptor depois de abrires a página, aparece "Alguém mudou isto entretanto" e nada é gravado; os valores atualizam-se e voltas a gravar.

**Histórico de alterações** (fim de Parâmetros): quem mudou, quando, antes → depois; filtra-se por definição ou interruptor. Também fica nos Logs, com o nome da definição.
