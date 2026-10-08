# IA no dashboard — inventário página a página (D7)

Levantamento feito no código a 3 out 2026 (lote 26b); atualizado a 8 out 2026
com as decisões do Jorge (ver "Decidido a 8 out 2026", no fim). Para cada sítio onde a IA
corre: **quando** (sozinha ou a pedido), **quem vê**, **que dados lhe chegam** e
**o que fica guardado ou o que ela faz sozinha**. A configuração geral (modelos,
custos, interruptores) está em [`docs/ia.md`](ia.md).

**Regras comuns**
- Todas as chamadas passam por `runAi` (`server/_core/ai/run.ts`): interruptor
  geral `AI_ENABLED` + o interruptor da funcionalidade (Definições →
  Automações → *Inteligência artificial*) + orçamento mensal.
- As automações usam `tryAi` (`server/aiOps/aiCall.ts`): tapa os dados pessoais
  (`redactPii`) e nunca rebenta — sem IA fica um texto fixo feito no código.
- Os números vêm sempre do SQL/código; a IA só escreve o texto (briefing,
  relatórios, anomalias, avaliação, leads).
- Começam **desligados**: `AI_HR_AUTOFILL`, `AI_HR_EMAIL_ATTACHMENTS`,
  `AI_CRM_IDENTITY`. Todos os outros começam ligados (o `AI_MAIL_ROUTING` passou a ligado a 8 out 2026).
- **Ficheiros pessoais inteiros** (documentos e CV do RH: `AI_HR_AUTOFILL` e
  `AI_HR_EMAIL_ATTACHMENTS`) só correm com a IA em **Vertex AI numa região da
  UE**. Fora disso não correm, mesmo ligados (regra em `shared/aiLimits.ts`,
  no `runAi` e no `aiFeatureAvailable`).
- Agendamentos (agendador `/api/cron/tick`, de 5 em 5 min):
  - `ai-comms` de 15 em 15 min;
  - `ops-briefing` uma vez por dia a partir das 07:30;
  - `crm-auto-merge` a partir das 05:15;
  - `web-analytics` uma vez por dia;
  - `mail-sync` de 5 em 5 min.

Legenda: **Auto** = corre sozinha · **Pedido** = só quando alguém carrega no botão.

## Por página

### Em todas as páginas — Multis
| O quê | Quando | Quem vê | Dados que vão à IA | Guardado / age sozinha? |
|---|---|---|---|---|
| Multis (chat) — `AI_ASSISTANT` | Pedido (20/min, 200/dia por pessoa) | Qualquer pessoa com sessão; as ferramentas exigem o módulo e correm como a própria pessoa | Pergunta, 6 últimas trocas, ajuda (palavras-chave + significado, até 3 páginas) e base de conhecimento, notas da memória (`<memoria>`), com `redactPii`; resultados das ferramentas (totais e listas curtas) | Conversas 30 dias; ferramentas usadas ficam na Atividade. 👍/👎 e respostas que não responderam (marcadas sozinhas) em "Perguntas que falharam" (só admins; sem purga) |
| Memória do Multis — `AI_ASSISTANT_MEMORY` (sem IA) | "Lembra-te…" no chat (grava sem IA) ou à mão em Memória | A própria pessoa (as suas); notas da empresa: todos leem, só admins escrevem | O texto da nota (até 300 car.) | `assistant_memories`; arquivar não apaga. Ligado por omissão |

### Dashboard e Tarefas — Briefing do dia
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Briefing por cidade — `AI_OPS_BRIEFING` + `OPS_BRIEFING` | Auto, uma vez por dia a partir das 07:30 | Quem tem Passagem de turno (ler) nas suas cidades; **email** aos TL e supervisores da cidade | Números do SQL (reservas por hora, extras, prazos, pendentes com `redactPii`, anomalias) | `ops_briefings`. As secções filtram-se por pessoa, mas o parágrafo da IA é um por cidade |

