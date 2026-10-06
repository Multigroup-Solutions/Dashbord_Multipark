---
modulo: radio
titulo: Rádio (gravações do Zello e transcrições)
rotas: /radio
palavras: rádio, radio, transcrição, transcrições, áudio, zello, comunicações, resumo, condutor, viatura, transcrever, transcrição automática, mais antigas, gravações, gravação, ouvir, mensagens de voz, intervalo, hora, utilizador do zello, canal, gps, velocidade, posição, mapa, cruzar, movimentos da multipark, check-in, check-out, pda
---
# Rádio

Menu **Operações → Rádio**. Tem dois separadores: **Gravações do Zello** (abre aqui) e **Transcrições**.

## Gravações do Zello

As mensagens de voz vêm **diretamente do histórico do Zello**, cruzadas com o GPS e com a Multipark.

1. Escolhe o **dia** e o intervalo **de / até** (hora de Lisboa, no máximo 24 horas). Se o "até" for antes do "de", conta como o dia seguinte (ex.: 22:00 → 02:00, o turno da noite).
2. Se quiseres, escolhe um **utilizador do Zello** (com **também as que recebeu**) e/ou um **canal**.
3. Carrega em **Procurar**. Vêm 100 mensagens de cada vez, das mais antigas para as mais recentes. **Ver mais** traz as seguintes.

Cada mensagem mostra:
- **Hora, quem falou e para onde** (canal ou pessoa) e a duração.
- **Quem falou**: os PDAs são partilhados, por isso conta a pessoa com **check-in nesse PDA a essa hora**. Sem check-in, conta a ficha que tem esse Zello. Sem nenhum dos dois, fica **por identificar**.
- **Ouvir**: o áudio vem do Zello. Às vezes o Zello demora uns segundos a prepará-lo.
- **Transcrição**: a do Zello, quando a rede a tem ligada ("pode ter erros" se o Zello o disser). Sem ela, **Transcrever (IA)** (team leaders, supervisores e administração). A transcrição fica guardada e não se paga duas vezes.
- **Posição e velocidade** nessa hora, pelo ponto GPS do Zello mais perto (até 5 minutos), com **ver no mapa**.
- **Multipark**: o que essa pessoa fez **10 minutos antes e depois** (entradas, saídas, movimentos), com matrícula, reserva e parque. Conta pelos agentes ligados à ficha (RH → Ligações).

Quem só vê a sua cidade só vê as mensagens de pessoas dessa cidade. As de outras cidades, ou de quem não se sabe quem é, ficam de fora e aparece um aviso.

## Transcrições

As comunicações de rádio passadas a texto a partir de um ficheiro de áudio, com um resumo de 1 ou 2 frases.

**A lista**
- Das mais recentes para as mais antigas, **50 de cada vez**. **Ver mais** traz as anteriores.
- Cada transcrição diz quando foi feita, o **condutor** (se foi indicado), a **viatura** (se foi indicada), a duração do áudio e **quem a fez**: o nome de quem a pediu ou **Transcrição automática (API)** quando veio de outro sistema.
- **Áudio** abre a gravação.

**Nova transcrição** (team leaders, supervisores e administração)
1. Escolhe o ficheiro de áudio (até 4 MB).
2. Indica o condutor, se quiseres (só aparecem colaboradores ativos). A viatura só aparece quando há viaturas registadas.
3. Carrega em **Transcrever**. A transcrição usa IA, que tem custo, e a duração do áudio é lida do ficheiro.
- O áudio tem de ser carregado aqui: não se aceitam endereços de fora.

**Quando a leitura falha**
- Aparece **"Não foi possível carregar as transcrições"** com **Tentar de novo**, em vez de "Sem transcrições".

Cada pessoa só vê as transcrições da sua cidade: a do condutor ou, sem condutor, a de quem transcreveu.
