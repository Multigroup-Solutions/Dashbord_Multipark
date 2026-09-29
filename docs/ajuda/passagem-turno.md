---
modulo: passagem_turno
titulo: Passagem de turno
rotas: /passagem-turno
palavras: passagem de turno, passagem, fim de turno, checklist, caixa, fecho de caixa, cofre, bolsa, terminal, rolos mb, fardamento, fardas, pendentes, observações, recebi, resumo do dia, estado do parque, ao vivo, carros no parque, garagem, ocorrências, bloqueios, caixa por fechar
---
# Passagem de turno

Checklist de fim de turno dos team leaders e resumo do dia para a supervisão.

**Preencher** (Team Leader)
1. Menu **Operações → Passagem de Turno**. Escolhe a cidade e o turno (manhã/noite). O dia operacional vai das 03:00 às 03:00 do dia seguinte.
2. Preenche a caixa (caixa de check-out, fecho de caixa no cofre, valores das bolsas front/terminal, tickets/despesas pagos), o material (canetas, rolos MB, bateria), o fardamento e os **Pendentes para o turno seguinte**.
3. Escreve observações e carrega em **Guardar passagem de turno**.
4. Quem entra confirma com **Recebi**.

**Resumo automático** (no topo de **Preencher**)
- As recolhas e entregas do próximo turno (com voo e valor a pagar), as entregas pendentes, os carros p/ coberto e as ocorrências abertas vêm **ao vivo da BD da Multipark**.
- Se a BD da Multipark não responder, aparece um aviso a laranja e o resumo usa as cópias do dashboard (como antes). O resto da passagem funciona igual.

**Estado do parque (ao vivo)**
Separador com o estado atual dos parques da cidade (sem os **Parques que a operação não faz** das Definições — o mesmo vale para o resumo da passagem), lido diretamente da BD da Multipark (só leitura):
- **Carros no parque** por parque e garagem (com lugar, hora de saída e voo de regresso) e os que já passaram a hora de saída.
- **Operações em curso**: a fazer check-in, em movimento, entrega pendente, à espera das malas, no local de entrega, a fazer check-out.
- **Próximas entregas e recolhas** (4, 8, 12 ou 24 h) com voo e ETA do voo.
- **Ocorrências por resolver**.
- **Caixa do turno por fechar/validar** (caixa fechada, caixa validada, condutor validado).
- **Bloqueios e horário de amanhã** dos parques.

**Notas**
- Depois de 24 h só um supervisor pode alterar a passagem.
- Não dá para registar passagens para depois de amanhã.
- A supervisão vê o **Resumo do dia** (entregas lentas, recolhas atrasadas, reclamações do dia) e pode gerar um resumo com IA.
