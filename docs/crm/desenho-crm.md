# CRM de clientes — proposta de desenho (rascunho, 27 set 2026)

Proposta para discutir antes de construir. Os filtros, os gráficos e os insights ficam para depois de vermos o Odoo juntos.
Enquadramento: `docs/multipark-db/plano-duas-bd.md` (secção B1). A ficha do cliente vive na **nossa BD**.
Os dados de origem vêm da BD da Multipark (`Client`, `BookingVehicle`, `Vehicle`, `ProClient`) e das nossas reservas.

## O que o Jorge pediu

- CRM potente e agradável, para trabalhar com tudo junto. Quando chega uma reserva, toca o telefone, sai um email ou entra um WhatsApp, **já se sabe quem é**.
- Ficha tão ou mais completa que a do funcionário. Leva a foto do cliente, porque o cliente também se vai registar, e **vários carros**, cada um com foto.
- **Vários emails e telefones** para a mesma pessoa.
- **Nunca juntar só pelo nome.** O CRM avisa ("este email é novo, mas o carro, o nome e o telefone são os mesmos, quer juntar?"),
  junta quando alguém confirma e **permite separar** depois, porque há erros.
- Muitas pesquisas e filtros.

## Modelo de dados (nossa BD)

| Tabela | Para quê | Campos principais |
|---|---|---|
| `crm_clients` | A ficha | nome, foto, email e telefone principais, NIF, nome e morada fiscal, morada, IBAN (cifrado), língua, data de nascimento (opcional), pro e desconto, parceiro ou agência de origem, consentimentos (email, WhatsApp, SMS), etiquetas, notas, origem da ficha, métricas em cache (reservas, gasto, primeira e última vinda, parque preferido), segmento |
| `crm_client_emails` | Vários emails | email normalizado (**único**: um email pertence a um só cliente), principal sim/não, verificado, de onde veio, visto pela primeira e última vez |
| `crm_client_phones` | Vários telefones | telefone em formato internacional (único), principal, tem WhatsApp |
| `crm_client_vehicles` | Vários carros | matrícula normalizada, marca, modelo, cor, tipo, **foto**, último km conhecido, visto pela primeira e última vez. A mesma matrícula pode estar em mais de um cliente (família, empresa), mas não se repete no mesmo cliente |
| `crm_client_external_ids` | Ligação às outras bases | sistema (ficha Multipark, Odoo, contacto Google…) + id externo. Liga as 46 418 fichas da Multipark às nossas |
| `crm_merge_suggestions` | "Quer juntar?" | cliente A, cliente B, pontuação, motivos (mesma matrícula, mesmo telefone, mesmo NIF, nome parecido), estado (pendente, aceite, recusada), quem decidiu e quando |
| `crm_merge_events` | Juntar e **separar** | cliente que fica, cliente absorvido, **retrato dos identificadores movidos** (emails, telefones, carros, ids externos, reservas), quem, quando, motivo, `undoneAt`. Separar = repor esse retrato |
| `crm_interactions` | Linha do tempo | canal (reserva, chamada, email, WhatsApp, nota, avaliação), sentido, referência (id da reserva, da conversa…), data, resumo |

As fotos ficam no armazenamento que já usamos (S3). Na BD fica só o link.

## Regras de identidade

1. **Liga automaticamente** (sem perguntar) só com um identificador forte e exato:
   - o mesmo email normalizado;
   - o mesmo id de cliente da Multipark.
2. **Sugere juntar** quando dois clientes partilham:
   - o telefone;
   - o NIF;
   - a matrícula e um nome parecido;
   - o nome e mais um sinal (cidade, carro).

   Cada motivo soma pontos e a sugestão mostra os motivos.
3. **Nunca** junta só pelo nome.
4. **Emails genéricos** (por exemplo, o do balcão com milhares de reservas e muitos nomes) ficam marcados e **não** servem para ligar pessoas.
5. Juntar e separar ficam sempre registados, com quem e quando. Separar repõe exatamente o que estava antes.

## Reconhecer o cliente em cada canal

Um só serviço "quem é?" recebe um email, um telefone ou uma matrícula e devolve o cartão do cliente
(foto, nome, carros, última reserva, próximas reservas, gasto, avisos). Usa-se em quatro sítios:

- **Reserva nova** (webhook/API): liga ou cria a ficha e mostra o cartão.
- **Telefone:** mostra o cartão quando toca, se tivermos o número de quem liga. Depende da central telefónica, por confirmar.
- **Email** (a nossa caixa Gmail já integrada): cartão ao lado da conversa.
- **WhatsApp** (conversas já guardadas por telefone): cartão ao lado da conversa.

## Carga inicial

1. Fichas da Multipark: nome, email, telefone, NIF, nome fiscal, carros guardados, pro.
2. Carros de cada reserva deles (`BookingVehicle`: matrícula, marca, modelo, cor).
3. As nossas reservas antigas (antes de março de 2026 a BD deles não tem clientes) e os contactos Google já no CRM.
4. Junção automática por email, seguida das sugestões para rever (telefone, NIF, matrícula).

## Por decidir

- O que o Odoo nos dá de ideias para filtros, vistas, gráficos e insights.
- A central telefónica: conseguimos saber o número de quem liga?
- IBAN: quem pode ver e editar (proposta: só o backoffice financeiro, e cifrado).
- Registo do cliente: quando o cliente criar conta (lado Multipark), a foto e os carros vêm de lá ou são carregados cá?
