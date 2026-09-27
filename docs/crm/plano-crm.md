# Plano — CRM Multipark (ficha do cliente 360°)

27 set 2026. Complementa `docs/multipark-db/plano-duas-bd.md` (o que fica em cada base de dados).
Para o Jorge, o Rafael e as sessões do Claude (nuvem e PC). Unifica o desenho da sessão do PC
(`docs/crm/desenho-pc-2026-09-27.md`, guardado tal e qual) com a proposta da sessão na nuvem.

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

## 3. Modelo de dados (BD nossa) — versão unificada

Junta o desenho da sessão do PC (`docs/crm/desenho-pc-2026-09-27.md`) com este plano. Onde divergiam, fica o
que está indicado na última coluna.

| Tabela | Para quê | Campos principais |
|---|---|---|
| `crm_clients` | A ficha | nome, **foto**, email e telefone principais, NIF, nome e morada fiscal, morada, IBAN (**cifrado**, só backoffice financeiro), língua, data de nascimento (opcional), tipo (particular / empresa / pro) e desconto, parceiro ou agência de origem, notas, origem da ficha, **métricas em cache** (reservas, estadias, gasto, primeira e última vinda, parque preferido), segmento |
| `crm_client_emails` | Vários emails | email normalizado (**único**), principal, verificado, origem, visto 1.ª/última vez, **genérico** (sim/não) |
| `crm_client_phones` | Vários telefones | telefone E.164 (único), principal, tem WhatsApp |
| `crm_client_vehicles` | Vários carros | matrícula normalizada, marca, modelo, cor, tipo, **foto**, último km/autonomia, visto 1.ª/última vez. A mesma matrícula **pode** estar em mais de um cliente (família, empresa) mas não se repete no mesmo cliente |
| `crm_client_external_ids` | Ligação às outras bases | sistema (ficha Multipark, Odoo, contacto Google…) + id externo (único por sistema) |
| `crm_consents` | RGPD | canal (email, WhatsApp, SMS), estado, data, origem e texto aceite — tabela própria (e não só campos na ficha) para guardar o histórico |
| `crm_tags` / `crm_client_tags` | Etiquetas | livres + segmentos automáticos (novo, recorrente, VIP, em risco, pro) |
| `crm_merge_suggestions` | "Quer juntar?" | cliente A, cliente B, pontuação, motivos, estado (pendente, aceite, recusada), quem decidiu e quando. Recusadas não voltam |
| `crm_merge_events` | Juntar e **separar** | cliente que fica, cliente absorvido, retrato dos identificadores movidos (emails, telefones, carros, ids externos, reservas), quem, quando, motivo, `undoneAt` |
| `crm_interactions` | Linha do tempo | canal (reserva, chamada, email, WhatsApp, nota, avaliação, reclamação), sentido, referência, data, resumo |
| `crm_saved_filters` | Filtros guardados | nome, filtros, agrupamentos, privado/partilhado, por omissão |

Fotos no armazenamento que já usamos (S3); na BD fica só o link.

## 4. Identidade: ligar, sugerir, juntar, separar

1. **Liga sozinho** só com um identificador forte e exato: o mesmo email normalizado (se não for genérico)
   ou o mesmo id de cliente da Multipark.
2. **Sugere juntar** por pontuação (a afinar com os dados reais):

   | Sinal | Pontos |
   |---|---|
   | Mesmo telefone (E.164) | +50 |
   | Mesmo NIF | +50 |
   | Mesma matrícula **e** nome parecido | +40 |
   | Nome muito parecido (sem acentos, ordem das palavras) **e** mais um sinal (cidade, carro) | +20 |

   ≥ 90 → sugestão forte; 60–89 → normal; < 60 → não sugere. A sugestão mostra os motivos.
3. **Nunca** junta só pelo nome.
4. **Emails genéricos** (o do balcão, de agências, com milhares de reservas e muitos nomes) ficam marcados e
   **não** servem para ligar pessoas. Detetados automaticamente (muitos nomes diferentes no mesmo email) e
   editáveis à mão.
5. Juntar e separar ficam registados (quem, quando, motivo). Separar repõe exatamente o retrato de antes; o
   que entrou depois da junção fica no cliente principal, com aviso.
6. Juntar: backoffice, admin e super admin (proposta).

**Nota:** no Odoo juntar contactos é irreversível; aqui não.

## 4b. Carga inicial

1. Fichas da Multipark (`Client`): nome, email, telefone, NIF, nome fiscal, carros guardados (`Vehicle`), pro (`ProClient`).
2. Carros de cada reserva deles (`BookingVehicle`).
3. As nossas reservas antigas (antes de março de 2026 a BD deles não tem clientes) e os contactos Google já no CRM.
4. Junção automática por email (não genérico); depois as sugestões para rever (telefone, NIF, matrícula).

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

## 7. Pesquisa, filtros e insights (inspiração Odoo 18 — ver também o desenho do PC)

- **Barra única com facetas**: escreve-se "AA-12-BB" e propõe "procurar em Matrícula / Email / Telefone / NIF / Nome"; cada escolha vira um chip.
- **Filtros em grupos** (OU dentro do grupo, E entre grupos), **filtro personalizado com regras**, **agrupar por** em vários níveis, **comparar períodos**.

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
2. Fotos: quando o cliente criar conta (lado Multipark), a foto e os carros vêm de lá ou são carregados cá? E fotos tiradas no check-in?
3. Empresas (clientes pro/avença): uma ficha de empresa com várias pessoas?
4. Consentimentos: o que já existe do lado da Multipark para importar?
5. Telefone: a central (Vodafone) consegue dar-nos o número de quem liga? (para o cartão ao tocar)
6. IBAN: quem pode ver e editar (proposta: só o backoffice financeiro, cifrado).
7. Odoo: que módulos estão instalados e como o contacto liga a vendas/faturas/pagamentos (a ver com o conector).
