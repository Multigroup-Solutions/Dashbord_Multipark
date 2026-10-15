---
modulo: passagem_turno
grupo: Operações
pagina: passagem-turno
titulo: Passagem de turno
rotas: /passagem-turno
palavras: na fila há, em entrega há, em recolha há, cronómetro, cor da meta, sem passagem de turno, resumir agora, resumo desatualizado, resumo ia, resumo da ia, entregar a passagem, mal arrumado, garagens, pendentes que se arrastam, resumo da semana, tipo de lugar, toldo, toldos, coberto, descoberto, interior, vip, passagem de turno, passagem, fim de turno, checklist, caixa, fecho de caixa, cofre, bolsa, terminal, rolos mb, fardamento, fardas, pendentes, observações, recebi, resumo do dia, estado do parque, ao vivo, carros no parque, garagem, ocorrências, bloqueios, caixa por fechar, pendentes do turno anterior, por gravar, por confirmar, 24 horas
---
# Passagem de turno

Checklist de fim de turno dos team leaders e o histórico das passagens.

**O Resumo do dia mudou de sítio** (12 out 2026): está agora em **Operações → Actividade Diária → Resumo do dia**, com tudo o que tinha (quem trabalhou, entregas lentas, passagens por chefe de turno). Quem o via aqui vê-o lá, com a mesma permissão. Na Passagem de turno fica uma ligação para lá.

## Preencher (Team Leader)
1. Menu **Operações → Passagem de Turno**. Escolhe a cidade e o turno (manhã/noite). O dia operacional vai das 03:00 às 03:00 do dia seguinte.
2. Preenche a caixa (caixa de check-out, fecho de caixa no cofre, valores das bolsas front/terminal, tickets/despesas pagos), o material (canetas, rolos MB, bateria), o fardamento e os **Pendentes para o turno seguinte**.
3. Escreve observações e carrega em **Guardar passagem de turno**. Grava logo. O resumo IA, o aviso e o email ao team leader do turno seguinte seguem dentro de momentos, e o histórico atualiza-se sozinho.
4. Quem entra confirma com **Recebi**. Nem quem criou a passagem nem quem a editou por último a podem confirmar.

**Resumo IA para o turno seguinte**
- A IA faz o resumo **quando entregas** a passagem (a 1.ª vez que carregas em **Guardar passagem de turno**). Antes disso a caixa diz "A IA faz o resumo quando guardares (entregares) a passagem."
- **Atualizar** a passagem depois **não chama a IA** (cada resumo é uma chamada paga). O resumo fica como estava e aparece **Resumo desatualizado**; o email desse envio já não leva o resumo velho (leva as notas, os números e os pendentes).
- **Resumir agora** (quem pode preencher passagens) refaz o resumo a partir da passagem **gravada**. Com alterações por gravar, grava primeiro.
- No histórico, um resumo que ficou para trás aparece como "✨ resumo IA (desatualizado)"; na **Passagem recebida**, o turno seguinte vê as notas em vez do resumo velho.

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

## Resumo automático (no topo de **Preencher**)
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
    - **Toldo no PD: amarelo aqui, mas "parque certo" nos tempos.** São duas perguntas diferentes: aqui é "onde devia estar, se houver lugar" (o toldo fica melhor na coberta); nos **tempos das recolhas** (Definições → Parâmetros → **Papéis das garagens**) o PD é **parque certo** para descobertos **e toldos**, por isso a recolha conta como arrumada quando o toldo chega ao PD. Mudá-lo depois para a coberta é arrumação, não atrasa a recolha.
    - Garagem com outro nome, ou carro sem tipo: fica sem cor (não se adivinha).
  - **Mal arrumados** (por baixo): em cima, quantos estão mal arrumados e quantos toldos estão numa descoberta. Por baixo, **uma linha por tipo**, com quantos carros: por exemplo "Descoberto em COBERTO · 11 carros", "Interior em PD · 6 carros", "Toldo em PD (se der, coberta) · 8 carros". Primeiro os mal arrumados (a vermelho, com ⚠), depois os "se der" (a amarelo).
    - Carrega numa linha para ver os carros dela (matrícula, lugar e parque) e ires buscá-los; carrega outra vez para fechar. Ao entrar estão todas fechadas.
  - **Ver por parque e garagem** abre a divisão antiga.
