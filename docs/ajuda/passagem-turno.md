---
modulo: passagem_turno
titulo: Passagem de turno
rotas: /passagem-turno
palavras: mal arrumado, garagens, pendentes que se arrastam, resumo da semana, tipo de lugar, toldo, toldos, coberto, descoberto, interior, vip, horas trabalhadas, tempo parado, quilómetros, passagem de turno, passagem, fim de turno, checklist, caixa, fecho de caixa, cofre, bolsa, terminal, rolos mb, fardamento, fardas, pendentes, observações, recebi, resumo do dia, estado do parque, ao vivo, carros no parque, garagem, ocorrências, bloqueios, caixa por fechar, pendentes do turno anterior, por gravar, por confirmar, 24 horas
---
# Passagem de turno

Checklist de fim de turno dos team leaders e resumo do dia para a supervisão.

**Preencher** (Team Leader)
1. Menu **Operações → Passagem de Turno**. Escolhe a cidade e o turno (manhã/noite). O dia operacional vai das 03:00 às 03:00 do dia seguinte.
2. Preenche a caixa (caixa de check-out, fecho de caixa no cofre, valores das bolsas front/terminal, tickets/despesas pagos), o material (canetas, rolos MB, bateria), o fardamento e os **Pendentes para o turno seguinte**.
3. Escreve observações e carrega em **Guardar passagem de turno**. Grava logo. O resumo IA, o aviso e o email ao team leader do turno seguinte seguem dentro de momentos, e o histórico atualiza-se sozinho.
4. Quem entra confirma com **Recebi**. Nem quem criou a passagem nem quem a editou por último a podem confirmar.

**Pendentes que passam de turno**
- Só passam de turno os **PDAs ainda com check-in** e o que o team leader escreve (as notas). Reclamações, perdidos e achados, ocorrências e entregas pendentes **já não entram** nos pendentes: tratam-se nas páginas deles. Os que já estavam gravados em passagens antigas não se apagam, só deixam de passar e de aparecer.
- Os pendentes vêm da **última passagem** da cidade (até 3 dias para trás). Se o turno anterior não fez passagem, vêm da que houve antes, com o aviso de quantos turnos ficaram sem passagem.
- Enquanto os pendentes do turno anterior não estiverem na lista, o botão de gravar espera ("A juntar os pendentes do turno anterior…").
- Se não for possível lê-los, aparece um aviso a laranja com **Tentar de novo**. Só gravas sem eles se marcares **Gravar mesmo assim**; nesse caso continuam na passagem anterior.
- Um pendente herdado **resolve-se** (visto), não se apaga. Só podes remover as notas que escreveste neste turno.
- Linhas das observações começadas por "- " passam a pendentes. Se editares ou apagares a linha, o pendente acompanha.
- Quem resolveu e quando ficam com o nome da conta que grava.
- A lista leva até **60** pendentes; o contador mostra quantos tens. No limite ficam primeiro as notas e os herdados.
- Num turno antigo (nem o atual nem o que acabou agora), a passagem nova herda só os pendentes da anterior: o "ao vivo" é de agora, não desse turno.

**Resumo automático** (no topo de **Preencher**)
- As recolhas e entregas do próximo turno (com voo e valor a pagar), as entregas pendentes e os carros p/ toldo vêm **ao vivo da BD da Multipark**. Reclamações, perdidos e ocorrências já não aparecem aqui. As compras online ainda por pagar também contam: vão ser recolhidas na mesma.
- A equipa mostra **(por confirmar)** em quem ainda está só proposto na escala.
- Se a BD da Multipark não responder, aparece um aviso a laranja e o resumo usa as cópias do dashboard. O resto da passagem funciona igual.
- Uma parte que não se consegue ler mostra **erro** em vez do número. Não é 0, e no email e no resumo IA aparece como "sem dados (falhou a leitura)".

**Estado do parque (ao vivo)**
Separador com o estado atual dos parques da cidade, lido diretamente da BD da Multipark (só leitura). Não entram os **Parques que a operação não faz** das Definições; o mesmo vale para o resumo da passagem.
- **Carros no parque por tipo de lugar**: Descoberto, Toldo (o antigo "coberto"), Interior e VIP (a cidade já está escolhida em cima). O tipo é o do lugar atribuído (n.º de alocação); sem ele, o do produto reservado.
  - Por baixo do número aparecem as **garagens** onde esses carros estão, em cada parque (ex.: "Airpark: COBERTO 29 · PD 3").
  - Se a garagem não bate com o tipo, o carro está **mal arrumado** e a garagem aparece **a vermelho com ⚠**. As garagens são: **PD**, **PD FORA** e **CENTRAL** para descobertos; **COBERTO** e **CENTRAL COBERTO** para indoor e toldos.
    - **Vermelho**: indoor (ou VIP) fora de uma garagem coberta, ou descoberto numa garagem coberta.
    - **Amarelo**: toldo numa garagem descoberta. Passa para a coberta quando houver lugar ("se der").
    - Garagem com outro nome, ou carro sem tipo: fica sem cor (não se adivinha).
  - **Mal arrumados** (por baixo) lista esses carros, com matrícula, garagem, lugar e parque, para se irem buscar.
  - **Ver por parque e garagem** abre a divisão antiga.
- **Pendentes que se arrastam** e **Resumo da semana** contam só os pendentes da passagem: PDAs ainda com check-in e notas do team leader. Ocorrências, reclamações e perdidos não são da passagem e já não aparecem aqui. Os resumos de semanas anteriores, que ainda falavam deles, deixam de se mostrar; o próximo sai na segunda-feira.
- Os que já passaram a hora de saída.
- **Operações em curso**: a fazer check-in, em movimento, entrega pendente, à espera das malas, no local de entrega, a fazer check-out.
- **Próximas entregas e recolhas** (4, 8, 12 ou 24 h) com voo e ETA do voo.
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
- A supervisão vê o **Resumo do dia** (entregas lentas, recolhas atrasadas, reclamações do dia). Em **Quem trabalhou** há, por pessoa, as **horas** trabalhadas (as do ponto; com "~" quando não há picagens e é o tempo com o Zello ligado), os **km** e o tempo **parado** (com o Zello ligado mas sem andar). Todas as colunas se ordenam. Num dia com movimentos a mais aparece o aviso de que os tempos são só de uma parte do dia.

**Despesas do turno** (em Valores): lança cada despesa paga com o dinheiro da caixa — descrição, valor e foto do talão. Entra logo nas **Despesas** (paga, dinheiro, centro da cidade) e abate à **caixa do dia** (Financeiro → Caixa → Por dia). **Anular** deixa-a cancelada (nunca se apaga).
