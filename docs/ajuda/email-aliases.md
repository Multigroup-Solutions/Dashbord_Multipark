---
modulo: comunicacao
titulo: Email por alias (encaminhamento, Por classificar e envio)
rotas: /definicoes, /comunicacao
palavras: alias, aliases, encaminhamento, tabela de aliases, domínios, domínios alternativos, alias domains, workspace, multibags, multivalet, skypark, redpark, escala, driver, airparkfaro, multibacks, marca, destino, pipeline, responsável, equipa, etiqueta, por classificar, bcc, triagem, atribuir caixa, reencaminhamentos, smtp, imap, gmail api, remetente, emails de sistema, push, mail_push, pub/sub
---
# Email por alias (encaminhamento, Por classificar e envio)

Todo o email passa pela **API do Gmail** — não há SMTP nem IMAP. Há duas caixas reais (**reservas@multipark.pt** e **info@multipark.pt**) e cada uma recebe muitos endereços (aliases) de todas as marcas e domínios. O dashboard separa cada email pelo alias a que foi enviado.

**O Workspace real** (multipark.pt, set 2026)
- Duas contas partilhadas: **reservas@multipark.pt** (aliases reclamacoes@, perdidos@, criticas@, recursos-humanos@, escala@) e **info@multipark.pt** (aliases redpark@, airpark@, skypark@, airparkfaro@, driver@). admin@, odoo@ e bags@ não têm aliases e não entram no encaminhamento.
- **Domínios alternativos**: skypark.pt, redpark.pt, multibags.pt, multivalet.pt, multibags.app e multipark.app. Neles, **todos** os endereços de multipark.pt funcionam sozinhos — um email para reclamacoes@skypark.pt chega à conta dona de reclamacoes@multipark.pt sem configurar nada. O dashboard faz o mesmo: se o endereço não está na tabela mas o mesmo nome existe noutro domínio do Workspace, conta como esse alias (caixa, destino, responsável, cidade e etiqueta do alias); a **marca** vem do domínio para onde o email foi enviado (reclamacoes@skypark.pt → Skypark; multivalet.pt conta como Multipark). Um endereço escrito na tabela ganha sempre, e um alias posto **inativo** não volta a encaminhar por outro domínio. A lista está em Definições → Parâmetros → **Domínios alternativos do Google Workspace** (vazia = desligado).
- airpark.pt e multidriver.pt ainda **não** estão no Workspace — emails para esses domínios não chegam.

| Endereço | Conta a ler | Caixa | Marca | Destino | Responsável | Etiqueta |
|---|---|---|---|---|---|---|
| reservas@ | reservas@ | Reservas (geral) | Multipark | Reservas | backoffice | — |
| escala@ | reservas@ | Reservas (geral) | Multipark | Geral | supervisor | Escala |
| reclamacoes@ | reservas@ | Reclamações | Multipark | como a caixa (Reclamações) | backoffice | — |
| perdidos@ | reservas@ | Perdidos e Achados | Multipark | como a caixa (Perdidos) | backoffice | — |
| criticas@ | reservas@ | Críticas | Multipark | como a caixa (Críticas) | backoffice | — |
| recursos-humanos@ | reservas@ | Recursos Humanos | Multipark | como a caixa (RH) | admin | — |
| info@ | info@ | Info (geral) | Multipark | como a caixa | admin | — |
| redpark@ | info@ | Info (geral) | Redpark | Geral | — | Redpark |
| skypark@ | info@ | Info (geral) | Skypark | Geral | — | Skypark |
| airpark@ | info@ | Info (geral) | Airpark | Geral | — | Airpark |
| airparkfaro@ | info@ | Info (geral) | Airpark (cidade Faro) | Geral | — | Airpark Faro |
| driver@ | info@ | Info (geral) | Multidriver | Recursos Humanos | admin | Condutores |

Todos @multipark.pt (e, pelos domínios alternativos, também @skypark.pt, @redpark.pt…). Esta configuração foi aplicada **uma vez** pela migração 0210, só onde ainda estava a omissão — nada do que um administrador já tinha mudado foi sobreposto. As caixas Ocorrências, Campanhas e Comercial ficaram como estavam (esses endereços não existem no Workspace).

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

**O que falta do lado do dono**
1. Se quiser **airpark.pt**: Google Admin → Domínios → acrescentar airpark.pt como domínio alternativo (depois acrescenta-o também em Definições → Parâmetros → Domínios alternativos do Google Workspace).
2. Decidir o **bags@** (Multibags): hoje não tem caixa no dashboard.
3. Definições → Comunicação → caixa **Info (geral)**: confirmar que a **Conta a ler** é info@multipark.pt (a migração só a mudou se ainda estivesse em reservas@; se tinha sido mudada à mão, ficou como estava).
4. Vercel → Settings → Environment Variables: apagar as variáveis antigas `SMTP_*` e `IMAP_*` (já não são usadas desde que o email passou todo para o Gmail).
5. Definições → Automações: ligar **Gmail: notificações push (Pub/Sub)** (MAIL_PUSH), se ainda não estiver.
