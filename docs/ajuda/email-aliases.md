---
modulo: comunicacao
titulo: Email por alias (encaminhamento, Por classificar e envio)
rotas: /definicoes, /comunicacao
palavras: alias, aliases, encaminhamento, tabela de aliases, domínios, multibacks, marca, destino, pipeline, responsável, equipa, etiqueta, por classificar, bcc, triagem, atribuir caixa, reencaminhamentos, smtp, imap, gmail api, remetente, emails de sistema, push, mail_push, pub/sub
---
# Email por alias (encaminhamento, Por classificar e envio)

Todo o email passa pela **API do Gmail** — não há SMTP nem IMAP. Há duas caixas reais (**reservas@multipark.pt** e **info@multipark.pt**) e cada uma recebe muitos endereços (aliases) de todas as marcas e domínios. O dashboard separa cada email pelo alias a que foi enviado.

**Como o alias é lido**
- Por esta ordem: **Delivered-To → X-Original-To → To → Cc** (nos enviados, o From). Ganha o primeiro endereço que está na tabela.
- O Delivered-To igual à própria caixa (reservas@ / info@) é ignorado — no Google Workspace é sempre o endereço principal; o alias vem no To/Cc.

**Preencher a tabela** (Definições → Comunicação → **Encaminhamento por alias**; admin e super admin)
1. **+ Alias** e escreve o endereço completo (qualquer domínio: reservas@skypark.pt, info@multibacks.app…).
2. **Caixa**: onde a conversa aparece (quem a vê é a regra da caixa).
3. **Marca** e **Cidade** (a conversa fica dessa cidade: quem só vê a sua cidade só a vê se for a dela; os avisos vão para essa cidade).
4. **Destino**: *Como a caixa*, *Geral*/*Reservas* (só conversa) ou um pipeline (Reclamações, Perdidos, Críticas, RH, Campanhas, Ocorrências) — cria o registo no módulo.
5. **Responsável**: uma pessoa (a conversa fica-lhe atribuída e recebe aviso) ou uma equipa (papel: quem o tem e vê a caixa é avisado).
6. **Etiqueta** (aparece na conversa) e **Ativo**. **Guardar**.
Um endereço só pode estar numa caixa. Um alias inativo deixa de encaminhar.

**Por classificar** (Comunicação → caixa **Por classificar**, só admin e super admin)
- Emails que chegaram por um endereço fora da tabela (ex.: em **Bcc**, ou um alias novo por configurar). Automáticos (notificações de reserva, emails do próprio dashboard) nunca vão para aqui.
- Abre a conversa → **Atribuir à caixa** (opcional: um alias da tabela, e **Acrescentar este endereço à tabela** para os próximos já chegarem classificados). Se o destino criar registos, são criados nesse momento.

**Envio**
- Emails de sistema (notificações, briefing, escala, tarefas, formação, relatórios) saem da conta em **Envio de email (Gmail)** (Definições → Comunicação; **Testar** envia-te um email). Ficam marcados como automáticos — nunca aparecem como conversas de clientes.
- Emails a clientes (reclamações, perdidos, recrutamento) saem pelo alias da caixa, se estiver em "Enviar email como" na conta de origem.

**Avisos**: Integrações → Gmail e Definições → Comunicação mostram os destinos sem alias e as caixas cuja conta Gmail não está ligada — esses emails **não** criam registos.

**Checklist do dono (depois do deploy)**
1. Google Admin → Utilizadores: pôr todos os aliases/domínios como endereços alternativos de **reservas@** ou **info@** (e domínios alternativos multipark.app, multibacks.pt/.app…); **apagar os reencaminhamentos** antigos. Adicionar cada alias usado para responder em "Enviar email como" da caixa.
2. Definições → Comunicação: em cada caixa, **Conta a ler** = reservas@multipark.pt ou info@multipark.pt (a caixa real que recebe os aliases dela); preencher a tabela de aliases; escolher o remetente em **Envio de email (Gmail)** e carregar em **Testar**; ver os avisos (a delegação da conta de serviço tem de ter gmail.modify e gmail.send para as duas caixas e para o remetente).
3. Vercel → Environment Variables: apagar **SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_SINCE_DAYS** (já não são lidas).
4. Definições → Automações: ligar **MAIL_PUSH** (se ainda não). Com push a chegar, a sincronização agendada passa a de hora a hora; sem push volta aos 5 min.
