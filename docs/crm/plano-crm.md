# Plano — CRM Multipark (ficha do cliente 360°)

27 set 2026. Complementa `docs/multipark-db/plano-duas-bd.md` (o que fica em cada base de dados).
Para o Jorge, o Rafael e as sessões do Claude (nuvem e PC).

## 1. Objetivo (palavras do Jorge)

Um CRM **potente e agradável de usar**, onde:

- quando entra uma reserva, toca o telefone, chega um email ou um WhatsApp, **já se sabe quem é**;
- cada cliente tem **foto**, **vários carros** (com foto), **vários emails e telefones**;
- o CRM **avisa quando parece a mesma pessoa** ("outro email, mas o mesmo carro, nome e telefone — juntar?"),
  deixa **juntar** e, se foi engano, **separar**;
- há **pesquisas e filtros** fortes, gráficos e *insights* (inspiração: Odoo e HubSpot);
- os clientes são **nossos** mesmo nos parques que não são nossos: somos nós que falamos com eles
  (emails, avisos de chegada, upsell de serviços, avaliações).

## 2. Onde vive cada coisa

| O quê | Onde | Porquê |
|---|---|---|
| Reserva "viva", movimentos, parques, preços, caixas fechadas, ocorrências | **BD Multipark** (Postgres, só o `be-multipark` escreve; nós só lemos) | É a operação e a fonte de verdade |
| Clientes (CRM), emails/telefones/carros, fotos, consentimentos, notas, segmentos | **BD nossa** (MySQL, "Jorge's App") | É nosso, também para parques de terceiros |
| Cópia financeira de cada reserva + conferência de caixa | **BD nossa** | Para conferir as caixas que o back office recebe |
| Catálogo de parques e serviços extra (cópia diária) + marca nosso/terceiro | **BD nossa** | Para os avisos e o upsell |
| Emails, WhatsApp, chamadas, reclamações, avaliações | **BD nossa** (já existe) | Linha do tempo do cliente |

**Pedido ao Rafael:** vistas estáveis para a dashboard na BD Multipark (`dash_bookings`, `dash_movements`,
`dash_clients`, `dash_parks`, `dash_cash_closings`…). Assim, quando ele muda as tabelas dele, só atualiza a
vista e a dashboard não parte. Mais um utilizador **só de leitura** e os índices `History(actionTime)`,
`History(bookingId)`.

## 3. Modelo de dados (BD nossa)

```
crm_customers            1 pessoa (id, nome, foto, língua, tipo particular/empresa/pro, estado, notas, criado/atualizado)
crm_customer_emails      N por cliente (email normalizado, principal?, verificado?, origem)       UNIQUE(email)
crm_customer_phones      N por cliente (telefone E.164, principal?, WhatsApp?, origem)            UNIQUE(phone)
crm_vehicles             N por cliente (matrícula normalizada, marca, modelo, cor, tipo, foto, km/autonomia último conhecido)
crm_customer_links       ligação às fichas da BD Multipark (Client.id) e às nossas reservas     UNIQUE(source, externalId)
crm_consents             RGPD: marketing email/WhatsApp/SMS, data e origem do consentimento
crm_tags / crm_customer_tags   etiquetas livres + segmentos automáticos (novo, recorrente, VIP, em risco, pro…)
crm_merge_suggestions    pares suspeitos (clienteA, clienteB, pontuação, motivos, estado: pendente/aceite/rejeitada)
crm_merge_events         cada junção com a "fotografia" de antes (JSON) → permite SEPARAR
```

Fotos (cliente e carros) no armazenamento que já usamos (S3), com a ligação na tabela.

**A chave não é o nome.** A identidade assenta em email, telefone e matrícula normalizados. A BD da Multipark
tem 46 418 fichas para 35 727 emails: cada ficha deles liga-se a **um** cliente nosso (`crm_customer_links`),
e várias fichas podem apontar para o mesmo cliente.

## 4. Duplicados: sugerir, juntar, separar

**Pontuação** entre dois clientes (exemplo, a afinar com dados reais):

| Sinal | Pontos |
|---|---|
| Mesmo telefone (E.164) | +50 |
| Mesma matrícula | +40 |
| Mesmo email | junção automática (é a mesma chave) |
| Nome muito parecido (sem acentos, ordem das palavras, distância pequena) | +20 |
| Mesmo NIF | +50 |
| Apelido igual + mesma cidade de estadias | +10 |

