# PDAs, pessoas e nomes: plano (decisões do Jorge, 29 set 2026)

O centro de tudo é a **ficha do RH**. Cada ficha tem **uma cidade**, **um ou mais utilizadores da app**, **um utilizador do Zello** e **um ou mais agentes da Multipark**. Toda a app lê destes campos.

## 1. Regra única para comparar texto (feito: PR #164)

Para ligar, procurar ou juntar, só contam as letras e os números. Não contam acentos, maiúsculas, apóstrofos, traços, pontos nem espaços. Está em `shared/textKey.ts`.

## 2. Identidade: uma pessoa, várias contas e vários agentes

- **Vários agentes por pessoa.** Uma pessoa pode ter vários agentes da Multipark (emails antigos e novos). No ecrã da ficha dá para **anexar** um agente à pessoa (tira-o de onde estava) e **retirá-lo**, à mão.
- **Juntar utilizadores.** Caso típico: a ficha foi criada com um email (por exemplo do Outlook) e a pessoa depois entrou com outra conta Google, o que criou um utilizador "perdido".
  - "Juntar" deixa um só utilizador, o que entra na app.
  - Tudo o que estava no outro passa para ele: a ficha, as permissões, as notificações e as tarefas.
  - O email antigo fica na ficha como email secundário.
  - O utilizador antigo é desativado (nunca apagado).
- **Emails dos agentes.** O Jorge vai tentar exportar do back office da Multipark a lista de agentes com email, parque e regime. Importada essa lista, a ligação por email resolve os casos em massa. Se não der, pede-se ao Rafael uma vista só de leitura.
- **Agentes de teste.** Os agentes sem ficha que parecem de teste ("teste", "test", "demo", sem reservas) saem da lista dos "por ligar". Não saem da Multipark. Todos os outros têm de ficar ligados.
- **Cidade da ficha.** Se não tiver cidade:
  1. usa-se a cidade onde o agente da Multipark costuma trabalhar;
  2. se não houver agente, usa-se a cidade da morada;
  3. se mesmo assim não der, a ficha fica em aberto e cria-se uma **tarefa para a Márcia Nunes**, também com email.

## 3. PDAs e Zello

- Cada PDA tem uma **etiqueta** (número ou nome) e uma **cidade fixa**.
- Liga-se **só pelo QR**. Sai o check-in manual, para não dar problemas.
- O dashboard abre no PDA numa **app do browser pré-definida** (PWA instalada), para não se usar outro browser.
- Quando alguém faz login no PDA, o dashboard muda na conta Zello do PDA o **nome que aparece no mapa** para "PDA 12 · Nome da pessoa". No logout volta a "PDA 12". Tem um interruptor para ligar e desligar.
- Há um só campo para o utilizador do Zello, em todo o lado.

## 4. Alertas: a trabalhar sem PDA ou Zello ligado

- **Quem:** só as pessoas do **operacional**. O back office e o front office trabalham no computador e ficam de fora.
- **Quando dispara:**
  - quando a pessoa tem o **ponto aberto** e não tem PDA ou Zello ligado;
  - quando chega uma **movimentação da Multipark** feita por essa pessoa (check-in, saída, alteração, reserva recebida) e ela não tem o ponto aberto ou não tem o Zello ligado.
- **Para quem:**
  1. uma notificação na app ao **team leader de serviço nessa cidade** e ao **supervisor**;
  2. se em **10 minutos** não houver ligação nem resposta, um WhatsApp aos **administradores da lista dessa cidade** (Lisboa, Porto, Faro, em Definições), com cópia ao Jorge.
- **Grupo de WhatsApp:** a ideia é mandar para um grupo. As mensagens enviadas pela app fora da janela de 24 h têm de ser **modelos aprovados** pela Meta. Usa-se um modelo ("formulário"), aprovado uma vez.
