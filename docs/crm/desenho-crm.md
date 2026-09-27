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
| `crm_interactions` | Linha do tempo | canal (reserva, chamada, email, WhatsApp, nota, avaliação, **alteração de dados**, **fusão/separação**), sentido, referência (id da reserva, da conversa…), data, resumo, autor. Nas alterações de dados guarda o campo, o valor antigo e o novo |
| `crm_activities` | Tarefas sobre o cliente | tipo (ligar, email, WhatsApp, oferta…), prazo, responsável, estado (atrasada, hoje, futura, feita), nota, plano de origem |
| `crm_activity_plans` | Sequências de tarefas | nome (ex.: "cliente com reclamação"), passos com intervalo em dias e responsável fixo ou escolhido no início |
| `crm_saved_views` | Filtros guardados | nome, filtros, agrupamentos, vista (lista, kanban, gráfico, pivot, coorte), privado ou partilhado, por omissão sim/não |

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

## Ideias do Odoo 18 (documentação oficial)

O conector do Odoo (`multipark.thinkopen.solutions`) está em baixo, com erro 502. Estas ideias vêm da documentação oficial do Odoo 18.
**Diferença importante:** no Odoo, juntar contactos é **irreversível** (Contacts, CRM e Data Cleaning dizem-no).
O nosso CRM guarda o retrato de cada fusão e deixa separar, o que é uma vantagem sobre o Odoo.

### Pesquisa e filtros
- **Barra única com facetas.** Escreve-se "AA-12-BB" e o CRM propõe "procurar em Matrícula / Email / Telefone / NIF / Nome". Cada escolha vira um chip que se pode remover.
- **Filtros em grupos.** Dentro do mesmo grupo combinam com OU e entre grupos com E. Grupos: Segmento (novo, recorrente, VIP, em risco), Aeroporto (Lisboa, Porto, Faro), Canal de origem, Parceiro, Pro/particular, Língua.
- **Filtro personalizado com regras.** Por exemplo, "n.º de reservas ≥ 5 E última reserva há mais de 180 dias".
- **Agrupar por**, em vários níveis.
- **Filtros guardados** com nome, privados ou partilhados, e um por omissão.
- **Comparar períodos**: este período contra o anterior ou contra o mesmo período do ano passado.
- Documentação: https://www.odoo.com/documentation/18.0/applications/essentials/search.html

### Vistas (o filtro mantém-se ao trocar)
- **Lista** com colunas que se mostram ou escondem e cores por estado.
- **Kanban** por segmento, com a barra de atividades em atraso, de hoje e futuras.
- **Gráfico** de barras, linhas ou circular, com a medida à escolha.
- **Pivot** com exportação para Excel.
- **Coorte**: dos clientes que vieram pela primeira vez num mês, quantos voltaram N meses depois.
- **Mapa** da origem dos clientes.
- Documentação: https://www.odoo.com/documentation/18.0/applications/essentials/reporting.html

### Ficha do cliente
- **Botões com contadores** no topo, que abrem a lista respetiva: Reservas 23 · Gasto 1 840 € · Carros 2 · Reclamações 1 · Ocorrências · Mensagens.
- **Separador "Contactos e carros"**: emails, telefones e carros, cada um com tipo, "principal" e foto do carro.
- **Particular ou empresa.** Nas empresas, preencher os dados a partir do NIF.
- **Barra "% ficha completa"**: foto, NIF, carro, telefone, morada.
- Documentação: https://www.odoo.com/documentation/18.0/applications/essentials/contacts.html

### Linha do tempo (o "chatter" do Odoo)
- Tudo num só sítio: reservas, emails, WhatsApp, chamadas, notas internas com @menções, anexos e alterações de dados (valor antigo e novo).
- As fusões e separações também ficam lá.
- Documentação: https://www.odoo.com/documentation/18.0/applications/productivity/discuss/chatter.html

### Atividades
- Cores: vermelho em atraso, laranja hoje, verde futuro.
- "Feito e agendar a próxima".
- Um contador no topo da aplicação com as atividades em atraso, de hoje e futuras.
- **Planos**, por exemplo "cliente com reclamação": ligar ao fim de 1 dia, email ao fim de 3, oferta ao fim de 30.
- Documentação: https://www.odoo.com/documentation/18.0/applications/essentials/activities.html

### Duplicados (inspirado na app Data Cleaning)
- **Fila "Sugestões de fusão"** com a percentagem de semelhança e os motivos: mesma matrícula, telefone, NIF, nome parecido.
- Botões **Fundir** e **Descartar**. Uma sugestão descartada não volta a aparecer.
- A verificação corre todas as noites.
- Na ficha aparece um aviso "possível duplicado" com o motivo.
- Limpeza automática dos campos: telefone no formato internacional, maiúsculas, espaços.
- Ao fundir, o cliente absorvido é arquivado e não apagado, e fica um retrato do que foi movido. É isso que permite **separar**.
- Documentação: https://www.odoo.com/documentation/18.0/applications/productivity/data_cleaning.html

### Reconhecer o cliente (VoIP, WhatsApp e email no Odoo)
- **Janela ao tocar o telefone**: "Cliente X · 12 reservas · VIP · AA-12-BB · reserva ativa amanhã", com um botão para abrir a ficha. A chamada fica na linha do tempo.
- **WhatsApp** liga a conversa ao cliente pelo número de telefone.
- **Email**: cartão do cliente ao lado da conversa, com a opção de registar o email na linha do tempo.
- Documentação: https://www.odoo.com/documentation/18.0/applications/productivity/voip.html

### Insights
- **Pontuação "probabilidade de voltar" e "risco de perder o cliente"**, ao estilo do lead scoring preditivo do Odoo.
- A nossa segmentação por recência, frequência e valor já vai além do que o Odoo traz de origem.
- **Painel com filtros globais** (período, aeroporto, parque, canal) e clique até à lista de clientes.
- Documentação: https://www.odoo.com/documentation/18.0/applications/sales/crm/track_leads/lead_scoring.html

### Tornar o CRM agradável de usar
- **Desafios e medalhas para a equipa**: mais duplicados resolvidos, mais fichas completas.
- Uma pequena celebração ao fechar um objetivo.
- Documentação: https://www.odoo.com/documentation/18.0/applications/sales/crm/optimize/gamification.html

### Prioridade proposta
1. Barra de pesquisa com facetas e chips.
2. Filtros em grupos, agrupar por e filtros guardados.
3. Ficha com os botões de contadores e o separador de contactos e carros com fotos.
4. Fila de sugestões de fusão, com Fundir, Descartar e **Separar**.
5. Linha do tempo única.
6. Janela de reconhecimento na reserva, no WhatsApp e no email (o telefone depende da central).
7. Vistas de gráfico e pivot sobre o mesmo filtro, com comparação de períodos.
8. Atividades com cores e planos.
9. Coorte de retenção.
10. Pontuação de regresso e de risco. Desafios para a equipa.

## Por decidir

- A central telefónica: conseguimos saber o número de quem liga?
- IBAN: quem pode ver e editar (proposta: só o backoffice financeiro, e cifrado).
- Registo do cliente: quando o cliente criar conta (lado Multipark), a foto e os carros vêm de lá ou são carregados cá?