- **Pendentes que se arrastam** e **Resumo da semana** contam só os pendentes da passagem: PDAs ainda com check-in e notas do team leader. Ocorrências, reclamações e perdidos não são da passagem e já não aparecem aqui. Os resumos de semanas anteriores, que ainda falavam deles, deixam de se mostrar; o próximo sai na segunda-feira.
- Os que já passaram a hora de saída.
- **Operações em curso**, cada uma com um **cronómetro** que anda sozinho (de 30 em 30 s) e a hora em que começou: **Em recolha há X** — o cliente ligou para a recolha; **Em movimento há X**; **Na fila há X** — o cliente ligou a pedir o carro (pendente); **Em entrega há X** — o condutor já pegou no carro e saiu do parque (a caminho do terminal ou lá à espera do cliente; sem GPS ao vivo não se sabe se já chegou); **No terminal** — só quando o condutor carregou em "Cheguei" nesta entrega (quase não se usa). **À espera das malas** aparece como etiqueta ao lado, quando é deste pedido.
  - Só **Na fila** tem cor: fica **âmbar** a partir da meta da entrega (**Definições → Parâmetros → "Tempos: meta da entrega"**, 15 min por omissão) e **vermelho** a partir do dobro. **Em entrega** não tem cor: inclui a espera pelo cliente no terminal, que não é tempo nosso.
- Na lista **Entregas pendentes (na fila)** do rascunho só entram os carros **na fila**: um carro em entrega já saiu do parque. Cada um diz **"na fila há X min"** (com a hora do pedido entre parênteses), com as mesmas cores.
- **Próximas entregas e recolhas** (4, 8, 12 ou 24 h) com voo e ETA do voo.
- **Caixa do turno por fechar/validar** (caixa fechada, caixa validada, condutor validado).
- **Bloqueios e horário de amanhã** dos parques. Às 02:30 "amanhã" ainda conta a partir da noite de ontem.

**Alterações por gravar**
- O que escreveste não se perde ao mudar de separador.
- Mudar de dia, turno ou cidade, ou recarregar, pergunta antes se há alterações **por gravar**.

**Quando a leitura falha**
- Cada parte (as tuas cidades, o registo do turno, o resumo automático, o histórico) mostra **"Não foi possível carregar…"** com **Tentar de novo**.
- Uma falha nunca aparece como "sem passagens" ou "sem cidade atribuída".

**Notas**
- Depois de 24 h só um supervisor, ou quem tem acesso ao **Resumo do dia**, pode alterar a passagem. A mesma regra vale para o **Resumir agora**.
- Não dá para registar passagens para depois de amanhã.
- Quem só consulta vê a passagem, mas não grava, não pede o resumo nem confirma.
- No telemóvel, o **Histórico** mostra um cartão por passagem.
- O **Resumo do dia** (supervisão) está em **Operações → Actividade Diária → Resumo do dia**.

**Fecho da caixa do turno** (13 out 2026): depois de fechares a caixa na Multipark, escreve o **dinheiro recebido** dos condutores neste turno (antes das despesas), o **Multibanco recebido** e o **total que dava a caixa na Multipark**. O João usa estes valores no dia seguinte em **Caixa → Confirmação**; sem eles o dia não se fecha.

**Despesas do turno** (em Valores): lança aqui cada despesa paga com o dinheiro da caixa — não é preciso ir ao Financeiro.
1. Carrega em **Talão** e tira a foto (ou escolhe uma foto ou PDF). Enquanto aparece **A ler o talão…**, a IA (a mesma das Despesas) lê o talão e preenche a descrição, o valor e os dados do talão: fornecedor, NIF, n.º do documento, data, IVA e categoria.
2. Abre **O que a IA leu do talão**, confirma e corrige o que for preciso e carrega em **Lançar**. A IA nunca escreve por cima do que já escreveste. Se a IA estiver desligada ou não conseguir ler, preenche à mão: descrição e valor chegam (os dados do talão são opcionais, em **Dados do talão**).
3. A aplicação avisa quando o NIF não está certo, quando a data do talão está longe do turno (só aceita do dia seguinte até um mês antes), quando o talão parece já estar lançado nas Despesas e quando o documento parece uma fatura emitida pela Multipark.
4. A despesa entra logo nas **Despesas** (paga, dinheiro, centro da cidade, com o talão e a data do talão) e abate à **caixa do dia** (Financeiro → Caixa → Por dia). O IVA lido fica nas notas da despesa.
5. Cada despesa lançada tem **Abrir nas Despesas (n.º …)**: abre o detalhe dessa despesa num separador novo (a passagem que estás a preencher não se perde). Quem não pode ver essa despesa nas Despesas vê só "Já está nas Despesas (n.º …)".

**Anular** deixa a despesa do turno cancelada (nunca se apaga).