- **≥ 90** → sugestão "forte" no topo; **60–89** → sugestão normal; **< 60** → não sugere.
- Nunca junta sozinho (exceto o mesmo email). Junta quem tem permissão (backoffice+), com um clique.
- **Juntar** = move emails, telefones, carros, ligações e histórico para o cliente que fica; grava em
  `crm_merge_events` o estado anterior completo.
- **Separar** = repõe a partir desse registo (e o que entrou depois da junção fica no cliente principal, com aviso).
- Rejeitar uma sugestão fica guardado, para não voltar a aparecer.

## 5. Identificação instantânea ("já sei quem é")

Um só serviço `identifyCustomer({ phone?, email?, plate?, name? })`, com índices nas tabelas acima, usado em:

- **reserva nova** (webhook): liga ou cria o cliente;
- **chamada** (WhatsApp/telefone): mostra a ficha antes de atender;
- **email** recebido (Comunicação): cartão do cliente ao lado da conversa;
- **WhatsApp**: idem na caixa de entrada;
- **pesquisa global** (Ctrl+K): por nome, email, telefone ou matrícula.

## 6. A ficha do cliente

- Cabeçalho: foto, nome, segmento, contactos principais, carros (com foto), língua, pro/avença, parceiro de origem.
- **Linha do tempo** única: reservas (lidas da BD Multipark), movimentos, pagamentos, emails, WhatsApp,
  chamadas, reclamações, perdidos, avaliações, notas.
- Números: n.º de reservas e estadias, total gasto, média, frequência, última e próxima vinda, parques/cidades,
  taxa de cancelamento, no-shows.
- Ações: enviar email/WhatsApp, criar tarefa, nota, reclamação, juntar/separar, editar contactos e carros.

## 7. Pesquisa, filtros e insights (inspiração Odoo/HubSpot)

- **Filtros combináveis e guardáveis**: cidade, parque, nosso/terceiro, segmento, n.º de estadias, gasto,
  última vinda, parceiro, canal de origem, língua, consentimento, tem reserva futura, carro elétrico…
- **Vistas**: lista, cartões (kanban por segmento) e mapa de calor por mês.
- **Insights**: clientes novos vs. recorrentes por mês, retenção (voltam em 6/12 meses?), valor médio por
  cliente, clientes em risco, parceiros que trazem os melhores clientes, serviços extra mais vendidos.
- **Listas** a partir de um filtro para campanhas (respeitando o consentimento).

## 8. Comunicação a partir do CRM

Com o catálogo de parques e serviços (B3 do plano das duas BD):
- aviso antes da chegada ("está a chegar, quer uma lavagem / carregamento?");
- confirmação e pós-venda, pedido de avaliação;
- sempre pelos nossos canais (Gmail com o alias da marca, WhatsApp), com o registo na linha do tempo.

## 9. Ordem proposta

1. **Tabelas do CRM + carregamento inicial** (BD Multipark `Client`, `BookingVehicle`, `Vehicle` + as nossas
   reservas), fichas juntas por email; migração da página `/clientes` atual (hoje é um agregado de
   `multipark_bookings`) para as tabelas novas, com a mesma aparência.
2. **Duplicados** (sugestões + juntar + separar).
3. **Identificação instantânea** nos pontos da secção 5.
4. **Ficha 360°** com a linha do tempo.
5. **Filtros guardáveis e insights.**
6. **Cópia financeira + conferência de caixa** (plano das duas BD, B2).
7. **Catálogo de serviços + avisos/upsell.**

## 10. Infraestrutura (a decidir)

- Hoje a dashboard corre na **Vercel em `iad1` (EUA)** e as bases de dados no **Railway na Holanda**:
  cada consulta atravessa o Atlântico (~90 ms). Curto prazo: região da Vercel `fra1`. Médio prazo: avaliar
  passar a dashboard para o **Railway** (rede privada com as BD, sem limite de 60 s por pedido).
- Nota: o plano **Hobby da Vercel é só para uso não comercial**; se ficarmos na Vercel, passar a Pro.

## Perguntas em aberto

1. Quem pode juntar/separar clientes? (proposta: backoffice, admin, super admin)
2. Fotos dos clientes: só as que o cliente carrega no registo, ou também tiradas no check-in?
3. Empresas (clientes pro/avença): uma ficha de empresa com várias pessoas?
4. Consentimentos: o que já existe do lado da Multipark para importar?
