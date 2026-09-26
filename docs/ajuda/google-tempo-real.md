---
modulo: definicoes
titulo: Google em tempo real (Calendário, Drive, Tarefas e Contactos)
rotas: /definicoes, /perfil
palavras: google, tempo real, sincronização, sincronizar, calendário, google calendar, drive, tarefas, google tasks, contactos, notificações da google, push, webhook, canal, canais, renovar, 4 horas, rede de segurança, heartbeat, online, sincronizar agora, atrasado, não aparece
---
# Google em tempo real

Desde 26 set 2026 a app já não pergunta à Google de 15 em 15 minutos se mudou alguma coisa. Sincroniza **quando alguma coisa muda**:

## O que muda no dashboard vai logo para o Google

Criar, editar ou concluir uma tarefa, mudar a escala (turno criado, alterado, apagado ou escala confirmada), atribuir uma formação, mudar o responsável ou o SLA de uma reclamação e carregar uma prova numa reclamação (espelho no Shared Drive) — a app envia logo para o Google, em segundo plano (não atrasa o que estás a fazer). Se a Google falhar, a app volta a tentar sozinha (de 15 em 15 min, com esperas cada vez maiores).

## Calendário e Drive: em tempo real

- **Calendário "Multipark"** de cada pessoa e **calendários partilhados da escala** (um por cidade): quando alguém mexe num evento no Google Calendar, a Google avisa a app e ela sincroniza logo **só esse calendário**.
- **Drive — pastas da base de conhecimento** (Shared Drive "Multipark"): quando um ficheiro dessas pastas é criado, alterado ou apagado, a Google avisa a app e ela atualiza o índice (os documentos alterados são lidos outra vez). Ficheiros de outras pastas do Shared Drive são ignorados.

Os avisos da Google chegam a `https://dashboard.multipark.pt/api/google/push` e cada "canal" tem um segredo próprio — pedidos sem o segredo certo são recusados. Os canais duram até 7 dias; a app renova-os sozinha todos os dias (tarefa **Google: renovar canais de notificação**, às 03:40).

## Tarefas e Contactos: enquanto tens o dashboard aberto

O Google Tasks e os Contactos Google não avisam a app quando mudam. Por isso sincronizam **quando abres o dashboard** e **de 5 em 5 minutos enquanto o tens aberto** (com a aba visível). Quando fechas o dashboard ou mudas de aba, param. Várias abas abertas não fazem mais chamadas à Google (no máximo uma sincronização a cada 5 minutos por pessoa).

Exemplo: concluis uma tarefa no telemóvel, no Google Tasks — aparece concluída no dashboard na próxima vez que o abrires (ou em até 5 minutos, se já o tens aberto).

## Rede de segurança: de 4 em 4 horas

Mesmo sem avisos, a app faz uma sincronização completa de 4 em 4 horas (Tarefas, Calendário, Contactos, calendários partilhados, Drive e base de conhecimento). Assim, se algum aviso se perder, nada fica desatualizado mais do que 4 horas.

## Ver o estado

- **Perfil → Google Tarefas & Calendário**: a última sincronização, se o teu calendário está "em tempo real" (e o último aviso da Google) e a última sincronização das Tarefas/Contactos enquanto tinhas o dashboard aberto. **Sincronizar agora** continua a funcionar.
- **Definições → Comunicação → Google em tempo real** (admins): cada canal (calendários partilhados, Drive da base de conhecimento e o total dos calendários pessoais) com o estado **Ativo**, **A expirar (renova hoje)** ou **Expirado**, a data em que expira e o último aviso; as alterações por enviar/receber. O super admin tem **Renovar agora**.
- **Definições → Estado → Agendador** (super admin): as tarefas **Google: alterações por enviar/receber (repetição)**, **Google Tarefas, Calendário, Contactos e Drive (rede de segurança)** e **Google: renovar canais de notificação**.

## Configuração

Não é preciso configurar nada na Google Cloud: os avisos usam as APIs do Calendário e do Drive que já estão ligadas. O endereço vem da variável `APP_URL` do Vercel, que tem de ser `https://dashboard.multipark.pt` (os endereços de pré-visualização do Vercel não recebem avisos). Para desligar os avisos (fica só a sincronização de 4 em 4 horas e a das Tarefas/Contactos com o dashboard aberto), define `GOOGLE_PUSH_DISABLED=1` no Vercel.
