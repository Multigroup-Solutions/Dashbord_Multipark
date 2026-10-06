---
modulo: passagem_turno
titulo: Passagem de turno
rotas: /passagem-turno
palavras: passagem de turno, passagem, fim de turno, checklist, caixa, fecho de caixa, cofre, bolsa, terminal, rolos mb, fardamento, fardas, pendentes, observações, recebi, resumo do dia, estado do parque, ao vivo, carros no parque, garagem, ocorrências, bloqueios, caixa por fechar, pendentes do turno anterior, por gravar, por confirmar, 24 horas
---
# Passagem de turno

Checklist de fim de turno dos team leaders e resumo do dia para a supervisão.

**Preencher** (Team Leader)
1. Menu **Operações → Passagem de Turno**. Escolhe a cidade e o turno (manhã/noite). O dia operacional vai das 03:00 às 03:00 do dia seguinte.
2. Preenche a caixa (caixa de check-out, fecho de caixa no cofre, valores das bolsas front/terminal, tickets/despesas pagos), o material (canetas, rolos MB, bateria), o fardamento e os **Pendentes para o turno seguinte**.
3. Escreve observações e carrega em **Guardar passagem de turno**. Grava logo. O resumo IA, o aviso e o email ao team leader do turno seguinte seguem dentro de momentos, e o histórico atualiza-se sozinho.
4. Quem entra confirma com **Recebi**. Nem quem criou a passagem nem quem a editou por último a podem confirmar.

**Pendentes que passam de turno**
- Os pendentes vêm da **última passagem** da cidade (até 3 dias para trás). Se o turno anterior não fez passagem, vêm da que houve antes, com o aviso de quantos turnos ficaram sem passagem.
- Enquanto os pendentes do turno anterior não estiverem na lista, o botão de gravar espera ("A juntar os pendentes do turno anterior…").
- Se não for possível lê-los, aparece um aviso a laranja com **Tentar de novo**. Só gravas sem eles se marcares **Gravar mesmo assim**; nesse caso continuam na passagem anterior.
- Um pendente herdado **resolve-se** (visto), não se apaga. Só podes remover as notas que escreveste neste turno.
- Linhas das observações começadas por "- " passam a pendentes. Se editares ou apagares a linha, o pendente acompanha.
- Quem resolveu e quando ficam com o nome da conta que grava.
- A lista leva até **60** pendentes; o contador mostra quantos tens. No limite ficam primeiro as notas e os herdados. Reclamações, perdidos e outros que não caibam continuam nas páginas deles.
- Num turno antigo (nem o atual nem o que acabou agora), a passagem nova herda só os pendentes da anterior: o "ao vivo" é de agora, não desse turno.

**Resumo automático** (no topo de **Preencher**)
- As recolhas e entregas do próximo turno (com voo e valor a pagar), as entregas pendentes, os carros p/ coberto e as ocorrências abertas vêm **ao vivo da BD da Multipark**. As compras online ainda por pagar também contam: vão ser recolhidas na mesma.
- A equipa mostra **(por confirmar)** em quem ainda está só proposto na escala.
- Se a BD da Multipark não responder, aparece um aviso a laranja e o resumo usa as cópias do dashboard. As ocorrências só existem na Multipark: ficam como **erro** (sem dados), nunca com números antigos. O resto da passagem funciona igual.
- Uma parte que não se consegue ler mostra **erro** em vez do número. Não é 0, e no email e no resumo IA aparece como "sem dados (falhou a leitura)".

**Estado do parque (ao vivo)**
Separador com o estado atual dos parques da cidade, lido diretamente da BD da Multipark (só leitura). Não entram os **Parques que a operação não faz** das Definições; o mesmo vale para o resumo da passagem.
- **Carros no parque** por parque e garagem (com lugar, hora de saída e voo de regresso) e os que já passaram a hora de saída.
- **Operações em curso**: a fazer check-in, em movimento, entrega pendente, à espera das malas, no local de entrega, a fazer check-out.
- **Próximas entregas e recolhas** (4, 8, 12 ou 24 h) com voo e ETA do voo.
- **Ocorrências por resolver**.
- **Caixa do turno por fechar/validar** (caixa fechada, caixa validada, condutor validado).
- **Bloqueios e horário de amanhã** dos parques. Às 02:30 "amanhã" ainda conta a partir da noite de ontem.

**Alterações por gravar**
- O que escreveste não se perde ao mudar de separador.
- Mudar de dia, turno ou cidade, ou recarregar, pergunta antes se há alterações **por gravar**.

**Quando a leitura falha**
- Cada parte (as tuas cidades, o registo do turno, o resumo automático, o histórico, o resumo do dia, o cumprimento) mostra **"Não foi possível carregar…"** com **Tentar de novo**.
- Uma falha nunca aparece como "sem passagens" ou "sem cidade atribuída".

**Notas**
- Depois de 24 h só um supervisor, ou quem tem acesso ao **Resumo do dia**, pode alterar a passagem. A mesma regra vale para o resumo IA.
- Não dá para registar passagens para depois de amanhã.
- Quem só consulta vê a passagem, mas não grava, não gera o resumo nem confirma.
- No telemóvel, o **Histórico** mostra um cartão por passagem.
- A supervisão vê o **Resumo do dia** (entregas lentas, recolhas atrasadas, reclamações do dia). Num dia com movimentos a mais aparece o aviso de que os tempos são só de uma parte do dia.

**Despesas do turno** (em Valores): lança cada despesa paga com o dinheiro da caixa — descrição, valor e foto do talão. Entra logo nas **Despesas** (paga, dinheiro, centro da cidade) e abate à **caixa do dia** (Financeiro → Caixa → Por dia). **Anular** deixa-a cancelada (nunca se apaga).
