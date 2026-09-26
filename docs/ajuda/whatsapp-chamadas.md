---
modulo: whatsapp_chamadas
titulo: WhatsApp — Chamadas de voz
rotas: /whatsapp
palavras: chamada, chamadas, ligar, telefonar, atender, recusar, desligar, chamada perdida, devolver chamada, por devolver, autorização para ligar, microfone, toque, calling api, voz
---
# WhatsApp — Chamadas de voz

Os clientes podem **ligar para o número de WhatsApp da empresa** e a chamada é atendida **no dashboard, no browser** (microfone e colunas/auscultadores do computador). Também é possível **devolver a chamada** a partir da conversa.

## Atender

1. Quando um cliente liga, aparece um aviso **"Chamada WhatsApp"** com toque, em qualquer página, a quem tem o WhatsApp com permissão de **editar** na cidade da conversa (o super admin vê todas as cidades).
2. **Atender** — o primeiro a carregar fica com a chamada; os outros veem "atendida por …". Na primeira vez o browser pede autorização para usar o **microfone**: aceita.
3. Durante a chamada: nome do cliente, reserva ligada (se houver), cronómetro, **Silenciar** e **Desligar**. Podes mudar de página sem cair a chamada (não feches nem recarregues o separador).
4. **Recusar** termina a chamada do lado do cliente. **✕** só deixa de tocar no teu computador.
5. Uma chamada do cliente abre (ou renova) a janela de 24 h, como uma mensagem: depois podes escrever-lhe texto livre.
6. Se ninguém atender em cerca de 1 minuto, a chamada fica **perdida**: aparece na conversa e em **Chamadas perdidas por devolver** (faixa vermelha no topo da lista de conversas), e a equipa da cidade recebe a notificação **"Chamada WhatsApp perdida"**.

## Ligar / devolver uma chamada

1. Abre a conversa e carrega em **Ligar**.
2. A Meta só deixa a empresa ligar a quem **autorizou chamadas**. Se o cliente ainda não autorizou: **Pedir autorização para ligar** — o cliente recebe no WhatsApp um pedido com botão para aceitar. A janela mostra **"À espera de autorização"** e atualiza sozinha quando ele responder.
   - Com a janela de 24 h fechada, o pedido só pode ir num **template aprovado** (ver configuração abaixo).
   - A autorização vale **7 dias** (ou fica permanente, se o cliente escolher).
3. Com autorização: **Ligar agora**. O painel mostra "A chamar…", "A tocar no cliente…" e depois o cronómetro.
4. Uma chamada devolvida com sucesso tira o cliente da lista **por devolver**. Também podes marcar à mão (**Devolvida**).

**Limites da Meta** (o dashboard avisa):
- pedidos de autorização: 1 por 24 h e 2 por 7 dias, por cliente;
- até 100 chamadas ligadas por cliente em 24 h;
- 2 chamadas seguidas sem resposta → o cliente recebe um aviso; à 4.ª a Meta **retira a autorização**.

Na conversa, cada chamada aparece como uma linha: "Chamada recebida 14:32 · 3 min · atendida por Ana", "Chamada perdida 14:32", "Chamada efetuada 15:00 · não atendida".

## Configuração (dono / super admin)

Pré-requisitos da Meta:
- número na **WhatsApp Cloud API** (não na app WhatsApp Business) e app com a permissão `whatsapp_business_messaging`;
- **limite de mensagens de pelo menos 2000** destinatários únicos por dia (tier da conta);
- chamadas feitas pela empresa não existem para números de cliente dos EUA, Canadá, Egito, Vietname e Nigéria (Portugal é suportado).

Passos:
1. **Meta for Developers → a tua app → WhatsApp → Configuração → Webhooks**: no campo `whatsapp_business_account` subscrever **`calls`** (além de `messages`). O URL do webhook é o mesmo (`/api/whatsapp/webhook`).
2. **Ativar as chamadas no número**: no dashboard, WhatsApp → faixa **Chamadas perdidas por devolver** (ou `/whatsapp?chamadas=1`) → **Configuração das chamadas (Meta)** → ligar **Chamadas ativas**, **Pedir autorização ao cliente quando ele liga** e, se quiseres, o **horário** (fuso Europe/Lisbon). Em alternativa: WhatsApp Manager → Números de telefone → o número → **Chamadas**.
3. **Definições → Integrações → WhatsApp — Chamadas → Testar**: confirma se as chamadas estão ativas, o horário e se o campo `calls` está subscrito.
4. (Opcional) Para pedir autorização com a janela de 24 h fechada: criar no WhatsApp Manager um **template** com o botão "pedido de autorização de chamada" (componente `call_permission_request`), sem variáveis, e pôr o nome em `WHATSAPP_CALL_PERMISSION_TEMPLATE` (língua em `WHATSAPP_CALL_PERMISSION_TEMPLATE_LANG`, por omissão `pt_PT`).

**Preços (Meta)**: chamadas **recebidas são grátis**. Chamadas **feitas pela empresa** pagam por minuto (blocos de 6 s, só quando o cliente atende), com tarifa do país de destino e escalões de volume mensais. O pedido de autorização é uma mensagem cobrada como as outras.

## Problemas comuns

- **Não toca**: o separador tem de estar aberto (pode estar em segundo plano, com o som ligado). Confirma o Testar e que tens WhatsApp "editar" na cidade.
- **Atendo mas não há som**: autoriza o microfone no browser; redes muito fechadas (firewall que bloqueia UDP) podem impedir o áudio — o dashboard usa só STUN público (sem servidor TURN).
- **"O cliente não deu autorização"**: pede autorização primeiro; a temporária acaba ao fim de 7 dias.