### Operações, Despesas e Marketing — Alertas
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Explicação das anomalias — `AI_ANOMALY_EXPLAIN` + `OPS_ANOMALIES` | Auto no `ops-briefing` (1 chamada por dia para até 20 anomalias). Abrir a página nunca a dispara | Reservas: quem lê Reservas & Operações. **Condutores e extras veem o alerta, mas não a linha da IA** (o servidor não a manda; 8 out 2026). Despesas: quem vê a cidade. Marketing: super admin | Linhas da anomalia (parque, canal ou fornecedor, números), com `redactPii` | `ops_anomalies.explanation` |

### Despesas
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Ler a fatura — `AI_EXPENSE_OCR` (essencial) | Pedido: **"Extrair com IA"** | Quem cria despesas (o condutor também, só as suas) | Imagem ou PDF da fatura **inteira** e a lista de categorias | Não. Só preenche o formulário; quem grava é a pessoa |

### Críticas
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Rascunho de resposta — `AI_REVIEW_DRAFTS` | Pedido: **"Gerar com IA"**. Também ao **"Importar Review"** de 4–5★ | Críticas (TL para cima, cidade) | Texto da crítica (até 2000 car.) com `redactPii`, 1.º nome, estrelas | `aiResponse` por aprovar; publicar exige "Aprovar e publicar" |
| Rascunho automático — `AI_REVIEW_AUTO_DRAFTS` | Auto: `ai-comms` (3 por corrida, até 14 dias), cada email novo para criticas@, fim do sync do Google Business (em pausa) | Críticas | Como acima + sentimento e contexto da reclamação ou reserva ligada | `aiResponse` + `aiSentiment`, por aprovar |

### Rádio
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Transcrição + resumo — `AI_RADIO` | Pedido: **"Transcrever"**. Auto: upload por chave de API de dispositivo | Rádio (TL para cima) | **Áudio inteiro** (Gemini, ou Whisper se houver chave); o resumo usa a transcrição com `redactPii` | `radio_transcriptions` |

### Passagem de turno
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Resumo para o turno seguinte — `AI_HANDOVER_SUMMARY` | Auto **só ao entregar** (1.ª gravação). Pedido: **"Resumir agora"** (quem edita; resume a passagem gravada). Editar depois **não chama a IA**: aparece "resumo desatualizado" | Passagem de turno (TL para cima, cidade); **email** aos TL do turno seguinte e CC (o resumo desatualizado não vai no email) | Contagens, 1.º nome da equipa seguinte, picos, notas do TL (até 1500 car.) e pendentes, com `redactPii` | `shift_handovers.aiSummary` + `aiSummaryVersion` (0600) |
| Resumo da semana e pendentes repetidos — `AI_HANDOVER_REPEATS` + `WEEKLY_REPORTS` | Auto à segunda-feira | Passagem de turno com a cidade; **email** aos TL e supervisores | Contagens da semana e pendentes repetidos, com `redactPii` | `ai_weekly_reports` |

### WhatsApp
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Resumo e sugestão de resposta — `AI_WHATSAPP_ASSIST` | Pedido: menu ⋮ **"Resumo da conversa (IA)"** e ✨ **"Sugerir resposta"** | Quem edita no WhatsApp e vê a conversa | Últimas 40 mensagens (até 8000 car.) com `redactPii` | Não. A sugestão vai para a caixa de texto; nunca é enviada sozinha |
| Intenção e urgência — `AI_WHATSAPP_TRIAGE` | Auto a cada mensagem recebida (no máximo 1 vez/5 min por conversa) + `ai-comms` | WhatsApp | Últimas 8 mensagens (até 1500 car.) com `redactPii` | Etiquetas e urgência. A intenção serve para pôr na caixa do tema as conversas **novas** (com `AI_MAIL_ROUTING`); a que já tem caixa fica |

