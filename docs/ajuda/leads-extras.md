---
modulo: leads_extras
titulo: Leads de Extras (leads, candidaturas do site e recrutamento)
rotas: /extras-leads
palavras: leads, lead, leads de extras, candidaturas, candidatura, candidaturas do site, be a driver, aprovar candidatura, rejeitar candidatura, recrutamento, recursos-humanos@, emails de recrutamento, seja motorista, convidar, funil, arquivar lead, arquivados, repor lead, reativar ficha, lembrete automático, stop
---
# Leads de Extras

Tudo o que é recrutar extras está junto, no menu **Leads de Extras**, em três separadores:

**Leads**
- Contactos que ainda não são extras (do site, de email ou criados à mão). Convida-os por WhatsApp com o template "Seja motorista" e acompanha quem responde.
- Seleciona vários na tabela para mudar o estado ou a cidade de uma vez, ou para enviar o WhatsApp em lote.
- O **Funil** mostra os leads das últimas 12 semanas, por origem e por cidade.
- A faixa **Atenção** mostra os novos sem contacto há mais de 24 h e os contactados sem resposta há mais de 3 dias. Há também um resumo diário no sino, por cidade.
- Com **Lembretes das leads de extras** ligado (Definições → Automações), os contactados sem resposta recebem 1 lembrete automático. Com **Resposta automática às leads** ligado (vem desligado), quem responde recebe o link da candidatura.
- Quem responde **STOP** (ou "parar") deixa de receber mensagens.
- **Converter** um lead cria (ou liga) a ficha de extra na cidade que escolheres:
  - se a pessoa já tem ficha ativa, o lead liga-se a ela;
  - se já teve ficha **desativada**, aparece o motivo da saída e só se reativa se confirmares;
  - quem saiu por **roubo** ou **despedimento** não se reativa a partir de um lead (fala com o RH);
  - uma ficha que foi **junta a outra** passa para a ficha que ficou;
  - uma ficha de outra cidade não se mexe daqui.
- **Arquivar** (o ícone da caixa) tira o lead da lista, do funil, dos envios e dos lembretes. Nada se apaga: no botão **Arquivados** vês os arquivados e podes **Repor**. Se a pessoa voltar a candidatar-se, o lead sai sozinho do arquivo.
- A lista mostra os 500 leads mais recentes; quando chega a isso aparece um aviso.

**Candidaturas do site** (formulário "Be a Driver")
- O número ao lado do separador é o das candidaturas novas.
- **Aprovar** pede a cidade (centro de custo) e cria ou liga a ficha de extra. Se a pessoa já teve ficha desativada, aparece o motivo e só se reativa com confirmação (a mesma regra do Converter). Duas pessoas a aprovar a mesma candidatura ao mesmo tempo já não criam duas fichas.
- **Rejeitar** fecha a candidatura e põe o lead da mesma pessoa em "Sem interesse".
- Uma candidatura aprovada já não muda de estado. Para tirar a pessoa, desativa a ficha no RH.
- A cidade escrita na candidatura também se reconhece pela terra (ex.: "Corroios" é Lisboa, "Gaia" é Porto, "Albufeira" é Faro). Só vês e mexes nas candidaturas das tuas cidades.
- O filtro em cima mostra Novas, Revistas, Aprovadas, Rejeitadas ou Todas.

**Recrutamento (email)**
- Os emails que chegam à **recursos-humanos@**: abre, lê os anexos, escreve notas (ficam registadas) e responde. A resposta sai sempre da recursos-humanos@.
- O **link de registo** (cria a conta do candidato) só aparece a quem gere utilizadores.
- **Sincronizar emails** vai buscar os novos já (só aparece a quem tem a permissão de sincronização). As candidaturas e os emails também entram nos Leads sozinhos, de hora a hora.

Se uma lista não carregar aparece um aviso a vermelho com **Tentar de novo** (não quer dizer que esteja vazia).

Antes as candidaturas estavam na **Disponibilidade** e o recrutamento no separador do **RH**; agora estão só aqui. Um link antigo para `/extras-leads?tab=candidaturas` ou `?tab=recrutamento` abre o separador certo.