### Comunicação (email)
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Rascunho de resposta — `AI_MAIL_DRAFT` | Pedido: **"Rascunho IA"** | Quem pode responder na caixa (no "O meu email", o dono) | Últimas 8 mensagens (até 9000 car.) com `redactPii` | Não (fica no editor) |
| Separar pelas caixas — `AI_MAIL_ROUTING` (ligado) | Auto: cada email que abre conversa numa caixa partilhada (na sincronização, até 10 por vez; o resto no `ai-comms`) e cada conversa NOVA do WhatsApp (a seguir à triagem, sem 2.ª chamada) | Quem vê a caixa de destino; "Movido pela IA → caixa (motivo)" na conversa; "Entraram pela IA" nos Leads | Assunto e texto (até 2500 car., sem o histórico citado) com `redactPii`, 1.º nome, nomes dos anexos | Muda a caixa (por ler); não percebeu → info. Recrutamento em 1.º contacto: cria lead + candidatura. Registo em `comms_ai_routing`; nunca responde |

### Reclamações
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Triagem + rascunho — `AI_COMPLAINT_TRIAGE` | Auto depois do `mail-sync` (até 5) e no `ai-comms` (3 por corrida, até 3 dias). Pedido: "Analisar" | Reclamações (TL para cima, cidade) | Título e descrição (até 2500 car.) com `redactPii` | `ai_suggestions`. **Aplica sozinha com confiança ≥ 0,85** nos campos vazios (tipo, prioridade, SLA, reserva), com "Desfazer". O email ao cliente é sempre uma pessoa a enviar |

### Perdidos & Achados
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Possíveis correspondências — `AI_LOST_FOUND_MATCH` | Auto no `ai-comms` (3 por corrida, casos até 30 dias, uma vez por dia). Pedido: "Procurar" | Perdidos (TL para cima, cidade) | Descrição do caso e de até 5 candidatos, com `redactPii` | `lost_found_matches`. "Confirmar" só deixa nota; contactar é humano |

### Clientes → Rever
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| "É a mesma pessoa?" — `AI_CRM_IDENTITY` (**desligado**) + `CRM_AUTO_MERGE` | Auto no `crm-auto-merge` (a partir das 05:15). Pedido: "Juntar agora" (super admin) | Clientes (ler) | 1.º nome, n.º de reservas e factos ("telefone igual", "NIF diferente"); nunca os contactos | `crm_merge_suggestions`. **Junta fichas sozinha com ≥ 85 %** |

### Formação e Conhecimento
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Perguntas do quiz — `AI_QUIZ` | Pedido: **"Gerar perguntas (IA)"** (manual) e **"Gerar rascunhos"** (documento da base) | Formação com gestão (admin, super admin) | Texto com `redactPii` (**26b:** também no manual). O PDF anexo do manual vai **inteiro** | `quiz_questions` como rascunho (por publicar) |
| Tutor da formação — `AI_TRAINING_TUTOR` | Pedido: chat, "Explicar melhor", "Explicar as respostas erradas" (10/min, 100/dia) | Todos os papéis; cada um vê o seu; os formadores veem um agregado anónimo | Pergunta com `redactPii`, trechos do manual, 4 últimas trocas | Mensagens 30 dias; perguntas anónimas |
| Base de conhecimento — `AI_KNOWLEDGE` | Ao carregar, "Sincronizar agora" e **sozinha quando há alterações nas pastas do Drive** (avisos da Google → fila de hora a hora + verificação de 4 em 4 h) | Formação com gestão; as citações conforme quem lê | **PDF inteiro** só quando o Drive não o converte; trechos e perguntas com `redactPii` | Texto, trechos e vetores |

### Recursos Humanos
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Preencher a ficha a partir de documentos — `AI_HR_AUTOFILL` (**desligado**; **só com Vertex AI na UE**) | Auto em cada carregamento de CC, título de residência, carta, IBAN ou morada | Quem pode editar os dados pessoais | Imagem ou PDF do documento **inteiro** | Só campos **vazios** (NIF, nascimento, nacionalidade, morada). **26b:** o IBAN lido só entra na hora para quem o pode mudar na hora (D49); para os outros (incluindo o próprio) fica um **pedido ao RH** |

### Leads de Extras
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Anexos do email do RH (CV) — `AI_HR_EMAIL_ATTACHMENTS` (**desligado**; **só com Vertex AI na UE**) | Auto no `ai-comms` (2 anexos por corrida, emails até 14 dias, cada anexo uma vez) | Resumo: Leads (TL para cima). NIF, BI/CC e carta só papéis nacionais e admin para cima | CV em PDF, imagem ou DOCX **inteiro** | Campos vazios do candidato + resumo para quem entrevista |
| Resumo da pontuação — `AI_LEAD_SCORING` | Pedido: **"Resumo IA"** | Pedir: Leads **com editar** (os recrutadores; 8 out 2026). Ver o resumo já feito: Leads com ler | Linhas da pontuação (calculada no código), com `redactPii` | Cache por hash |
| Rascunho do 1.º contacto — `AI_LEAD_SCORING` | Pedido: **"Rascunho com IA"** | Leads com editar | 1.º nome e cidade | Rascunho; enviar exige "Aprovar" |

### Extras Dia e Disponibilidade
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Respostas de disponibilidade pouco claras — `AI_AVAILABILITY_CLASSIFY` | Auto quando as regras não percebem: WhatsApp de um colaborador com pedido nos últimos 10 dias (também precisa de `EXTRAS_AVAILABILITY_AUTO_REPLY`) e emails para recursos-humanos@ | Chefias (tarefas e avisos) | Resposta (até 600 car.) e o pedido, com `redactPii` | Com ≥ 85 %: **marca a disponibilidade, responde por WhatsApp e confirma ou recusa o turno**. Abaixo disso, tarefa para uma pessoa |

### Avaliação
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Explicação da avaliação — `AI_EVALUATION_EXPLAIN` | Auto **ao abrir a página** (com cache por hash: só paga quando os números mudam) | O próprio e as chefias no seu âmbito; o TL pode esconder | Linhas das regras e total, sem nomes | `evaluation_explanations` |

### Tarefas
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Tarefas a partir de texto — `AI_TASKS_FROM_TEXT` | Pedido: **"Criar tarefas a partir de texto"** | Tarefas com editar, **team leader para cima** (extras e condutores não; o servidor recusa) | Texto colado (até 6000 car.) com `redactPii` | Não. Só cria depois de a pessoa confirmar |

### Marketing → Web & SEO (só super admin)
| O quê | Quando | Quem vê | Dados | Guardado / sozinha? |
|---|---|---|---|---|
| Resumo semanal — `AI_WEB_INSIGHT` | Auto uma vez por semana (depois do `web-analytics`). Pedido: "Gerar de novo" | Marketing | Totais de GA4, Search Console, PageSpeed e reservas | Último resumo; entra no email semanal de marketing |
| O que corrigir primeiro — `AI_PAGESPEED_EXPLAIN` | Pedido: **"Explicar"** | Marketing com gestão | Títulos e poupanças do Lighthouse | Não |
| Publicações Google Business — `AI_GBP_POSTS` | Pedido: **"Rascunho IA"** | Marketing com gestão | Tema, tipo, marca e cidade | Não (fica no editor) |

### Só por email (sem página)
| O quê | Quando | Quem recebe | Dados | Guardado |
|---|---|---|---|---|
| Relatórios semanais — `AI_WEEKLY_REPORTS` + `WEEKLY_REPORTS` | Auto à segunda-feira | Quem tem o módulo com alcance nacional: direção (admin, super admin), marketing (super admin), operações e RH (front e back office, admin, super admin) | Métricas da semana e notas, com `redactPii` | `ai_weekly_reports`. O texto é igual para todos os destinatários |

### Integrações
| O quê | Quando | Quem vê | Dados | Guardado |
|---|---|---|---|---|
| Teste de ligação (só `AI_ENABLED`) | Pedido: "Testar" | Admin e super admin | "Responde só: ok" | Não |

## O que a IA faz sozinha (sem uma pessoa a carregar)

Regra do dono (8 out 2026): a IA age sozinha onde é **reversível** e **não fala
com clientes**.

1. **Disponibilidade dos extras** (`AI_AVAILABILITY_CLASSIFY`): com ≥ 85 % marca a disponibilidade, responde por WhatsApp ao colaborador e confirma ou recusa o turno. Abaixo disso, tarefa para uma pessoa. Mantém-se.
2. **Separar pelas caixas (email e WhatsApp):** põe as conversas novas na caixa do tema (e com isso muda quem as vê); o que não percebe vai para o info. Recrutamento em 1.º contacto: cria a lead e a candidatura (nunca escreve ao candidato).
3. **Reclamações** (`AI_COMPLAINT_TRIAGE`): com ≥ 0,85 preenche o tipo, a prioridade, o SLA e a reserva quando estão vazios (com "Desfazer"). Mantém-se.
4. **Passagem de turno** (`AI_HANDOVER_SUMMARY`): o resumo faz-se **só ao entregar** a passagem. As edições não chamam a IA; quem edita carrega em "Resumir agora".
5. **Clientes:** junta fichas com ≥ 85 % (desligado).
6. **Ficha do RH:** preenche campos vazios a partir de documentos (desligado; só com Vertex AI na UE; o IBAN fica pedido ao RH).
7. **Base de conhecimento:** sincroniza sozinha quando há alterações nas pastas do Drive.

Nada disto envia emails a clientes nem publica respostas: isso é sempre uma pessoa.

## Corrigido neste lote (26b)
- **IBAN lido pela IA nos documentos do RH:** já não contorna o D49. Só entra na hora para back office, supervisor, admin e super admin (nunca na própria ficha); para os outros fica um pedido ao RH.
- **Quiz a partir de um manual da Formação:** o texto passa a ir sem dados pessoais (`redactPii`), como já acontecia na base de conhecimento.
- **`docs/ia.md`:**
  - tabela dos interruptores completa;
  - agendamentos certos (agendador, briefing a partir das 07:30, Google Business em pausa);
  - lista das variáveis de ambiente sem duplicados.

## Decidido a 8 out 2026

O Jorge respondeu aos 7 pontos "para decidires" do lote 26b ("avança com o 7,
a IA a agir sozinha"):

1. **Disponibilidade dos extras** (`AI_AVAILABILITY_CLASSIFY`): **mantém-se**. Com ≥ 85 % marca, responde por WhatsApp e confirma ou recusa o turno.
2. **Triagem do WhatsApp:** **mantém-se**, governada pelo encaminhamento por caixas. A IA separa as conversas novas pelas caixas; as conversas com histórico ficam onde estão.
3. **Reclamações** (≥ 0,85, só campos vazios, com "Desfazer"): **mantém-se**.
4. **Resumo da passagem de turno:** passa a correr **só ao entregar** (1.ª gravação) e no botão **"Resumir agora"** (quem pode editar). Editar depois não chama a IA: o ecrã mostra "resumo desatualizado" e o email ao turno seguinte já não leva o resumo velho. Coluna `shift_handovers.aiSummaryVersion` (migração 0600).
5. **Quem vê a mais** (garantido no servidor):
   - **Alertas:** condutores e extras veem o alerta, mas não a linha da IA. A explicação faz-se uma vez por dia no `ops-briefing`; abrir a página nunca a dispara.
   - **"Criar tarefas a partir de texto":** só team leader para cima.
   - **"Resumo IA" das leads:** só quem edita as Leads (os recrutadores).
6. **Base de conhecimento:** os textos passam a dizer a verdade: sincroniza sozinha quando há alterações nas pastas do Drive. O comportamento não muda.
7. **Ficheiros pessoais inteiros (RGPD):** `AI_HR_AUTOFILL` e `AI_HR_EMAIL_ATTACHMENTS` só correm com a IA em **Vertex AI numa região da UE**. Fora disso não correm, mesmo ligados. As Definições → Automações dizem ao lado do interruptor "Só corre com a IA em Vertex AI na UE (hoje: …)". O rádio, as faturas e o resto não dependem disto.
