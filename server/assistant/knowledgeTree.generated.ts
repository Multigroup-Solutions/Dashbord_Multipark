// GERADO por scripts/gen-ajuda.ts a partir de docs/ajuda/*.md — não editar à mão.
// Árvore da ajuda (Grupo do menu → Página → Secção), plano MPV §3.2.
import type { HelpTreeOutline } from "../../shared/helpTree";

/** Nível do índice que cabe no teto de 6000 tokens ("sections" = com os títulos das secções). */
export const KNOWLEDGE_INDEX_LEVEL: "sections" | "pages" = "sections";
/** Índice para o prompt estável (≈ 4365 tokens). */
export const KNOWLEDGE_INDEX: string = "## Dashboards\n- dashboards: Dashboards (Geral, Financeiro, Operações, Pessoas, Suporte) [/dashboards, /dashboard, /financeiro, /operacoes-dashboard, /pessoas-dashboard, /suporte-dashboard] — Os Dashboards (no topo do menu) juntam num só sítio os números de cada área: separadores Geral, Financeiro, Operações, Pessoas, Suporte e Marketing.\n  Quem vê os Dashboards · Geral · Financeiro · Operações · Pessoas · Suporte · Marketing\n- dashboards.entrada: Entrada, menu e \"Sem acesso\" [/, /modulos] — Entrar: \"Entrar com Google\" na página inicial.\n  Entrar com email e código · Entrar num PDA · Código por email · O que abre para quem\n## Financeiro\n- caixa: Caixa [/caixa] — Financeiro → Caixa (29c, 6 out 2026: \"uma coisa é faturação, outra coisa é caixa\").\n  Separadores · Por dia · Confirmação · Resumo · Correção de caixa · Passo a passo · Correção de caixa — casos · Contagem da caixa · Confirmar pagamentos · Preços iniciais · Correção de caixa — comparar um dia · Despesas do turno · Confirmação da caixa\n- despesas: Despesas [/despesas, /despesas/dashboard] — Registo de faturas e despesas da empresa.\n  Registar uma despesa · Lançar já paga · Escolher categoria, centro de custos e quem comprou · Despesas do turno · Lista · Resumo · Gerir · Despesas fixas · Falta a fatura · Notas de crédito · Para a contabilista · Faturas do Google / Meta\n- faturacao: Faturação [/faturacao, /faturacao/diagnose, /anual] — Receita, custos e margem por período (só super admin; o dashboard Financeiro, com a mesma base, é para admin e acima — ver a ajuda dos Dashboards → Financeiro).\n  Ler a página · Realizado · Custos detalhados · Previsão · Anual · Diagnóstico de Faturação\n- marketing: Marketing [/marketing, /marketing/google-ads, /marketing/canais, /marketing/orcamentos, /marketing/web] — Só super admin (ou quem tiver uma exceção de acesso ao Marketing).\n  Separadores · Canais e clientes · Orçamentos · Conversões e reservas, lado a lado\n- marketing.google-business: Google Business Profile (perfis Google: desempenho, horários, publicações) [/marketing/web] — Em Marketing → Web & SEO → Google Business vês o desempenho dos perfis Google de cada parque (Lisboa, Porto, Faro; Multipark, Redpark, Skypark, Airpark…\n  O que há no separador · Horários · Publicações · Alertas · Ligar e pôr a funcionar · 1. Pedir acesso à API do Business Profile · 2. Ativar as APIs no mesmo projeto · 3. Ligar a conta Google certa · 4. Testar\n- marketing.web: Web & SEO (Google Analytics 4, Search Console, PageSpeed) [/marketing/web] — Em Marketing → Web & SEO vês o tráfego dos sites (Google Analytics 4), a pesquisa orgânica do Google (Search Console) e a velocidade das páginas principais…\n  O que há no separador · Configurar · 1. Google Cloud · 2. Copiar o email da conta de serviço · 3. Dar acesso no Google Analytics 4 · 4. Dar acesso na Search Console · 5. Preencher as Definições · Problemas comuns\n- parcerias: Parcerias (parceiros, parques, Pró e avenças) [/parcerias, /parcerias/tipo/:tipo, /parcerias/inferir] — Menu Financeiro → Parcerias.\n  Separadores · Parceiros · Parques · Pró e avenças · Faturação · Parques nossos vindos pelo Marketplace · Fecho do mês · Análise · Registos · Inativos · Juntar registos · Ligar à Multipark · Notas\n- projetos: Projetos e custos por projeto [/projetos, /projetos/custos] — Os Projetos são a árvore de centros de custos: Grupo → Cidade → Marca → Projeto.\n  Gerir a árvore · Custos por projeto\n## Pessoas\n- avaliacao: Avaliação (dia e mês) [/avaliacao, /avaliacao-operacional] — A avaliação dos condutores e extras está numa só página: menu Pessoas → Avaliação.\n  De onde vêm os números · Separador Dia · Separador Mês · Pesquisar e filtrar o ranking · Como se contam os movimentos · Fecho do mês · A minha avaliação · Contestações · Quem vê o quê · Acidentes: −6000 pontos\n- condutores-agentes: Condutores e agentes [/pessoas/condutores-agentes] — Em Pessoas → Condutores e agentes.\n  Quem vê · Movimentos e mudanças de lugar · Condutores · Tempos de um condutor · Agentes · Desempenho · Quem entra nas contas do Desempenho · Como se contam os pontos desta aba · Telefonemas, emails e horas do dia · O detalhe de uma pessoa: de onde vem cada número · Excessos de velocidade · Quando a leitura falha\n- conhecimento: Pesquisa global (Ctrl+K) e Base de conhecimento [/formacao/conhecimento] — Uma só caixa para procurar em tudo o que podes ver: reservas, clientes e contactos, reclamações, emails, conversas de WhatsApp, tarefas, colaboradores…\n  Pesquisa global · Base de conhecimento · Onde estão os documentos · Gerir · Quem vê o quê · Perguntas de quiz a partir de um documento · Quiz e FAQs feitos a partir da base · Sem Drive nem IA\n- formacao: Formação [/formacao] — Formação obrigatória, vídeos, manuais, FAQs, quiz e exames de carreira.\n  Fazer a tua formação · Quiz · Carreira · FAQs · Formação e escala · Vídeos · Manuais · Percursos · Acompanhamento · Gestão\n- leads-extras: Leads de Extras (leads, candidaturas do site e recrutamento) [/extras-leads] — Cartões ou Lista (botão no topo da lista de leads e das candidaturas): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.\n  Leads · Candidaturas do site · Recrutamento · Entradas pela app\n- rh: RH e ponto [/rh, /rh/dashboard, /perfil] — Cartões ou Lista (botão no topo da lista): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.\n  Picar o ponto · Ponto de um mês · Folha de ordenados: ninguém fica de fora · \"Ainda estás no terminal?\" · Terminal: confirmar, corrigir ou desmarcar · A tua ficha · Com que conta a pessoa entra · Candidatos, inativos e desativados · Documentos: validar ou recusar · Pedir documentos em falta aos extras · Carta de condução · Notas internas · O supervisor no RH da sua cidade · O back office no RH · Gestão · Dashboard RH: possíveis faltas e detalhe por colaborador · Possíveis faltas por validar · Detalhe por colaborador · Ligações · Agentes da Multipark × pessoas · Uma pessoa: contas e agentes · Agente da Multipark na ficha · Comparar a lista de agentes da Multipark · Juntar contas · Juntar fichas da mesma pessoa · Agentes que não são pessoas · Agentes de teste · Fichas sem cidade\n## Operações\n- disponibilidade: Disponibilidade [/disponibilidade] — Onde os extras dizem em que dias e turnos podem trabalhar.\n  Os teus dias livres habituais · Marcar a tua disponibilidade · Gestão · Métricas dos extras\n- extras-dia: Extras-Dia [/extras-dia] — Planeamento do dia seguinte: chegadas, saídas, lavagens e quantos condutores são precisos por hora, e a escala dos extras.\n  Ver a previsão · Separador \"Pressão\" · Ler o mapa e onde aperta · Tempo por carro por condutor e carga × tempo de entrega · Notas do dia · De onde vêm os dados · De onde vêm os tempos · Diagnóstico dos tempos · Recolha pelo meio de uma entrega · Escalar a equipa · Proposta automática · Horas da escala automática, lembretes e novas tentativas · Quem vê o quê · Notas\n- operacional: Actividade Diária (quem fez o quê, GPS e PDAs) [/operacional] — Menu Operações → Actividade Diária: quem fez o quê nas reservas, o Resumo do dia, a Semana por hora, a Avaliação do mês, os km e as velocidades do GPS…\n  Que abas vês · Atividade do Dia · Resumo do dia · Entregas · O que se passava e quem trabalhou · Semana · Avaliação do mês · Histórico Diário · Ao Vivo · PDAs · Telemóveis pessoais · Rádio · Quando a leitura falha\n- operacoes: Reservas do dia (entradas e saídas) [/operacoes] — Uma só lista com as entradas (check-in) e as saídas (check-out) de um dia.\n  Reservas do dia · Onde · O dia · Cada linha · Que parques aparecem · Por cidade, por hora e por marca · Grupos: um por parque · Contadores e filtros\n- operacoes.listas: Reservas, Recolhas, Entregas e Cancelados (listas por período) [/operacoes] — Quatro listas por período, nas Operações → Reservas & Operações, ao lado de \"Reservas do dia\".\n  As quatro listas · Reservas · Recolhas · Entregas · Cancelados · Ler as listas · O período · Contadores e comparação · Porque é que o número é diferente do Dashboard? · Filtros e tabela · O Dashboard\n- passagem-turno: Passagem de turno [/passagem-turno] — Checklist de fim de turno dos team leaders e o histórico das passagens.\n  Preencher · Resumo IA para o turno seguinte · Pendentes que passam de turno · Resumo automático · Estado do parque · Alterações por gravar · Quando a leitura falha · Notas\n- radio: Rádio (gravações do Zello e transcrições) [/radio, /operacional] — Menu Operações → Actividade Diária, separador Rádio (o antigo endereço /radio vai lá ter).\n  Gravações do Zello · Guardar como prova · Provas · Transcrições · A lista · Nova transcrição · Quando a leitura falha\n- reserva: Ficha da reserva [/reserva] — Tudo sobre uma reserva num só sítio, lido em tempo real da base de dados da Multipark.\n  Abrir · O que mostra\n- servicos: Serviços [/servicos] — Menu Operações → Serviços: os serviços extra das reservas (lavagens, carregamentos elétricos, valet…) no período escolhido, com totais por tipo e por parque.\n  Limites e falhas · Tarefas automáticas dos serviços\n- tarefas: Tarefas [/tarefas] — As minhas tarefas\n  As minhas tarefas · Filtros · Criar e gerir · Checklists recorrentes · Avisos de atraso e conclusão · Aviso \"Nova tarefa para ti\" · Tarefas dos serviços das reservas · Tarefas de candidatura\n## Suporte\n- clientes: Clientes (CRM: fichas, filtros, juntar e separar) [/clientes, /clientes/rever] — Cada cliente tem uma ficha com o nosso n.º de cliente.\n  De onde vêm os clientes · Quando duas fichas são a mesma pessoa · Como uma reserva se liga a uma ficha · Lista · Ficha · O cliente nas outras páginas · Clientes Pro e conta corrente · Agregadores e agências · Parcerias · Rever fichas\n- contactos: Contactos (pesquisa, diretório e Google Contactos) [/contactos, /perfil] — Cartões ou Lista (botão no topo da lista): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.\n  Filtrar e ordenar por cima · Importar contactos · Pesquisa · Diretório · Os meus contactos Google · Grupo \"Multipark — Serviço\" no telemóvel · Configuração\n- criticas: Críticas Google [/criticas] — As avaliações do Google de todos os parques, juntas e separadas por parque, com a resposta preparada aqui.\n  De onde vêm · Parque, marca ou lixo · Dashboard · Reviews · Responder · Reclamações · Dispensar · Números · Quando a leitura falha · Emails que não são críticas e críticas repetidas · Respostas automáticas às 5★ · Limpeza · Quem pode\n- ocorrencias: Ocorrências [/ocorrencias] — As ocorrências registadas pelos agentes na app Multipark (vidro aberto, acidente, atraso…).\n  Ver e procurar · Fecham sozinhas ao fim de 3 dias · Resolver · Foi um acidente? · Quando a leitura falha · Avisos de ocorrência por email · Ocorrências antigas do dashboard\n- perdidos: Perdidos e Achados [/perdidos-achados] — Objetos esquecidos pelos clientes nos carros.\n  Registar · Por email · Tratar · Condutores do caso · Arquivar · Quando a leitura falha · Quem pode\n- reclamacoes: Reclamações [/reclamacoes] — Casos de clientes insatisfeitos (danos, sujidade, atraso, cobrança, staff…).\n  Criar · Reclamações que a IA vê noutras caixas · Filtros · Tratar · Prazo · Condutores · Fotos · Arquivar · Quando a leitura falha · Quem pode\n## Comunicação\n- central: Central (as minhas chamadas) [/central] — Menu Comunicação → Central.\n  Quem vê o quê · O que mostra · Quando a central toca no dashboard\n- comunicacao: Comunicação (email e calendário) [/comunicacao, /comunicacao/meu-email, /calendario] — Os emails das caixas partilhadas da empresa e o teu próprio email @multipark, dentro do dashboard.\n  Caixas de email · O resto da Comunicação · Caixas por tema · Ligar, WhatsApp e email a partir das fichas · Ligações · Emails que criam casos · Caixas · O meu email · Segurança · Quando a leitura falha · Calendário\n- comunicacao.aliases: Email por alias (encaminhamento, Por classificar e envio) [/definicoes, /comunicacao] — Todo o email passa pela API do Gmail — não há SMTP nem IMAP.\n  O Workspace real · Como o alias é lido · Preencher a tabela · Depois do alias: a triagem da IA · Por classificar · Envio · O que falta do lado do dono\n- drive: Google Drive, Docs e Sheets [/drive, /perfil] — Liga ficheiros do Google Drive aos registos, guarda anexos e documentos no teu Drive, gera documentos a partir de modelos Google Docs e exporta relatórios…\n  Abrir o Drive · Ativar o Drive · Anexar do Drive · Guardar no Drive · Gerar documento · Exportar para Sheets · Importar do Google Sheets · Configuração\n- whatsapp: WhatsApp [/whatsapp] — Caixa de entrada partilhada das conversas de WhatsApp com colaboradores e clientes.\n  Quem vê o quê · Começar uma conversa · Quem é · Responder · Estado de cada mensagem enviada · Mensagem \"sem confirmação\" · Templates por cidade · Respostas automáticas · Caixas por tema · Organizar · Conversas de colaboradores e a IA · A triagem propõe o caso · Ficheiros e localizações recebidos · Envios em massa · Respostas rápidas · Quando a leitura falha · Chamadas de voz\n- whatsapp.chamadas: WhatsApp — Chamadas de voz [/whatsapp] — Os clientes podem ligar para o número de WhatsApp da empresa e a chamada é atendida no dashboard, no browser (microfone e colunas/auscultadores do computador).\n  Atender · Aviso com o separador em segundo plano · Ligar / devolver uma chamada · Limites da Meta · Configuração · Quando a leitura falha · Problemas comuns\n## Sistema\n- api-keys: API Keys (chaves para o site, o MCP e os dispositivos) [/api-keys] — Página API Keys (menu Sistema, só super admin): as chaves que os programas de fora usam para falar com a dashboard — o site (candidaturas e disponibilidades)…\n  Criar e gerir as chaves · Documentação API\n- definicoes: Definições [/definicoes] — Quem entra: administradores e super admin (pela matriz de permissões, com as exceções por pessoa).\n  Estado · Automações · Integrações · Comunicação · Parâmetros · Aeroportos e zonas da operação · Garagens e tempos de entrega e de recolha · Extras-dia · Notificações · Segurança · Gravar ao mesmo tempo e histórico\n- definicoes.agendador: Agendador (tarefas automáticas) [/definicoes] — Todas as tarefas automáticas da app (sincronizar o Gmail, reservas Multipark, extras, recolha GPS do Zello, relatórios, Google Ads…) correm a partir de um só…\n  Configurar o cron-job.org · O que corre e quando · Ler o cartão \"Agendador\" · Corridas manuais\n- definicoes.google-tempo-real: Google em tempo real (Calendário, Drive, Tarefas e Contactos) [/definicoes, /perfil] — Desde 26 set 2026 a app já não pergunta à Google de 15 em 15 minutos se mudou alguma coisa.\n  O que muda no dashboard vai logo para o Google · Calendário e Drive: em tempo real · Tarefas e Contactos: enquanto tens o dashboard aberto · Rede de segurança: de 4 em 4 horas · Ver o estado · Configuração\n- definicoes.ia: Onde é que a IA trabalha no dashboard [/definicoes] — A IA escreve textos e sugere.\n  Só quando carregas no botão · Sozinha · Começam desligadas · Dados pessoais · Quanto a IA usa · Multis do piloto e o orçamento\n- integracoes: Integrações (estado das ligações externas) [/integracoes] — Página Integrações (menu Sistema): um cartão por ligação externa — Google Ads, Meta, Google Business, WhatsApp, Gmail, Google…\n  O que cada cartão diz · Testar · Central Vodafone · Xsi da One Net\n- integracoes.google-ads: Integrações → Google Ads e Meta Ads [/integracoes/google-ads] — Aqui liga-se o Google Ads, escolhem-se as contas a recolher e vê-se o histórico das recolhas.\n  Quem faz o quê · Contas · Recolhas automáticas · Cliques · Estados\n- logs: Logs (registo de atividade) [/logs] — Página Logs (menu Sistema): o registo do que se faz na plataforma — quem, quando, o quê e em que registo.\n  Quem fez\n- multis: Multis (o assistente de IA da equipa) [/multis/falhas, /perfil] — O Multis é o assistente de IA da Multipark dentro da aplicação.\n  O que lhe podes pedir · Regras · Memória · Avaliar respostas · Perguntas que falharam · O Multis sabe o que tens aberto · Piloto do Multis · Regras em vigor · Multis por página · Dados que o Multis lê\n- perfil: Perfil (foto, notificações, palavra-passe, sessões, contas Google) [/perfil] — O Perfil tem o teu cartão, atalhos e o que é só teu.\n  Atalhos · Este telemóvel · Foto · Notificações · Palavra-passe · Avisos no telemóvel · Contas Google · Terminar sessões noutros aparelhos\n- permissoes: Permissões [/permissoes, /utilizadores] — Utilizadores — Cartões ou Lista (botão no topo da lista de utilizadores): vês as contas em cartões com foto ou numa lista compacta — no telemóvel e no PC.\n  Utilizadores — agente e ligações · Página Permissões";

/** Estrutura da árvore (sem o texto das secções; `chars` = tamanho). O texto: knowledgeTree() em server/assistant/knowledgeTree.ts. */
export const KNOWLEDGE_OUTLINE: HelpTreeOutline = {
 "groups": [
  {
   "group": "Dashboards",
   "pages": [
    {
     "id": "dashboards",
     "file": "dashboards.md",
     "group": "Dashboards",
     "module": "dashboards",
     "title": "Dashboards (Geral, Financeiro, Operações, Pessoas, Suporte)",
     "routes": [
      "/dashboards",
      "/dashboard",
      "/financeiro",
      "/operacoes-dashboard",
      "/pessoas-dashboard",
      "/suporte-dashboard"
     ],
     "tabs": [
      {
       "tab": "geral",
       "section": "Geral",
       "sectionId": "dashboards.md#geral-o-resumo-de-hoje"
      },
      {
       "tab": "financeiro",
       "section": "Financeiro",
       "sectionId": "dashboards.md#financeiro-financeiro"
      },
      {
       "tab": "operacoes",
       "section": "Operações",
       "sectionId": "dashboards.md#operacoes-operacoes-dashboard"
      },
      {
       "tab": "pessoas",
       "section": "Pessoas",
       "sectionId": "dashboards.md#pessoas-pessoas-dashboard"
      },
      {
       "tab": "suporte",
       "section": "Suporte",
       "sectionId": "dashboards.md#suporte-suporte-dashboard"
      },
      {
       "tab": "marketing",
       "section": "Marketing",
       "sectionId": "dashboards.md#marketing-dashboards-marketing"
      }
     ],
     "summary": "Os Dashboards (no topo do menu) juntam num só sítio os números de cada área: separadores Geral, Financeiro, Operações, Pessoas, Suporte e Marketing.",
     "sections": [
      {
       "id": "dashboards.md#inicio",
       "file": "dashboards.md",
       "slug": "inicio",
       "title": "Dashboards (Geral, Financeiro, Operações, Pessoas, Suporte)",
       "level": 1,
       "summary": "Os Dashboards (no topo do menu) juntam num só sítio os números de cada área: separadores Geral, Financeiro, Operações, Pessoas, Suporte e Marketing.",
       "children": [],
       "container": false,
       "chars": 399
      },
      {
       "id": "dashboards.md#quem-ve-os-dashboards",
       "file": "dashboards.md",
       "slug": "quem-ve-os-dashboards",
       "title": "Quem vê os Dashboards",
       "level": 2,
       "summary": "A página Dashboards (permissão Dashboards) é de admin e super admin (ou de quem tenha essa permissão dada por pessoa, em Permissões).",
       "children": [],
       "container": false,
       "chars": 1520
      },
      {
       "id": "dashboards.md#geral-o-resumo-de-hoje",
       "file": "dashboards.md",
       "slug": "geral-o-resumo-de-hoje",
       "title": "Geral (o resumo de hoje)",
       "level": 2,
       "summary": "Os números de hoje, de relance, e atalhos para os outros dashboards.",
       "children": [],
       "container": false,
       "chars": 2566
      },
      {
       "id": "dashboards.md#financeiro-financeiro",
       "file": "dashboards.md",
       "slug": "financeiro-financeiro",
       "title": "Financeiro (/financeiro)",
       "level": 2,
       "summary": "Receita, custos e margem com a mesma base da Faturação: carros entregues (saída feita, CHECKED_OUT), sem IVA, no período escolhido.",
       "children": [],
       "container": false,
       "chars": 2398
      },
      {
       "id": "dashboards.md#operacoes-operacoes-dashboard",
       "file": "dashboards.md",
       "slug": "operacoes-operacoes-dashboard",
       "title": "Operações (/operacoes-dashboard)",
       "level": 2,
       "summary": "Visão geral operacional.",
       "children": [],
       "container": false,
       "chars": 1366
      },
      {
       "id": "dashboards.md#pessoas-pessoas-dashboard",
       "file": "dashboards.md",
       "slug": "pessoas-pessoas-dashboard",
       "title": "Pessoas (/pessoas-dashboard)",
       "level": 2,
       "summary": "RH, desempenho e formação.",
       "children": [],
       "container": false,
       "chars": 1441
      },
      {
       "id": "dashboards.md#suporte-suporte-dashboard",
       "file": "dashboards.md",
       "slug": "suporte-suporte-dashboard",
       "title": "Suporte (/suporte-dashboard)",
       "level": 2,
       "summary": "Reclamações, críticas Google, ocorrências e perdidos e achados.",
       "children": [],
       "container": false,
       "chars": 1376
      },
      {
       "id": "dashboards.md#marketing-dashboards-marketing",
       "file": "dashboards.md",
       "slug": "marketing-dashboards-marketing",
       "title": "Marketing (Dashboards → Marketing)",
       "level": 2,
       "summary": "O mesmo dashboard da página Marketing (só o super admin): ver a ajuda do Marketing.",
       "children": [],
       "container": false,
       "chars": 134
      }
     ]
    },
    {
     "id": "dashboards.entrada",
     "file": "entrada.md",
     "group": "Dashboards",
     "module": "dashboards",
     "title": "Entrada, menu e \"Sem acesso\"",
     "routes": [
      "/",
      "/modulos"
     ],
     "tabs": [],
     "summary": "Entrar: \"Entrar com Google\" na página inicial.",
     "sections": [
      {
       "id": "entrada.md#inicio",
       "file": "entrada.md",
       "slug": "inicio",
       "title": "Entrada, menu e \"Sem acesso\"",
       "level": 1,
       "summary": "Entrar: \"Entrar com Google\" na página inicial.",
       "children": [],
       "container": false,
       "chars": 385
      },
      {
       "id": "entrada.md#entrar-com-email-e-codigo-so-com-o-interruptor-entrar-com-em",
       "file": "entrada.md",
       "slug": "entrar-com-email-e-codigo-so-com-o-interruptor-entrar-com-em",
       "title": "Entrar com email e código (só com o interruptor Entrar com email e código ligado em Definições → Automações; vem desligado — desligado, entra-se só com a Google, como sempre)",
       "level": 2,
       "summary": "A página de entrada passa a ter Email, Palavra-passe e Entrar.",
       "children": [],
       "container": false,
       "chars": 2781
      },
      {
       "id": "entrada.md#entrar-num-pda-so-com-entrar-com-email-e-codigo-ligado-desli",
       "file": "entrada.md",
       "slug": "entrar-num-pda-so-com-entrar-com-email-e-codigo-ligado-desli",
       "title": "Entrar num PDA (só com Entrar com email e código ligado; desligado, os PDAs entram como sempre, com a Google)",
       "level": 2,
       "summary": "Num PDA registado (registado pelo QR) a sessão fica presa a esse PDA e acaba sozinha quando: dás saída do ponto (em qualquer aparelho, também no telemóvel)…",
       "children": [],
       "container": false,
       "chars": 1707
      },
      {
       "id": "entrada.md#codigo-por-email-definicao-codigo-de-entrada-vai-para-defini",
       "file": "entrada.md",
       "slug": "codigo-por-email-definicao-codigo-de-entrada-vai-para-defini",
       "title": "Código por email (definição Código de entrada vai para, Definições → Operação; vem em TL + supervisor de serviço)",
       "level": 2,
       "summary": "Com email, o código vai para o email da própria pessoa, enviado pela conta acesso@multipark.pt (uma conta só para isto, nunca uma caixa da Comunicação — se…",
       "children": [
        "entrada.md#o-que-abre-para-quem"
       ],
       "container": false,
       "chars": 3061
      },
      {
       "id": "entrada.md#o-que-abre-para-quem",
       "file": "entrada.md",
       "slug": "o-que-abre-para-quem",
       "title": "O que abre para quem",
       "level": 4,
       "summary": "O Perfil e o Menu abrem para todos, incluindo extras e condutores.",
       "children": [],
       "container": false,
       "chars": 1856
      }
     ]
    }
   ]
  },
  {
   "group": "Financeiro",
   "pages": [
    {
     "id": "caixa",
     "file": "caixa.md",
     "group": "Financeiro",
     "module": "caixa",
     "title": "Caixa",
     "routes": [
      "/caixa"
     ],
     "tabs": [
      {
       "tab": "dia",
       "section": "Por dia",
       "sectionId": "caixa.md#por-dia-abre-aqui-por-omissao-a-ultima-caixa-ja-fechada"
      },
      {
       "tab": "confirmacao",
       "section": "Confirmação da caixa",
       "sectionId": "caixa.md#confirmacao-da-caixa"
      },
      {
       "tab": "resumo",
       "section": "Resumo",
       "sectionId": "caixa.md#resumo"
      },
      {
       "tab": "correcao",
       "section": "Correção de caixa — casos",
       "sectionId": "caixa.md#correcao-de-caixa-casos"
      }
     ],
     "summary": "Financeiro → Caixa (29c, 6 out 2026: \"uma coisa é faturação, outra coisa é caixa\").",
     "sections": [
      {
       "id": "caixa.md#inicio",
       "file": "caixa.md",
       "slug": "inicio",
       "title": "Caixa",
       "level": 1,
       "summary": "Financeiro → Caixa (29c, 6 out 2026: \"uma coisa é faturação, outra coisa é caixa\").",
       "children": [],
       "container": false,
       "chars": 363
      },
      {
       "id": "caixa.md#separadores",
       "file": "caixa.md",
       "slug": "separadores",
       "title": "Separadores",
       "level": 2,
       "summary": "",
       "children": [
        "caixa.md#por-dia-abre-aqui-por-omissao-a-ultima-caixa-ja-fechada",
        "caixa.md#confirmacao-13-out-2026",
        "caixa.md#resumo",
        "caixa.md#correcao-de-caixa"
       ],
       "container": true,
       "chars": 0
      },
      {
       "id": "caixa.md#por-dia-abre-aqui-por-omissao-a-ultima-caixa-ja-fechada",
       "file": "caixa.md",
       "slug": "por-dia-abre-aqui-por-omissao-a-ultima-caixa-ja-fechada",
       "title": "Por dia (abre aqui; por omissão a última caixa já fechada)",
       "level": 3,
       "summary": "A caixa de cada dia por cidade, só nos parques que operamos.",
       "children": [],
       "container": false,
       "chars": 1367
      },
      {
       "id": "caixa.md#confirmacao-13-out-2026",
       "file": "caixa.md",
       "slug": "confirmacao-13-out-2026",
       "title": "Confirmação (13 out 2026)",
       "level": 3,
       "summary": "A confirmação da caixa reserva a reserva, por cidade e dia (03:00 → 03:00), só nos parques que operamos.",
       "children": [],
       "container": false,
       "chars": 145
      },
      {
       "id": "caixa.md#resumo",
       "file": "caixa.md",
       "slug": "resumo",
       "title": "Resumo",
       "level": 3,
       "summary": "O dinheiro no período — recebido (por método de pagamento), por cobrar, no-shows pré-pagos e canceladas com pagamento (só informativo).",
       "children": [],
       "container": false,
       "chars": 191
      },
      {
       "id": "caixa.md#correcao-de-caixa",
       "file": "caixa.md",
       "slug": "correcao-de-caixa",
       "title": "Correção de caixa",
       "level": 3,
       "summary": "Casos da varredura automática, contagem da caixa por parque e dia, multibanco do dia (talões), confirmar pagamentos (Stripe, Viva, fim do mês), preços…",
       "children": [],
       "container": false,
       "chars": 185
      },
      {
       "id": "caixa.md#passo-a-passo",
       "file": "caixa.md",
       "slug": "passo-a-passo",
       "title": "Passo a passo",
       "level": 2,
       "summary": "",
       "children": [
        "caixa.md#correcao-de-caixa-casos",
        "caixa.md#contagem-da-caixa",
        "caixa.md#confirmar-pagamentos-online-multibanco-e-fim-do-mes",
        "caixa.md#precos-iniciais-historico-da-multipark",
        "caixa.md#correcao-de-caixa-comparar-um-dia",
        "caixa.md#despesas-do-turno-passagem-de-turno",
        "caixa.md#confirmacao-da-caixa"
       ],
       "container": true,
       "chars": 0
      },
      {
       "id": "caixa.md#correcao-de-caixa-casos",
       "file": "caixa.md",
       "slug": "correcao-de-caixa-casos",
       "title": "Correção de caixa — casos",
       "level": 4,
       "summary": "No topo do separador Correção de caixa está a fila Casos da varredura automática (por explicar, por defeito), com as gravidades em cima.",
       "children": [],
       "container": false,
       "chars": 1421
      },
      {
       "id": "caixa.md#contagem-da-caixa",
       "file": "caixa.md",
       "slug": "contagem-da-caixa",
       "title": "Contagem da caixa",
       "level": 4,
       "summary": "Em Contagem da caixa escolhe o parque e o dia.",
       "children": [],
       "container": false,
       "chars": 707
      },
      {
       "id": "caixa.md#confirmar-pagamentos-online-multibanco-e-fim-do-mes",
       "file": "caixa.md",
       "slug": "confirmar-pagamentos-online-multibanco-e-fim-do-mes",
       "title": "Confirmar pagamentos (online, multibanco e fim do mês)",
       "level": 4,
       "summary": "Online (Stripe): todos os dias (a partir das 07:00), as saídas de ontem e anteontem pagas online são confirmadas na própria Multipark: tem de lá estar o…",
       "children": [],
       "container": false,
       "chars": 2571
      },
      {
       "id": "caixa.md#precos-iniciais-historico-da-multipark",
       "file": "caixa.md",
       "slug": "precos-iniciais-historico-da-multipark",
       "title": "Preços iniciais (histórico da Multipark)",
       "level": 4,
       "summary": "Em Correção de caixa, no cartão Preços iniciais, carrega o CSV exportado do histórico da Multipark (reservas.csv: o preço com que cada reserva foi criada).",
       "children": [],
       "container": false,
       "chars": 671
      },
      {
       "id": "caixa.md#correcao-de-caixa-comparar-um-dia",
       "file": "caixa.md",
       "slug": "correcao-de-caixa-comparar-um-dia",
       "title": "Correção de caixa — comparar um dia",
       "level": 4,
       "summary": "Separador Correção de caixa.",
       "children": [],
       "container": false,
       "chars": 3401
      },
      {
       "id": "caixa.md#despesas-do-turno-passagem-de-turno",
       "file": "caixa.md",
       "slug": "despesas-do-turno-passagem-de-turno",
       "title": "Despesas do turno (Passagem de turno)",
       "level": 4,
       "summary": "Na Passagem de turno, em Valores, o cartão Despesas do turno: tira a foto do talão (a IA lê-o e preenche descrição, valor, fornecedor, NIF, n.º, data, IVA e…",
       "children": [],
       "container": false,
       "chars": 665
      },
      {
       "id": "caixa.md#confirmacao-da-caixa",
       "file": "caixa.md",
       "slug": "confirmacao-da-caixa",
       "title": "Confirmação da caixa",
       "level": 4,
       "summary": "Team leader (fim do turno): fecha a caixa na Multipark e depois, na Passagem de turno → Fecho da caixa do turno, escreve o dinheiro recebido dos condutores…",
       "children": [],
       "container": false,
       "chars": 3296
      }
     ]
    },
    {
     "id": "despesas",
     "file": "despesas.md",
     "group": "Financeiro",
     "module": "despesas",
     "title": "Despesas",
     "routes": [
      "/despesas",
      "/despesas/dashboard"
     ],
     "tabs": [
      {
       "tab": "lista",
       "section": "Lista",
       "sectionId": "despesas.md#lista"
      },
      {
       "tab": "resumo",
       "section": "Resumo",
       "sectionId": "despesas.md#resumo"
      }
     ],
     "summary": "Registo de faturas e despesas da empresa.",
     "sections": [
      {
       "id": "despesas.md#inicio",
       "file": "despesas.md",
       "slug": "inicio",
       "title": "Despesas",
       "level": 1,
       "summary": "Registo de faturas e despesas da empresa.",
       "children": [],
       "container": false,
       "chars": 41
      },
      {
       "id": "despesas.md#registar-uma-despesa",
       "file": "despesas.md",
       "slug": "registar-uma-despesa",
       "title": "Registar uma despesa",
       "level": 4,
       "summary": "Menu Financeiro → Despesas → Nova Despesa.",
       "children": [],
       "container": false,
       "chars": 466
      },
      {
       "id": "despesas.md#lancar-ja-paga-so-admin-e-super-admin",
       "file": "despesas.md",
       "slug": "lancar-ja-paga-so-admin-e-super-admin",
       "title": "Lançar já paga (só admin e super admin)",
       "level": 4,
       "summary": "Para o admin e o super admin o Método de Pagamento começa em — sem método —.",
       "children": [],
       "container": false,
       "chars": 985
      },
      {
       "id": "despesas.md#escolher-categoria-centro-de-custos-e-quem-comprou",
       "file": "despesas.md",
       "slug": "escolher-categoria-centro-de-custos-e-quem-comprou",
       "title": "Escolher categoria, centro de custos e quem comprou",
       "level": 4,
       "summary": "Categoria e Funcionário (quem comprou) têm uma barra de pesquisa no topo: escreve e salta para a certa (não contam acentos nem maiúsculas).",
       "children": [],
       "container": false,
       "chars": 941
      },
      {
       "id": "despesas.md#despesas-do-turno-team-leaders",
       "file": "despesas.md",
       "slug": "despesas-do-turno-team-leaders",
       "title": "Despesas do turno (team leaders)",
       "level": 4,
       "summary": "As despesas pagas com o dinheiro da caixa lançam-se na Passagem de turno (cartão Despesas do turno), não aqui: foto do talão, a mesma leitura por IA, e entram…",
       "children": [],
       "container": false,
       "chars": 407
      },
      {
       "id": "despesas.md#lista",
       "file": "despesas.md",
       "slug": "lista",
       "title": "Lista",
       "level": 4,
       "summary": "Abre na semana atual.",
       "children": [],
       "container": false,
       "chars": 419
      },
      {
       "id": "despesas.md#resumo",
       "file": "despesas.md",
       "slug": "resumo",
       "title": "Resumo",
       "level": 4,
       "summary": "Separador Resumo: total do ano, pendentes e em atraso (de sempre), pago no ano, despesas dos últimos 6 meses, por categoria (este mês) e os pagamentos dos…",
       "children": [],
       "container": false,
       "chars": 243
      },
      {
       "id": "despesas.md#gerir-admin",
       "file": "despesas.md",
       "slug": "gerir-admin",
       "title": "Gerir (admin)",
       "level": 4,
       "summary": "Na linha: Marcar como paga (fica paga hoje), Editar (valores, datas, estado, data de pagamento) e, só o super admin, Eliminar.",
       "children": [],
       "container": false,
       "chars": 878
      },
      {
       "id": "despesas.md#despesas-fixas-recorrentes",
       "file": "despesas.md",
       "slug": "despesas-fixas-recorrentes",
       "title": "Despesas fixas (recorrentes)",
       "level": 4,
       "summary": "Cada modelo lança uma despesa por mês, no dia indicado (o processo diário corre de madrugada).",
       "children": [],
       "container": false,
       "chars": 627
      },
      {
       "id": "despesas.md#falta-a-fatura",
       "file": "despesas.md",
       "slug": "falta-a-fatura",
       "title": "Falta a fatura",
       "level": 4,
       "summary": "Qualquer despesa sem fatura (não cancelada) mostra \"Falta a fatura\" e o botão 📎 para a anexar (abre a edição).",
       "children": [],
       "container": false,
       "chars": 374
      },
      {
       "id": "despesas.md#notas-de-credito",
       "file": "despesas.md",
       "slug": "notas-de-credito",
       "title": "Notas de crédito",
       "level": 4,
       "summary": "Quando uma fatura (já paga ou não) tem uma nota de crédito do fornecedor (ex.: devolveram parte das peças): na linha da fatura, botão Nota de crédito (ícone…",
       "children": [],
       "container": false,
       "chars": 1322
      },
      {
       "id": "despesas.md#para-a-contabilista-zip-do-mes",
       "file": "despesas.md",
       "slug": "para-a-contabilista-zip-do-mes",
       "title": "Para a contabilista (ZIP do mês)",
       "level": 4,
       "summary": "Em Mais ações (⋯) → Para a contabilista (ZIP do mês), escolhe o mês (por omissão o mês passado) e carrega em Gerar ZIP.",
       "children": [],
       "container": false,
       "chars": 1590
      },
      {
       "id": "despesas.md#faturas-do-google-meta-anuncios",
       "file": "despesas.md",
       "slug": "faturas-do-google-meta-anuncios",
       "title": "Faturas do Google / Meta (anúncios)",
       "level": 4,
       "summary": "Quando o fornecedor é o Google ou a Meta (pelo nome ou pelo NIF), o formulário pede o período de consumo (de / até) — a fatura costuma cobrir os 60 a 90 dias…",
       "children": [],
       "container": false,
       "chars": 580
      }
     ]
    },
    {
     "id": "faturacao",
     "file": "faturacao.md",
     "group": "Financeiro",
     "module": "faturacao",
     "title": "Faturação",
     "routes": [
      "/faturacao",
      "/faturacao/diagnose",
      "/anual"
     ],
     "tabs": [
      {
       "tab": "real",
       "section": "Realizado",
       "sectionId": "faturacao.md#realizado"
      },
      {
       "tab": "costs",
       "section": "Custos detalhados",
       "sectionId": "faturacao.md#custos-detalhados"
      },
      {
       "tab": "forecast",
       "section": "Previsão",
       "sectionId": "faturacao.md#previsao"
      }
     ],
     "summary": "Receita, custos e margem por período (só super admin; o dashboard Financeiro, com a mesma base, é para admin e acima — ver a ajuda dos Dashboards → Financeiro).",
     "sections": [
      {
       "id": "faturacao.md#inicio",
       "file": "faturacao.md",
       "slug": "inicio",
       "title": "Faturação",
       "level": 1,
       "summary": "Receita, custos e margem por período (só super admin; o dashboard Financeiro, com a mesma base, é para admin e acima — ver a ajuda dos Dashboards → Financeiro).",
       "children": [],
       "container": false,
       "chars": 899
      },
      {
       "id": "faturacao.md#ler-a-pagina",
       "file": "faturacao.md",
       "slug": "ler-a-pagina",
       "title": "Ler a página",
       "level": 2,
       "summary": "Menu Financeiro → Faturação.",
       "children": [
        "faturacao.md#realizado",
        "faturacao.md#custos-detalhados",
        "faturacao.md#previsao"
       ],
       "container": false,
       "chars": 256
      },
      {
       "id": "faturacao.md#realizado",
       "file": "faturacao.md",
       "slug": "realizado",
       "title": "Realizado",
       "level": 3,
       "summary": "receita (com e sem IVA), entregues, comissões, custos e margem realizada até hoje.",
       "children": [],
       "container": false,
       "chars": 82
      },
      {
       "id": "faturacao.md#custos-detalhados",
       "file": "faturacao.md",
       "slug": "custos-detalhados",
       "title": "Custos detalhados",
       "level": 3,
       "summary": "despesas, salários, equipa do dia, parceiros.",
       "children": [],
       "container": false,
       "chars": 1013
      },
      {
       "id": "faturacao.md#previsao",
       "file": "faturacao.md",
       "slug": "previsao",
       "title": "Previsão",
       "level": 3,
       "summary": "Fecho previsto = realizado + receita esperada − custos do período inteiro.",
       "children": [],
       "container": false,
       "chars": 305
      },
      {
       "id": "faturacao.md#anual-anual",
       "file": "faturacao.md",
       "slug": "anual-anual",
       "title": "Anual (/anual)",
       "level": 2,
       "summary": "Anual mostra o ano mês a mês, com o mesmo motor da Faturação: receita, despesas (com a TSU paga), comissões, ordenados e equipa do dia (os meses importados do…",
       "children": [],
       "container": false,
       "chars": 1140
      },
      {
       "id": "faturacao.md#diagnostico-de-faturacao-faturacao-diagnose",
       "file": "faturacao.md",
       "slug": "diagnostico-de-faturacao-faturacao-diagnose",
       "title": "Diagnóstico de Faturação (/faturacao/diagnose)",
       "level": 2,
       "summary": "Serve para perceber porque é que um total da receita não bate: soma a receita com filtros que se vão juntando, um a um, para se ver em que passo o número muda.",
       "children": [],
       "container": false,
       "chars": 1622
      }
     ]
    },
    {
     "id": "marketing",
     "file": "marketing.md",
     "group": "Financeiro",
     "module": "marketing",
     "title": "Marketing",
     "routes": [
      "/marketing",
      "/marketing/google-ads",
      "/marketing/canais",
      "/marketing/orcamentos",
      "/marketing/web"
     ],
     "tabs": [],
     "summary": "Só super admin (ou quem tiver uma exceção de acesso ao Marketing).",
     "sections": [
      {
       "id": "marketing.md#inicio",
       "file": "marketing.md",
       "slug": "inicio",
       "title": "Marketing",
       "level": 1,
       "summary": "Só super admin (ou quem tiver uma exceção de acesso ao Marketing).",
       "children": [],
       "container": false,
       "chars": 448
      },
      {
       "id": "marketing.md#separadores",
       "file": "marketing.md",
       "slug": "separadores",
       "title": "Separadores",
       "level": 4,
       "summary": "Dashboard: visão geral do marketing no período.",
       "children": [],
       "container": false,
       "chars": 1247
      },
      {
       "id": "marketing.md#canais-e-clientes",
       "file": "marketing.md",
       "slug": "canais-e-clientes",
       "title": "Canais e clientes",
       "level": 4,
       "summary": "O grupo Anúncios (Google + Meta) — clientes novos junta as reservas de clientes novos nos canais próprios; o custo é o gasto do Google Ads e da Meta.",
       "children": [],
       "container": false,
       "chars": 1017
      },
      {
       "id": "marketing.md#orcamentos",
       "file": "marketing.md",
       "slug": "orcamentos",
       "title": "Orçamentos",
       "level": 4,
       "summary": "Regra 20 % (Jorge, 6 out 2026): o orçamento do Google Ads de cada marca/cidade é 20 % da faturação do mês anterior dessa marca/cidade (reservas concluídas…",
       "children": [],
       "container": false,
       "chars": 5913
      },
      {
       "id": "marketing.md#conversoes-e-reservas-lado-a-lado-dashboard-anuncios-por-mar",
       "file": "marketing.md",
       "slug": "conversoes-e-reservas-lado-a-lado-dashboard-anuncios-por-mar",
       "title": "Conversões e reservas, lado a lado (Dashboard, Anúncios por marca e por marca/cidade)",
       "level": 2,
       "summary": "Conversões (Google + Meta): o que cada plataforma conta (Google à parte, Meta à parte).",
       "children": [],
       "container": false,
       "chars": 3224
      }
     ]
    },
    {
     "id": "marketing.google-business",
     "file": "google-business.md",
     "group": "Financeiro",
     "module": "marketing",
     "title": "Google Business Profile (perfis Google: desempenho, horários, publicações)",
     "routes": [
      "/marketing/web"
     ],
     "tabs": [],
     "summary": "Em Marketing → Web & SEO → Google Business vês o desempenho dos perfis Google de cada parque (Lisboa, Porto, Faro; Multipark, Redpark, Skypark, Airpark…",
     "sections": [
      {
       "id": "google-business.md#inicio",
       "file": "google-business.md",
       "slug": "inicio",
       "title": "Google Business Profile (perfis Google: desempenho, horários, publicações)",
       "level": 1,
       "summary": "Em Marketing → Web & SEO → Google Business vês o desempenho dos perfis Google de cada parque (Lisboa, Porto, Faro; Multipark, Redpark, Skypark, Airpark…",
       "children": [],
       "container": false,
       "chars": 344
      },
      {
       "id": "google-business.md#o-que-ha-no-separador",
       "file": "google-business.md",
       "slug": "o-que-ha-no-separador",
       "title": "O que há no separador",
       "level": 4,
       "summary": "KPIs do período com a variação face ao período anterior ou ao ano passado: impressões (Pesquisa + Maps), chamadas, pedidos de direções, cliques no site (e…",
       "children": [],
       "container": false,
       "chars": 944
      },
      {
       "id": "google-business.md#horarios-icone-do-calendario-na-linha-do-perfil",
       "file": "google-business.md",
       "slug": "horarios-icone-do-calendario-na-linha-do-perfil",
       "title": "Horários (ícone do calendário na linha do perfil)",
       "level": 2,
       "summary": "O horário é lido na hora do Google.",
       "children": [],
       "container": false,
       "chars": 591
      },
      {
       "id": "google-business.md#publicacoes-icone-do-megafone",
       "file": "google-business.md",
       "slug": "publicacoes-icone-do-megafone",
       "title": "Publicações (ícone do megafone)",
       "level": 2,
       "summary": "Vês as publicações do perfil e podes apagá-las (com confirmação).",
       "children": [],
       "container": false,
       "chars": 747
      },
      {
       "id": "google-business.md#alertas-1-dia-depois-da-recolha-limiares-em-configurar",
       "file": "google-business.md",
       "slug": "alertas-1-dia-depois-da-recolha-limiares-em-configurar",
       "title": "Alertas (1×/dia depois da recolha; limiares em Configurar)",
       "level": 2,
       "summary": "\"Críticas Google: alertas\" (vai a quem gere as Críticas da cidade do perfil): média de estrelas dos últimos 7 dias 0,5★ abaixo da dos 90 dias anteriores (com…",
       "children": [],
       "container": false,
       "chars": 708
      },
      {
       "id": "google-business.md#ligar-e-por-a-funcionar-dono-super-admin",
       "file": "google-business.md",
       "slug": "ligar-e-por-a-funcionar-dono-super-admin",
       "title": "Ligar e pôr a funcionar (dono / super admin)",
       "level": 2,
       "summary": "A recolha usa a mesma ligação das Críticas (OAuth com a permissão business.manage).",
       "children": [
        "google-business.md#1-pedir-acesso-a-api-do-business-profile-obrigatorio-sem-ist",
        "google-business.md#2-ativar-as-apis-no-mesmo-projeto-google-cloud-apis-e-servic"
       ],
       "container": false,
       "chars": 175
      },
      {
       "id": "google-business.md#1-pedir-acesso-a-api-do-business-profile-obrigatorio-sem-ist",
       "file": "google-business.md",
       "slug": "1-pedir-acesso-a-api-do-business-profile-obrigatorio-sem-ist",
       "title": "1. Pedir acesso à API do Business Profile (obrigatório — sem isto a quota é 0)",
       "level": 4,
       "summary": "A Google começa todos os projetos com 0 pedidos por minuto nas APIs do Business Profile.",
       "children": [],
       "container": false,
       "chars": 1252
      },
      {
       "id": "google-business.md#2-ativar-as-apis-no-mesmo-projeto-google-cloud-apis-e-servic",
       "file": "google-business.md",
       "slug": "2-ativar-as-apis-no-mesmo-projeto-google-cloud-apis-e-servic",
       "title": "2. Ativar as APIs no mesmo projeto (Google Cloud → APIs e serviços → Biblioteca)",
       "level": 3,
       "summary": "My Business Account Management API — lista as contas.",
       "children": [
        "google-business.md#3-ligar-a-conta-google-certa",
        "google-business.md#4-testar"
       ],
       "container": false,
       "chars": 382
      },
      {
       "id": "google-business.md#3-ligar-a-conta-google-certa",
       "file": "google-business.md",
       "slug": "3-ligar-a-conta-google-certa",
       "title": "3. Ligar a conta Google certa",
       "level": 4,
       "summary": "Só o super admin liga e desliga (o admin vê o estado e gere os perfis).",
       "children": [],
       "container": false,
       "chars": 421
      },
      {
       "id": "google-business.md#4-testar",
       "file": "google-business.md",
       "slug": "4-testar",
       "title": "4. Testar",
       "level": 4,
       "summary": "Em Integrações → Google Business Profile → Testar (ou \"Testar APIs\" no separador Google Business) cada API é testada por ordem e aparece ✓/✗ com a causa:",
       "children": [],
       "container": false,
       "chars": 1725
      }
     ]
    },
    {
     "id": "marketing.web",
     "file": "web-analytics.md",
     "group": "Financeiro",
     "module": "marketing",
     "title": "Web & SEO (Google Analytics 4, Search Console, PageSpeed)",
     "routes": [
      "/marketing/web"
     ],
     "tabs": [],
     "summary": "Em Marketing → Web & SEO vês o tráfego dos sites (Google Analytics 4), a pesquisa orgânica do Google (Search Console) e a velocidade das páginas principais…",
     "sections": [
      {
       "id": "web-analytics.md#inicio",
       "file": "web-analytics.md",
       "slug": "inicio",
       "title": "Web & SEO (Google Analytics 4, Search Console, PageSpeed)",
       "level": 1,
       "summary": "Em Marketing → Web & SEO vês o tráfego dos sites (Google Analytics 4), a pesquisa orgânica do Google (Search Console) e a velocidade das páginas principais…",
       "children": [],
       "container": false,
       "chars": 280
      },
      {
       "id": "web-analytics.md#o-que-ha-no-separador",
       "file": "web-analytics.md",
       "slug": "o-que-ha-no-separador",
       "title": "O que há no separador",
       "level": 4,
       "summary": "KPIs do período escolhido com a variação face ao período anterior ou ao mesmo período do ano passado (seta e percentagem; na posição média, descer é bom).",
       "children": [],
       "container": false,
       "chars": 2191
      },
      {
       "id": "web-analytics.md#configurar-super-admin",
       "file": "web-analytics.md",
       "slug": "configurar-super-admin",
       "title": "Configurar (super admin)",
       "level": 2,
       "summary": "",
       "children": [
        "web-analytics.md#1-google-cloud-projeto-da-conta-de-servico-que-a-app-ja-usa",
        "web-analytics.md#3-dar-acesso-no-google-analytics-4-em-cada-propriedade",
        "web-analytics.md#4-dar-acesso-na-search-console-em-cada-propriedade",
        "web-analytics.md#5-preencher-as-definicoes-definicoes-integracoes-web-seo"
       ],
       "container": true,
       "chars": 0
      },
      {
       "id": "web-analytics.md#1-google-cloud-projeto-da-conta-de-servico-que-a-app-ja-usa",
       "file": "web-analytics.md",
       "slug": "1-google-cloud-projeto-da-conta-de-servico-que-a-app-ja-usa",
       "title": "1. Google Cloud (projeto da conta de serviço que a app já usa — a do Gmail/Drive)",
       "level": 3,
       "summary": "Abre console.cloud.google.com → APIs e serviços → Biblioteca.",
       "children": [
        "web-analytics.md#2-copiar-o-email-da-conta-de-servico"
       ],
       "container": false,
       "chars": 538
      },
      {
       "id": "web-analytics.md#2-copiar-o-email-da-conta-de-servico",
       "file": "web-analytics.md",
       "slug": "2-copiar-o-email-da-conta-de-servico",
       "title": "2. Copiar o email da conta de serviço",
       "level": 4,
       "summary": "Em Definições → Integrações → Web & SEO aparece o email da conta de serviço (termina em .iam.gserviceaccount.com) com um botão para copiar.",
       "children": [],
       "container": false,
       "chars": 145
      },
      {
       "id": "web-analytics.md#3-dar-acesso-no-google-analytics-4-em-cada-propriedade",
       "file": "web-analytics.md",
       "slug": "3-dar-acesso-no-google-analytics-4-em-cada-propriedade",
       "title": "3. Dar acesso no Google Analytics 4 (em cada propriedade)",
       "level": 3,
       "summary": "Abre analytics.google.com e escolhe a propriedade.",
       "children": [],
       "container": false,
       "chars": 431
      },
      {
       "id": "web-analytics.md#4-dar-acesso-na-search-console-em-cada-propriedade",
       "file": "web-analytics.md",
       "slug": "4-dar-acesso-na-search-console-em-cada-propriedade",
       "title": "4. Dar acesso na Search Console (em cada propriedade)",
       "level": 3,
       "summary": "Abre search.google.com/search-console e escolhe a propriedade.",
       "children": [],
       "container": false,
       "chars": 438
      },
      {
       "id": "web-analytics.md#5-preencher-as-definicoes-definicoes-integracoes-web-seo",
       "file": "web-analytics.md",
       "slug": "5-preencher-as-definicoes-definicoes-integracoes-web-seo",
       "title": "5. Preencher as Definições (Definições → Integrações → Web & SEO)",
       "level": 3,
       "summary": "Adiciona cada propriedade GA4 (ID, nome, marca) e cada propriedade da Search Console (nome exato, marca).",
       "children": [
        "web-analytics.md#problemas-comuns"
       ],
       "container": false,
       "chars": 1278
      },
      {
       "id": "web-analytics.md#problemas-comuns",
       "file": "web-analytics.md",
       "slug": "problemas-comuns",
       "title": "Problemas comuns",
       "level": 4,
       "summary": "\"Sem acesso\" / 403: a conta de serviço não foi adicionada à propriedade (passo 3 ou 4), foi adicionada à propriedade errada, ou a API não está ativa no Google…",
       "children": [],
       "container": false,
       "chars": 1040
      }
     ]
    },
    {
     "id": "parcerias",
     "file": "parcerias.md",
     "group": "Financeiro",
     "module": "parcerias",
     "title": "Parcerias (parceiros, parques, Pró e avenças)",
     "routes": [
      "/parcerias",
      "/parcerias/tipo/:tipo",
      "/parcerias/inferir"
     ],
     "tabs": [
      {
       "tab": "partners",
       "section": "Parceiros",
       "sectionId": "parcerias.md#parceiros"
      },
      {
       "tab": "parks",
       "section": "Parques",
       "sectionId": "parcerias.md#parques"
      },
      {
       "tab": "pro",
       "section": "Pró e avenças",
       "sectionId": "parcerias.md#pro-e-avencas"
      },
      {
       "tab": "summary",
       "section": "Faturação",
       "sectionId": "parcerias.md#faturacao"
      },
      {
       "tab": "fecho",
       "section": "Fecho do mês",
       "sectionId": "parcerias.md#fecho-do-mes"
      },
      {
       "tab": "analytics",
       "section": "Análise",
       "sectionId": "parcerias.md#analise"
      },
      {
       "tab": "management",
       "section": "Registos",
       "sectionId": "parcerias.md#registos"
      }
     ],
     "summary": "Menu Financeiro → Parcerias.",
     "sections": [
      {
       "id": "parcerias.md#inicio",
       "file": "parcerias.md",
       "slug": "inicio",
       "title": "Parcerias (parceiros, parques, Pró e avenças)",
       "level": 1,
       "summary": "Menu Financeiro → Parcerias.",
       "children": [],
       "container": false,
       "chars": 330
      },
      {
       "id": "parcerias.md#separadores",
       "file": "parcerias.md",
       "slug": "separadores",
       "title": "Separadores",
       "level": 2,
       "summary": "",
       "children": [
        "parcerias.md#parceiros",
        "parcerias.md#parques",
        "parcerias.md#pro-e-avencas",
        "parcerias.md#faturacao",
        "parcerias.md#parques-nossos-vindos-pelo-marketplace-regra-do-dono-6-out",
        "parcerias.md#fecho-do-mes",
        "parcerias.md#analise",
        "parcerias.md#registos"
       ],
       "container": true,
       "chars": 0
      },
      {
       "id": "parcerias.md#parceiros",
       "file": "parcerias.md",
       "slug": "parceiros",
       "title": "Parceiros",
       "level": 3,
       "summary": "Agências de viagens e agregadores dos nossos parques.",
       "children": [],
       "container": false,
       "chars": 946
      },
      {
       "id": "parcerias.md#parques",
       "file": "parcerias.md",
       "slug": "parques",
       "title": "Parques",
       "level": 3,
       "summary": "Nossos (reservas do mês, quantas vieram de parceiros, quantas pelo Marketplace — origem Marketplace —, valor) e Terceiros (marketplace): parques de outros em…",
       "children": [],
       "container": false,
       "chars": 837
      },
      {
       "id": "parcerias.md#pro-e-avencas",
       "file": "parcerias.md",
       "slug": "pro-e-avencas",
       "title": "Pró e avenças",
       "level": 3,
       "summary": "Só informativo (não é contabilidade): por cliente Pro e por avença, reservas a entrar (mês da entrada) e a sair (mês da saída), este mês e últimos 12 meses.",
       "children": [],
       "container": false,
       "chars": 264
      },
      {
       "id": "parcerias.md#faturacao",
       "file": "parcerias.md",
       "slug": "faturacao",
       "title": "Faturação",
       "level": 3,
       "summary": "O que há a faturar por registo nosso no período.",
       "children": [],
       "container": false,
       "chars": 715
      },
      {
       "id": "parcerias.md#parques-nossos-vindos-pelo-marketplace-regra-do-dono-6-out",
       "file": "parcerias.md",
       "slug": "parques-nossos-vindos-pelo-marketplace-regra-do-dono-6-out",
       "title": "Parques nossos vindos pelo Marketplace (regra do dono, 6 out)",
       "level": 3,
       "summary": "Uma reserva num parque nosso que a Multipark marca como vinda do Marketplace (origem Marketplace, ou a campanha \"Marketplace\") dá ao Marketplace 20 % do valor…",
       "children": [],
       "container": false,
       "chars": 865
      },
      {
       "id": "parcerias.md#fecho-do-mes",
       "file": "parcerias.md",
       "slug": "fecho-do-mes",
       "title": "Fecho do mês",
       "level": 3,
       "summary": "Como uma caixa, parceiro a parceiro: as reservas de parceiros concluídas com saída no mês na Multipark (agora) contra a nossa memória do webhook (o último…",
       "children": [],
       "container": false,
       "chars": 1615
      },
      {
       "id": "parcerias.md#analise",
       "file": "parcerias.md",
       "slug": "analise",
       "title": "Análise",
       "level": 3,
       "summary": "Reservas e receita por campanha no período.",
       "children": [],
       "container": false,
       "chars": 43
      },
      {
       "id": "parcerias.md#registos",
       "file": "parcerias.md",
       "slug": "registos",
       "title": "Registos",
       "level": 3,
       "summary": "Os nossos registos: acordo de faturação (contrato), comissão, NIF, notas e contacto (nome, email, telefone — só para quem tem contacto).",
       "children": [],
       "container": false,
       "chars": 444
      },
      {
       "id": "parcerias.md#inativos",
       "file": "parcerias.md",
       "slug": "inativos",
       "title": "Inativos",
       "level": 2,
       "summary": "Inativos: parceiros inativos (ou só em parques inativos), parques inativos na Multipark, Pros e avenças inativos e registos inativos não aparecem nas listas.",
       "children": [],
       "container": false,
       "chars": 294
      },
      {
       "id": "parcerias.md#juntar-registos-o-mesmo-parceiro-separado-em-varios-registos",
       "file": "parcerias.md",
       "slug": "juntar-registos-o-mesmo-parceiro-separado-em-varios-registos",
       "title": "Juntar registos (o mesmo parceiro separado em vários registos)",
       "level": 2,
       "summary": "Em Registos (ou na fila Por configurar), marca a caixa dos registos que são o mesmo parceiro (ex.: \"Pro Cabopol\" e \"Blocotelha\", da mesma agência, com o mesmo…",
       "children": [],
       "container": false,
       "chars": 1019
      },
      {
       "id": "parcerias.md#ligar-a-multipark-cartao-no-topo-dos-registos-aplicar-so-adm",
       "file": "parcerias.md",
       "slug": "ligar-a-multipark-cartao-no-topo-dos-registos-aplicar-so-adm",
       "title": "Ligar à Multipark (cartão no topo dos Registos; aplicar só administradores)",
       "level": 2,
       "summary": "A Multipark é a fonte: parceiros (agências e agregadores, com a taxa por parque), clientes Pro e avenças ficam cada um preso a um registo nosso pelo id de lá.",
       "children": [
        "parcerias.md#notas"
       ],
       "container": false,
       "chars": 1325
      },
      {
       "id": "parcerias.md#notas",
       "file": "parcerias.md",
       "slug": "notas",
       "title": "Notas",
       "level": 4,
       "summary": "Os valores em euros e as taxas só aparecem a quem vê totais financeiros.",
       "children": [],
       "container": false,
       "chars": 455
      }
     ]
    },
    {
     "id": "projetos",
     "file": "projetos.md",
     "group": "Financeiro",
     "module": "projetos",
     "title": "Projetos e custos por projeto",
     "routes": [
      "/projetos",
      "/projetos/custos"
     ],
     "tabs": [],
     "summary": "Os Projetos são a árvore de centros de custos: Grupo → Cidade → Marca → Projeto.",
     "sections": [
      {
       "id": "projetos.md#inicio",
       "file": "projetos.md",
       "slug": "inicio",
       "title": "Projetos e custos por projeto",
       "level": 1,
       "summary": "Os Projetos são a árvore de centros de custos: Grupo → Cidade → Marca → Projeto.",
       "children": [],
       "container": false,
       "chars": 168
      },
      {
       "id": "projetos.md#gerir-a-arvore-admin",
       "file": "projetos.md",
       "slug": "gerir-a-arvore-admin",
       "title": "Gerir a árvore (admin)",
       "level": 2,
       "summary": "Novo nó: nome, nível, pai, cor, gestor e Orçamento anual (€).",
       "children": [],
       "container": false,
       "chars": 337
      },
      {
       "id": "projetos.md#custos-por-projeto-botao-custos-admin",
       "file": "projetos.md",
       "slug": "custos-por-projeto-botao-custos-admin",
       "title": "Custos por projeto (botão Custos, admin)",
       "level": 2,
       "summary": "Mostra o custo realizado de cada nó no ano ou no mês escolhido, com as mesmas regras da Faturação, sem IVA:",
       "children": [],
       "container": false,
       "chars": 1234
      }
     ]
    }
   ]
  },
  {
   "group": "Pessoas",
   "pages": [
    {
     "id": "avaliacao",
     "file": "avaliacao.md",
     "group": "Pessoas",
     "module": "avaliacao",
     "title": "Avaliação (dia e mês)",
     "routes": [
      "/avaliacao",
      "/avaliacao-operacional"
     ],
     "tabs": [
      {
       "tab": "dia",
       "section": "Separador Dia",
       "sectionId": "avaliacao.md#separador-dia"
      },
      {
       "tab": "mes",
       "section": "Separador Mês",
       "sectionId": "avaliacao.md#separador-mes"
      },
      {
       "tab": "minha",
       "section": "A minha avaliação",
       "sectionId": "avaliacao.md#a-minha-avaliacao"
      },
      {
       "tab": "contestacoes",
       "section": "Contestações",
       "sectionId": "avaliacao.md#contestacoes"
      }
     ],
     "summary": "A avaliação dos condutores e extras está numa só página: menu Pessoas → Avaliação.",
     "sections": [
      {
       "id": "avaliacao.md#inicio",
       "file": "avaliacao.md",
       "slug": "inicio",
       "title": "Avaliação (dia e mês)",
       "level": 1,
       "summary": "A avaliação dos condutores e extras está numa só página: menu Pessoas → Avaliação.",
       "children": [],
       "container": false,
       "chars": 228
      },
      {
       "id": "avaliacao.md#de-onde-vem-os-numeros",
       "file": "avaliacao.md",
       "slug": "de-onde-vem-os-numeros",
       "title": "De onde vêm os números",
       "level": 4,
       "summary": "Movimentos: quem mexeu em que reserva, quando e em que fase.",
       "children": [],
       "container": false,
       "chars": 1696
      },
      {
       "id": "avaliacao.md#separador-dia",
       "file": "avaliacao.md",
       "slug": "separador-dia",
       "title": "Separador Dia",
       "level": 4,
       "summary": "Escolhe o dia.",
       "children": [],
       "container": false,
       "chars": 1889
      },
      {
       "id": "avaliacao.md#separador-mes",
       "file": "avaliacao.md",
       "slug": "separador-mes",
       "title": "Separador Mês",
       "level": 4,
       "summary": "O mesmo separador está também em Operações → Actividade Diária → Avaliação do mês (é uma cópia: o mesmo ecrã, os mesmos números e a mesma regra de acesso).",
       "children": [],
       "container": false,
       "chars": 1574
      },
      {
       "id": "avaliacao.md#pesquisar-e-filtrar-o-ranking-como-no-odoo",
       "file": "avaliacao.md",
       "slug": "pesquisar-e-filtrar-o-ranking-como-no-odoo",
       "title": "Pesquisar e filtrar o ranking (como no Odoo)",
       "level": 4,
       "summary": "Pesquisa: escreve o nome ou o n.º de agente e o ranking filtra-se logo.",
       "children": [],
       "container": false,
       "chars": 3435
      },
      {
       "id": "avaliacao.md#como-se-contam-os-movimentos",
       "file": "avaliacao.md",
       "slug": "como-se-contam-os-movimentos",
       "title": "Como se contam os movimentos",
       "level": 4,
       "summary": "Os dias calculados antes das regras de agora seguiam as regras antigas.",
       "children": [],
       "container": false,
       "chars": 4497
      },
      {
       "id": "avaliacao.md#fecho-do-mes-antes-de-pagar-os-premios",
       "file": "avaliacao.md",
       "slug": "fecho-do-mes-antes-de-pagar-os-premios",
       "title": "Fecho do mês (antes de pagar os prémios)",
       "level": 4,
       "summary": "Em Avaliação → Mês, por cima do ranking, aparece \"Fechado até DD/MM/AAAA\" quando há meses fechados.",
       "children": [],
       "container": false,
       "chars": 1700
      },
      {
       "id": "avaliacao.md#a-minha-avaliacao",
       "file": "avaliacao.md",
       "slug": "a-minha-avaliacao",
       "title": "A minha avaliação",
       "level": 4,
       "summary": "Separador A minha avaliação (extras, condutores e os papéis com a Avaliação; o papel utilizador não tem este módulo): os teus pontos no período, uma…",
       "children": [],
       "container": false,
       "chars": 1098
      },
      {
       "id": "avaliacao.md#contestacoes",
       "file": "avaliacao.md",
       "slug": "contestacoes",
       "title": "Contestações",
       "level": 4,
       "summary": "Separador Contestações (só quem gere a avaliação: supervisores, front e backoffice e a administração): as contestações por estado — Em análise, Aceites e…",
       "children": [],
       "container": false,
       "chars": 578
      },
      {
       "id": "avaliacao.md#quem-ve-o-que",
       "file": "avaliacao.md",
       "slug": "quem-ve-o-que",
       "title": "Quem vê o quê",
       "level": 4,
       "summary": "São as permissões de Definições → Permissões, iguais no ecrã e no servidor, com as permissões por utilizador.",
       "children": [],
       "container": false,
       "chars": 904
      },
      {
       "id": "avaliacao.md#acidentes-6000-pontos",
       "file": "avaliacao.md",
       "slug": "acidentes-6000-pontos",
       "title": "Acidentes: −6000 pontos",
       "level": 4,
       "summary": "Um acidente conta −6000 pontos a quem conduzia, no dia operacional da ocorrência.",
       "children": [],
       "container": false,
       "chars": 1281
      }
     ]
    },
    {
     "id": "condutores-agentes",
     "file": "condutores-agentes.md",
     "group": "Pessoas",
     "module": "condutores_agentes",
     "title": "Condutores e agentes",
     "routes": [
      "/pessoas/condutores-agentes"
     ],
     "tabs": [
      {
       "tab": "drivers",
       "section": "Condutores",
       "sectionId": "condutores-agentes.md#condutores"
      },
      {
       "tab": "agents",
       "section": "Agentes",
       "sectionId": "condutores-agentes.md#agentes"
      },
      {
       "tab": "performance",
       "section": "Desempenho",
       "sectionId": "condutores-agentes.md#desempenho-so-o-super-admin-os-outros-nem-veem-a-aba"
      }
     ],
     "summary": "Em Pessoas → Condutores e agentes.",
     "sections": [
      {
       "id": "condutores-agentes.md#inicio",
       "file": "condutores-agentes.md",
       "slug": "inicio",
       "title": "Condutores e agentes",
       "level": 1,
       "summary": "Em Pessoas → Condutores e agentes.",
       "children": [],
       "container": false,
       "chars": 66
      },
      {
       "id": "condutores-agentes.md#quem-ve-desde-14-out-2026",
       "file": "condutores-agentes.md",
       "slug": "quem-ve-desde-14-out-2026",
       "title": "Quem vê (desde 14 out 2026)",
       "level": 2,
       "summary": "Condutores e Agentes: supervisor (as cidades dele), back office, admin e super admin.",
       "children": [],
       "container": false,
       "chars": 826
      },
      {
       "id": "condutores-agentes.md#movimentos-e-mudancas-de-lugar-contam-se-assim-em-todo-o-lad",
       "file": "condutores-agentes.md",
       "slug": "movimentos-e-mudancas-de-lugar-contam-se-assim-em-todo-o-lad",
       "title": "Movimentos e mudanças de lugar (contam-se assim em todo o lado: aqui, na Avaliação, no Desempenho, na Atividade do dia e no Resumo do dia)",
       "level": 2,
       "summary": "Cada vez que um carro muda de sítio, a app Multipark grava duas linhas: o início e o fim.",
       "children": [
        "condutores-agentes.md#condutores"
       ],
       "container": false,
       "chars": 882
      },
      {
       "id": "condutores-agentes.md#condutores",
       "file": "condutores-agentes.md",
       "slug": "condutores",
       "title": "Condutores",
       "level": 4,
       "summary": "Uma linha por pessoa com as recolhas, entregas, movimentos, mudanças de lugar e os km do GPS (Zello) no período, lidos ao vivo da Multipark.",
       "children": [],
       "container": false,
       "chars": 770
      },
      {
       "id": "condutores-agentes.md#tempos-de-um-condutor-desde-15-out-2026",
       "file": "condutores-agentes.md",
       "slug": "tempos-de-um-condutor-desde-15-out-2026",
       "title": "Tempos de um condutor (desde 15 out 2026)",
       "level": 2,
       "summary": "Se durante meses os colegas entregam todos entre 13 e 17 min e um condutor demora sempre 20 a 30, é importante saber.",
       "children": [
        "condutores-agentes.md#agentes"
       ],
       "container": false,
       "chars": 2310
      },
      {
       "id": "condutores-agentes.md#agentes",
       "file": "condutores-agentes.md",
       "slug": "agentes",
       "title": "Agentes",
       "level": 4,
       "summary": "A mesma lista, com todas as ações de cada agente no período: recolhas, entregas, movimentos, mudanças de lugar, reservas em que mexeu e a última ação.",
       "children": [],
       "container": false,
       "chars": 1003
      },
      {
       "id": "condutores-agentes.md#desempenho-so-o-super-admin-os-outros-nem-veem-a-aba",
       "file": "condutores-agentes.md",
       "slug": "desempenho-so-o-super-admin-os-outros-nem-veem-a-aba",
       "title": "Desempenho (só o super admin; os outros nem veem a aba)",
       "level": 2,
       "summary": "Colunas: escolhe que colunas a tabela \"Toda a gente\" mostra, para caber no ecrã (fica guardado neste browser, por aba).",
       "children": [
        "condutores-agentes.md#quem-entra-nas-contas-do-desempenho",
        "condutores-agentes.md#como-se-contam-os-pontos-desta-aba",
        "condutores-agentes.md#telefonemas-emails-e-horas-do-dia"
       ],
       "container": false,
       "chars": 2945
      },
      {
       "id": "condutores-agentes.md#quem-entra-nas-contas-do-desempenho",
       "file": "condutores-agentes.md",
       "slug": "quem-entra-nas-contas-do-desempenho",
       "title": "Quem entra nas contas do Desempenho",
       "level": 3,
       "summary": "Cidade e marca: o filtro do topo.",
       "children": [],
       "container": false,
       "chars": 1869
      },
      {
       "id": "condutores-agentes.md#como-se-contam-os-pontos-desta-aba",
       "file": "condutores-agentes.md",
       "slug": "como-se-contam-os-pontos-desta-aba",
       "title": "Como se contam os pontos desta aba",
       "level": 3,
       "summary": "Como se contam os pontos desta aba: em cima, a régua e o que conta; a seguir, quanto vale cada coisa agora (com \"alterado\" ao lado do que já não é a omissão)…",
       "children": [],
       "container": false,
       "chars": 1902
      },
      {
       "id": "condutores-agentes.md#telefonemas-emails-e-horas-do-dia",
       "file": "condutores-agentes.md",
       "slug": "telefonemas-emails-e-horas-do-dia",
       "title": "Telefonemas, emails e horas do dia",
       "level": 3,
       "summary": "Telefonemas da central: contam quando a consola da Vodafone os regista na dashboard (Integrações → Central Vodafone), para quem atendeu ou ligou.",
       "children": [],
       "container": false,
       "chars": 2478
      },
      {
       "id": "condutores-agentes.md#o-detalhe-de-uma-pessoa-de-onde-vem-cada-numero-desempenho-c",
       "file": "condutores-agentes.md",
       "slug": "o-detalhe-de-uma-pessoa-de-onde-vem-cada-numero-desempenho-c",
       "title": "O detalhe de uma pessoa: de onde vem cada número (Desempenho → clicar na linha)",
       "level": 2,
       "summary": "Horas trabalhadas: o ponto (sem os registos suspeitos); sem ponto, a escala.",
       "children": [
        "condutores-agentes.md#excessos-de-velocidade-gps-do-zello",
        "condutores-agentes.md#quando-a-leitura-falha"
       ],
       "container": false,
       "chars": 2013
      },
      {
       "id": "condutores-agentes.md#excessos-de-velocidade-gps-do-zello",
       "file": "condutores-agentes.md",
       "slug": "excessos-de-velocidade-gps-do-zello",
       "title": "Excessos de velocidade (GPS do Zello)",
       "level": 4,
       "summary": "Limite: em Definições → Parâmetros → \"Limite de velocidade (GPS do Zello)\": 120 km/h (o máximo em Portugal, nas autoestradas) sem tolerância por omissão…",
       "children": [],
       "container": false,
       "chars": 2547
      },
      {
       "id": "condutores-agentes.md#quando-a-leitura-falha",
       "file": "condutores-agentes.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Mostra \"Não foi possível carregar…\" com Tentar de novo, nunca \"sem dados\".",
       "children": [],
       "container": false,
       "chars": 84
      }
     ]
    },
    {
     "id": "conhecimento",
     "file": "pesquisa-e-conhecimento.md",
     "group": "Pessoas",
     "module": "pesquisa_conhecimento",
     "title": "Pesquisa global (Ctrl+K) e Base de conhecimento",
     "routes": [
      "/formacao/conhecimento"
     ],
     "tabs": [],
     "summary": "Uma só caixa para procurar em tudo o que podes ver: reservas, clientes e contactos, reclamações, emails, conversas de WhatsApp, tarefas, colaboradores…",
     "sections": [
      {
       "id": "pesquisa-e-conhecimento.md#pesquisa-global",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "pesquisa-global",
       "title": "Pesquisa global",
       "level": 2,
       "summary": "Uma só caixa para procurar em tudo o que podes ver: reservas, clientes e contactos, reclamações, emails, conversas de WhatsApp, tarefas, colaboradores…",
       "children": [],
       "container": false,
       "chars": 1373
      },
      {
       "id": "pesquisa-e-conhecimento.md#base-de-conhecimento",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "base-de-conhecimento",
       "title": "Base de conhecimento",
       "level": 2,
       "summary": "Manuais e procedimentos da empresa que o tutor da formação, o assistente, a pesquisa global, o Quiz (perguntas novas em cada jogo), as FAQs da IA e o Procurar…",
       "children": [
        "pesquisa-e-conhecimento.md#onde-estao-os-documentos",
        "pesquisa-e-conhecimento.md#gerir-administradores-menu-pessoas-base-de-conhecimento-ou-f"
       ],
       "container": false,
       "chars": 466
      },
      {
       "id": "pesquisa-e-conhecimento.md#onde-estao-os-documentos",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "onde-estao-os-documentos",
       "title": "Onde estão os documentos",
       "level": 4,
       "summary": "Pastas do Shared Drive \"Multipark\" (por omissão Formação e Procedimentos), sincronizadas sozinhas quando alguém muda um ficheiro nessas pastas (a Google avisa…",
       "children": [],
       "container": false,
       "chars": 796
      },
      {
       "id": "pesquisa-e-conhecimento.md#gerir-administradores-menu-pessoas-base-de-conhecimento-ou-f",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "gerir-administradores-menu-pessoas-base-de-conhecimento-ou-f",
       "title": "Gerir (administradores: menu Pessoas → Base de conhecimento ou Formação → Base de conhecimento)",
       "level": 3,
       "summary": "Definições: liga Sincronizar pastas do Drive, indica as pastas (caminho a partir da raiz do Shared Drive, ex.: Procedimentos/Porto) e quem vê cada pasta…",
       "children": [
        "pesquisa-e-conhecimento.md#quem-ve-o-que",
        "pesquisa-e-conhecimento.md#perguntas-de-quiz-a-partir-de-um-documento",
        "pesquisa-e-conhecimento.md#quiz-e-faqs-feitos-a-partir-da-base",
        "pesquisa-e-conhecimento.md#sem-drive-nem-ia"
       ],
       "container": false,
       "chars": 1570
      },
      {
       "id": "pesquisa-e-conhecimento.md#quem-ve-o-que",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "quem-ve-o-que",
       "title": "Quem vê o quê",
       "level": 4,
       "summary": "Um documento só com papéis marcados só serve a esses papéis; com cidades, só a quem tem acesso a uma dessas cidades.",
       "children": [],
       "container": false,
       "chars": 553
      },
      {
       "id": "pesquisa-e-conhecimento.md#perguntas-de-quiz-a-partir-de-um-documento",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "perguntas-de-quiz-a-partir-de-um-documento",
       "title": "Perguntas de quiz a partir de um documento",
       "level": 4,
       "summary": "O botão ✨ num documento sincronizado pede à IA perguntas de escolha múltipla só com o texto desse documento.",
       "children": [],
       "container": false,
       "chars": 188
      },
      {
       "id": "pesquisa-e-conhecimento.md#quiz-e-faqs-feitos-a-partir-da-base",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "quiz-e-faqs-feitos-a-partir-da-base",
       "title": "Quiz e FAQs feitos a partir da base",
       "level": 4,
       "summary": "Quiz: com a IA ligada, cada jogo tem perguntas novas feitas na hora a partir dos trechos que quem joga pode ver (papéis e cidades contam).",
       "children": [],
       "container": false,
       "chars": 570
      },
      {
       "id": "pesquisa-e-conhecimento.md#sem-drive-nem-ia",
       "file": "pesquisa-e-conhecimento.md",
       "slug": "sem-drive-nem-ia",
       "title": "Sem Drive nem IA",
       "level": 4,
       "summary": "Sem o Shared Drive configurado, os ficheiros carregados funcionam na mesma (DOCX lido pela app; PDF lido pela IA).",
       "children": [],
       "container": false,
       "chars": 215
      }
     ]
    },
    {
     "id": "formacao",
     "file": "formacao.md",
     "group": "Pessoas",
     "module": "formacao",
     "title": "Formação",
     "routes": [
      "/formacao"
     ],
     "tabs": [
      {
       "tab": "mine",
       "section": "Fazer a tua formação",
       "sectionId": "formacao.md#fazer-a-tua-formacao"
      },
      {
       "tab": "videos",
       "section": "Vídeos",
       "sectionId": "formacao.md#videos"
      },
      {
       "tab": "manuals",
       "section": "Manuais",
       "sectionId": "formacao.md#manuais"
      },
      {
       "tab": "faqs",
       "section": "FAQs",
       "sectionId": "formacao.md#faqs"
      },
      {
       "tab": "quiz",
       "section": "Quiz",
       "sectionId": "formacao.md#quiz"
      },
      {
       "tab": "career",
       "section": "Carreira",
       "sectionId": "formacao.md#carreira"
      },
      {
       "tab": "paths",
       "section": "Percursos",
       "sectionId": "formacao.md#percursos"
      },
      {
       "tab": "dashboard",
       "section": "Acompanhamento",
       "sectionId": "formacao.md#acompanhamento"
      }
     ],
     "summary": "Formação obrigatória, vídeos, manuais, FAQs, quiz e exames de carreira.",
     "sections": [
      {
       "id": "formacao.md#inicio",
       "file": "formacao.md",
       "slug": "inicio",
       "title": "Formação",
       "level": 1,
       "summary": "Formação obrigatória, vídeos, manuais, FAQs, quiz e exames de carreira.",
       "children": [],
       "container": false,
       "chars": 71
      },
      {
       "id": "formacao.md#fazer-a-tua-formacao",
       "file": "formacao.md",
       "slug": "fazer-a-tua-formacao",
       "title": "Fazer a tua formação",
       "level": 4,
       "summary": "Menu Pessoas → Formação → separador A minha formação.",
       "children": [],
       "container": false,
       "chars": 1689
      },
      {
       "id": "formacao.md#quiz",
       "file": "formacao.md",
       "slug": "quiz",
       "title": "Quiz",
       "level": 4,
       "summary": "Separador Quiz → escolhe um tema (opcional): uma área, ou escreve um tema.",
       "children": [],
       "container": false,
       "chars": 841
      },
      {
       "id": "formacao.md#carreira",
       "file": "formacao.md",
       "slug": "carreira",
       "title": "Carreira",
       "level": 4,
       "summary": "Em Carreira fazes os exames para subir de nível (Condutor N1 → N4).",
       "children": [],
       "container": false,
       "chars": 589
      },
      {
       "id": "formacao.md#faqs",
       "file": "formacao.md",
       "slug": "faqs",
       "title": "FAQs",
       "level": 4,
       "summary": "No separador FAQs, as marcadas IA foram escritas pela IA a partir da base de conhecimento.",
       "children": [],
       "container": false,
       "chars": 171
      },
      {
       "id": "formacao.md#formacao-e-escala",
       "file": "formacao.md",
       "slug": "formacao-e-escala",
       "title": "Formação e escala",
       "level": 4,
       "summary": "Por agora a formação não bloqueia a escala: o interruptor Definições → Automações → Formação bloqueia a escala vem desligado.",
       "children": [],
       "container": false,
       "chars": 669
      },
      {
       "id": "formacao.md#videos",
       "file": "formacao.md",
       "slug": "videos",
       "title": "Vídeos",
       "level": 4,
       "summary": "Separador Vídeos: filtra-se pela Categoria (em cima; Todas mostra tudo); a área aparece só como etiqueta no cartão.",
       "children": [],
       "container": false,
       "chars": 462
      },
      {
       "id": "formacao.md#manuais",
       "file": "formacao.md",
       "slug": "manuais",
       "title": "Manuais",
       "level": 4,
       "summary": "Separador Manuais: os manuais e documentos, escolhidos pela área e pela subsecção; o tipo (Manuais, Procedimentos, Atualizações, Notícias, Links interativos)…",
       "children": [],
       "container": false,
       "chars": 258
      },
      {
       "id": "formacao.md#percursos",
       "file": "formacao.md",
       "slug": "percursos",
       "title": "Percursos",
       "level": 4,
       "summary": "Percursos (team leader e acima): só quem gere a formação (admin) cria percursos, define os itens e edita; team leaders e supervisores só atribuem (o team…",
       "children": [],
       "container": false,
       "chars": 270
      },
      {
       "id": "formacao.md#acompanhamento",
       "file": "formacao.md",
       "slug": "acompanhamento",
       "title": "Acompanhamento",
       "level": 4,
       "summary": "Acompanhamento (team leader e acima): progresso da equipa.",
       "children": [],
       "container": false,
       "chars": 161
      },
      {
       "id": "formacao.md#gestao",
       "file": "formacao.md",
       "slug": "gestao",
       "title": "Gestão",
       "level": 4,
       "summary": "Promoções: decide o supervisor da cidade, o backoffice ou o admin.",
       "children": [],
       "container": false,
       "chars": 3441
      }
     ]
    },
    {
     "id": "leads-extras",
     "file": "leads-extras.md",
     "group": "Pessoas",
     "module": "leads_extras",
     "title": "Leads de Extras (leads, candidaturas do site e recrutamento)",
     "routes": [
      "/extras-leads"
     ],
     "tabs": [],
     "summary": "Cartões ou Lista (botão no topo da lista de leads e das candidaturas): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
     "sections": [
      {
       "id": "leads-extras.md#inicio",
       "file": "leads-extras.md",
       "slug": "inicio",
       "title": "Leads de Extras (leads, candidaturas do site e recrutamento)",
       "level": 1,
       "summary": "Cartões ou Lista (botão no topo da lista de leads e das candidaturas): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
       "children": [],
       "container": false,
       "chars": 314
      },
      {
       "id": "leads-extras.md#leads",
       "file": "leads-extras.md",
       "slug": "leads",
       "title": "Leads",
       "level": 4,
       "summary": "Contactos que ainda não são extras (do site, de email ou criados à mão).",
       "children": [],
       "container": false,
       "chars": 3622
      },
      {
       "id": "leads-extras.md#candidaturas-do-site-formulario-be-a-driver",
       "file": "leads-extras.md",
       "slug": "candidaturas-do-site-formulario-be-a-driver",
       "title": "Candidaturas do site (formulário \"Be a Driver\")",
       "level": 2,
       "summary": "O número ao lado do separador é o das candidaturas novas.",
       "children": [
        "leads-extras.md#recrutamento-email"
       ],
       "container": false,
       "chars": 1190
      },
      {
       "id": "leads-extras.md#recrutamento-email",
       "file": "leads-extras.md",
       "slug": "recrutamento-email",
       "title": "Recrutamento (email)",
       "level": 4,
       "summary": "Entraram pela IA (no topo, quando há): a IA separa sozinha os emails das caixas partilhadas e as conversas novas do WhatsApp pelas caixas (ver a ajuda da…",
       "children": [],
       "container": false,
       "chars": 3105
      },
      {
       "id": "leads-extras.md#entradas-pela-app-topo-de-candidaturas-quem-trata-do-recruta",
       "file": "leads-extras.md",
       "slug": "entradas-pela-app-topo-de-candidaturas-quem-trata-do-recruta",
       "title": "Entradas pela app (topo de Candidaturas, quem trata do recrutamento — 49c)",
       "level": 2,
       "summary": "Pedidos de ligação: \"Pedido de ligação: email Google diz ser email/telefone\".",
       "children": [],
       "container": false,
       "chars": 1472
      }
     ]
    },
    {
     "id": "rh",
     "file": "rh-ponto.md",
     "group": "Pessoas",
     "module": "rh",
     "title": "RH e ponto",
     "routes": [
      "/rh",
      "/rh/dashboard",
      "/perfil"
     ],
     "tabs": [],
     "summary": "Cartões ou Lista (botão no topo da lista): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
     "sections": [
      {
       "id": "rh-ponto.md#inicio",
       "file": "rh-ponto.md",
       "slug": "inicio",
       "title": "RH e ponto",
       "level": 1,
       "summary": "Cartões ou Lista (botão no topo da lista): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
       "children": [],
       "container": false,
       "chars": 194
      },
      {
       "id": "rh-ponto.md#picar-o-ponto",
       "file": "rh-ponto.md",
       "slug": "picar-o-ponto",
       "title": "Picar o ponto",
       "level": 4,
       "summary": "No topo da aplicação carrega em Dar entrada (check-in) quando começas e Dar saída (check-out) quando acabas.",
       "children": [],
       "container": false,
       "chars": 795
      },
      {
       "id": "rh-ponto.md#ponto-de-um-mes-ficha-separador-ponto",
       "file": "rh-ponto.md",
       "slug": "ponto-de-um-mes-ficha-separador-ponto",
       "title": "Ponto de um mês (ficha → separador Ponto)",
       "level": 2,
       "summary": "As setas ‹ › mudam o mês.",
       "children": [
        "rh-ponto.md#folha-de-ordenados-ninguem-fica-de-fora"
       ],
       "container": false,
       "chars": 571
      },
      {
       "id": "rh-ponto.md#folha-de-ordenados-ninguem-fica-de-fora",
       "file": "rh-ponto.md",
       "slug": "folha-de-ordenados-ninguem-fica-de-fora",
       "title": "Folha de ordenados: ninguém fica de fora",
       "level": 4,
       "summary": "Entra na folha toda a ficha com entradas do ponto no mês, mesmo inativa ou fora do contrato, com aviso: \"ficha inativa com N entrada(s) no ponto neste mês\".",
       "children": [],
       "container": false,
       "chars": 3939
      },
      {
       "id": "rh-ponto.md#ainda-estas-no-terminal-so-com-o-mesmo-interruptor-ligado",
       "file": "rh-ponto.md",
       "slug": "ainda-estas-no-terminal-so-com-o-mesmo-interruptor-ligado",
       "title": "\"Ainda estás no terminal?\" (só com o mesmo interruptor ligado)",
       "level": 2,
       "summary": "De 5 em 5 minutos a app vê o GPS do Zello do aparelho que está contigo (o PDA onde fizeste check-in; senão o teu Zello).",
       "children": [],
       "container": false,
       "chars": 1587
      },
      {
       "id": "rh-ponto.md#terminal-confirmar-corrigir-ou-desmarcar-quem-reve-o-ponto-d",
       "file": "rh-ponto.md",
       "slug": "terminal-confirmar-corrigir-ou-desmarcar-quem-reve-o-ponto-d",
       "title": "Terminal: confirmar, corrigir ou desmarcar (quem revê o ponto da ficha: supervisor da cidade, back office, administrador)",
       "level": 2,
       "summary": "Na ficha → Ponto, cada turno mostra os troços de terminal: \"Terminal Lisboa 14:05–17:20 · contou até 16:40 (último GPS no aeroporto)\".",
       "children": [
        "rh-ponto.md#a-tua-ficha"
       ],
       "container": false,
       "chars": 1535
      },
      {
       "id": "rh-ponto.md#a-tua-ficha",
       "file": "rh-ponto.md",
       "slug": "a-tua-ficha",
       "title": "A tua ficha",
       "level": 4,
       "summary": "Em Perfil → A minha ficha (ou Pessoas → Recursos Humanos) abres a tua ficha: dados, Documentos, Ponto e Horário.",
       "children": [],
       "container": false,
       "chars": 3853
      },
      {
       "id": "rh-ponto.md#com-que-conta-a-pessoa-entra-ficha-cartao-utilizador-e-permi",
       "file": "rh-ponto.md",
       "slug": "com-que-conta-a-pessoa-entra-ficha-cartao-utilizador-e-permi",
       "title": "Com que conta a pessoa entra (ficha → cartão Utilizador e permissões)",
       "level": 2,
       "summary": "Entra como: as contas ligadas à ficha (principal e extra) com o último login e como entrou (Google, código ou palavra-passe).",
       "children": [],
       "container": false,
       "chars": 1149
      },
      {
       "id": "rh-ponto.md#candidatos-inativos-e-desativados-lista-do-rh-filtro-de-esta",
       "file": "rh-ponto.md",
       "slug": "candidatos-inativos-e-desativados-lista-do-rh-filtro-de-esta",
       "title": "Candidatos, inativos e desativados (lista do RH, filtro de estado — 49c)",
       "level": 2,
       "summary": "Ativos, Inativos e desativados e Candidatos (app).",
       "children": [],
       "container": false,
       "chars": 908
      },
      {
       "id": "rh-ponto.md#documentos-validar-ou-recusar-o-rh-da-ficha-supervisor-da-ci",
       "file": "rh-ponto.md",
       "slug": "documentos-validar-ou-recusar-o-rh-da-ficha-supervisor-da-ci",
       "title": "Documentos: validar ou recusar (o RH da ficha: supervisor da cidade, front office, back office, administrador)",
       "level": 2,
       "summary": "Cada documento tem o estado: Pendente de validação (âmbar), Validado (verde) ou Recusado (vermelho, com o motivo).",
       "children": [],
       "container": false,
       "chars": 771
      },
      {
       "id": "rh-ponto.md#pedir-documentos-em-falta-aos-extras-quem-valida-os-document",
       "file": "rh-ponto.md",
       "slug": "pedir-documentos-em-falta-aos-extras-quem-valida-os-document",
       "title": "Pedir documentos em falta aos extras (quem valida os documentos: supervisor da cidade, front office, back office, administrador — nas suas cidades)",
       "level": 2,
       "summary": "O que se pede: os documentos obrigatórios em falta ou recusados que a pessoa entrega ela própria (fotografia, CC/BI, carta, comprovativo NIB, comprovativo de…",
       "children": [
        "rh-ponto.md#carta-de-conducao"
       ],
       "container": false,
       "chars": 2872
      },
      {
       "id": "rh-ponto.md#carta-de-conducao",
       "file": "rh-ponto.md",
       "slug": "carta-de-conducao",
       "title": "Carta de condução",
       "level": 4,
       "summary": "Etiqueta em cada ficha (cabeçalho, cartões e lista): Carta validada (verde: o RH validou e a carta tem 3 anos ou mais), Carta pendente de validação (âmbar: há…",
       "children": [],
       "container": false,
       "chars": 1032
      },
      {
       "id": "rh-ponto.md#notas-internas-team-leader-e-acima-no-seu-ambito",
       "file": "rh-ponto.md",
       "slug": "notas-internas-team-leader-e-acima-no-seu-ambito",
       "title": "Notas internas (team leader e acima, no seu âmbito)",
       "level": 2,
       "summary": "Na ficha, separador Notas internas: notas sobre o trabalho da pessoa (ex.: \"trabalhou mal no dia 03/10\"), com tipo (Geral, Desempenho, Comportamento, Elogio)…",
       "children": [
        "rh-ponto.md#o-supervisor-no-rh-da-sua-cidade",
        "rh-ponto.md#o-back-office-no-rh-todas-as-cidades"
       ],
       "container": false,
       "chars": 793
      },
      {
       "id": "rh-ponto.md#o-supervisor-no-rh-da-sua-cidade",
       "file": "rh-ponto.md",
       "slug": "o-supervisor-no-rh-da-sua-cidade",
       "title": "O supervisor no RH da sua cidade",
       "level": 4,
       "summary": "Um supervisor com todas as cidades (ex.: quem trata do recrutamento, sem cidade na ficha) vê e gere também as fichas sem cidade.",
       "children": [],
       "container": false,
       "chars": 1247
      },
      {
       "id": "rh-ponto.md#o-back-office-no-rh-todas-as-cidades",
       "file": "rh-ponto.md",
       "slug": "o-back-office-no-rh-todas-as-cidades",
       "title": "O back office no RH (todas as cidades)",
       "level": 4,
       "summary": "O back office está na mesma posição do supervisor, mas em todas as cidades: faz o mesmo que o supervisor (criar fichas até team leader, editar…",
       "children": [],
       "container": false,
       "chars": 703
      },
      {
       "id": "rh-ponto.md#gestao-team-leader-e-acima-na-sua-cidade",
       "file": "rh-ponto.md",
       "slug": "gestao-team-leader-e-acima-na-sua-cidade",
       "title": "Gestão (Team Leader e acima, na sua cidade)",
       "level": 2,
       "summary": "Pessoas → Recursos Humanos lista os colaboradores (separadores Colaboradores, Extras, Agentes).",
       "children": [],
       "container": false,
       "chars": 6444
      },
      {
       "id": "rh-ponto.md#dashboard-rh-possiveis-faltas-e-detalhe-por-colaborador",
       "file": "rh-ponto.md",
       "slug": "dashboard-rh-possiveis-faltas-e-detalhe-por-colaborador",
       "title": "Dashboard RH: possíveis faltas e detalhe por colaborador",
       "level": 2,
       "summary": "Em RH → Dashboard (super admin).",
       "children": [
        "rh-ponto.md#possiveis-faltas-por-validar-no-fim-da-pagina-fechado-abre-s"
       ],
       "container": false,
       "chars": 36
      },
      {
       "id": "rh-ponto.md#possiveis-faltas-por-validar-no-fim-da-pagina-fechado-abre-s",
       "file": "rh-ponto.md",
       "slug": "possiveis-faltas-por-validar-no-fim-da-pagina-fechado-abre-s",
       "title": "Possíveis faltas por validar (no fim da página, fechado; abre-se ao carregar)",
       "level": 3,
       "summary": "Todas as noites (e no botão Processar faltas (ontem)) cada extra escalado sem ponto no turno fica como possível falta, que não conta pontos enquanto não for…",
       "children": [
        "rh-ponto.md#detalhe-por-colaborador"
       ],
       "container": false,
       "chars": 1584
      },
      {
       "id": "rh-ponto.md#detalhe-por-colaborador",
       "file": "rh-ponto.md",
       "slug": "detalhe-por-colaborador",
       "title": "Detalhe por colaborador",
       "level": 4,
       "summary": "Horas mês: as do ponto; sem ponto, aparecem as da escala dos Extras, a cinzento, com \"(escala)\".",
       "children": [],
       "container": false,
       "chars": 322
      },
      {
       "id": "rh-ponto.md#ligacoes-fichas-contas-de-login-e-agentes-da-multipark",
       "file": "rh-ponto.md",
       "slug": "ligacoes-fichas-contas-de-login-e-agentes-da-multipark",
       "title": "Ligações (fichas, contas de login e agentes da Multipark)",
       "level": 2,
       "summary": "Em RH → Ligações (quem gere o RH) vês o que falta ligar entre as fichas, as contas de login e os agentes da Multipark.",
       "children": [
        "rh-ponto.md#agentes-da-multipark-pessoas-todos-os-agentes-um-a-um",
        "rh-ponto.md#uma-pessoa-contas-e-agentes",
        "rh-ponto.md#agente-da-multipark-na-ficha",
        "rh-ponto.md#comparar-a-lista-de-agentes-da-multipark-xlsx-ou-csv",
        "rh-ponto.md#juntar-contas-so-administradores",
        "rh-ponto.md#juntar-fichas-da-mesma-pessoa-so-administradores"
       ],
       "container": false,
       "chars": 353
      },
      {
       "id": "rh-ponto.md#agentes-da-multipark-pessoas-todos-os-agentes-um-a-um",
       "file": "rh-ponto.md",
       "slug": "agentes-da-multipark-pessoas-todos-os-agentes-um-a-um",
       "title": "Agentes da Multipark × pessoas (todos os agentes, um a um)",
       "level": 4,
       "summary": "A regra é que cada agente é um utilizador e cada utilizador tem um agente.",
       "children": [],
       "container": false,
       "chars": 2346
      },
      {
       "id": "rh-ponto.md#uma-pessoa-contas-e-agentes",
       "file": "rh-ponto.md",
       "slug": "uma-pessoa-contas-e-agentes",
       "title": "Uma pessoa: contas e agentes",
       "level": 4,
       "summary": "Escolhe a ficha.",
       "children": [],
       "container": false,
       "chars": 986
      },
      {
       "id": "rh-ponto.md#agente-da-multipark-na-ficha",
       "file": "rh-ponto.md",
       "slug": "agente-da-multipark-na-ficha",
       "title": "Agente da Multipark na ficha",
       "level": 4,
       "summary": "No cartão Utilizador e permissões da ficha vês o agente (ou agentes) da Multipark da pessoa.",
       "children": [],
       "container": false,
       "chars": 711
      },
      {
       "id": "rh-ponto.md#comparar-a-lista-de-agentes-da-multipark-xlsx-ou-csv",
       "file": "rh-ponto.md",
       "slug": "comparar-a-lista-de-agentes-da-multipark-xlsx-ou-csv",
       "title": "Comparar a lista de agentes da Multipark (xlsx ou CSV)",
       "level": 4,
       "summary": "Na Multipark exporta os agentes (xlsx) e carrega o ficheiro no cartão Comparar a lista de agentes da Multipark.",
       "children": [],
       "container": false,
       "chars": 1271
      },
      {
       "id": "rh-ponto.md#juntar-contas-so-administradores",
       "file": "rh-ponto.md",
       "slug": "juntar-contas-so-administradores",
       "title": "Juntar contas (só administradores)",
       "level": 3,
       "summary": "Caso típico: a ficha foi criada com um email (por exemplo do Outlook) e a pessoa entrou na app com outra conta Google, que ficou \"perdida\".",
       "children": [],
       "container": false,
       "chars": 1492
      },
      {
       "id": "rh-ponto.md#juntar-fichas-da-mesma-pessoa-so-administradores",
       "file": "rh-ponto.md",
       "slug": "juntar-fichas-da-mesma-pessoa-so-administradores",
       "title": "Juntar fichas da mesma pessoa (só administradores)",
       "level": 3,
       "summary": "Caso típico: a ficha do RH e outra criada sozinha a partir de um login ou de um agente (ex.: \"ribeirohelio662\", \"Agent DRIVER\").",
       "children": [
        "rh-ponto.md#agentes-que-nao-sao-pessoas",
        "rh-ponto.md#agentes-de-teste",
        "rh-ponto.md#fichas-sem-cidade"
       ],
       "container": false,
       "chars": 521
      },
      {
       "id": "rh-ponto.md#agentes-que-nao-sao-pessoas",
       "file": "rh-ponto.md",
       "slug": "agentes-que-nao-sao-pessoas",
       "title": "Agentes que não são pessoas",
       "level": 4,
       "summary": "\"system\", \"api\" e \"API User\" são ações automáticas da Multipark: nunca se ligam a fichas e deixam de aparecer nos conflitos.",
       "children": [],
       "container": false,
       "chars": 1250
      },
      {
       "id": "rh-ponto.md#agentes-de-teste",
       "file": "rh-ponto.md",
       "slug": "agentes-de-teste",
       "title": "Agentes de teste",
       "level": 4,
       "summary": "Agentes cujo nome ou email diz \"teste\", \"test\", \"demo\" e parecidos não aparecem nos \"por ligar\".",
       "children": [],
       "container": false,
       "chars": 122
      },
      {
       "id": "rh-ponto.md#fichas-sem-cidade",
       "file": "rh-ponto.md",
       "slug": "fichas-sem-cidade",
       "title": "Fichas sem cidade",
       "level": 4,
       "summary": "De hora a hora, uma ficha ativa sem cidade recebe a cidade onde o agente da Multipark da pessoa mais trabalhou nos últimos 180 dias.",
       "children": [],
       "container": false,
       "chars": 896
      }
     ]
    }
   ]
  },
  {
   "group": "Operações",
   "pages": [
    {
     "id": "disponibilidade",
     "file": "disponibilidade.md",
     "group": "Operações",
     "module": "disponibilidade",
     "title": "Disponibilidade",
     "routes": [
      "/disponibilidade"
     ],
     "tabs": [],
     "summary": "Onde os extras dizem em que dias e turnos podem trabalhar.",
     "sections": [
      {
       "id": "disponibilidade.md#inicio",
       "file": "disponibilidade.md",
       "slug": "inicio",
       "title": "Disponibilidade",
       "level": 1,
       "summary": "Onde os extras dizem em que dias e turnos podem trabalhar.",
       "children": [],
       "container": false,
       "chars": 101
      },
      {
       "id": "disponibilidade.md#os-teus-dias-livres-habituais-extras-candidatos-e-quem-volta",
       "file": "disponibilidade.md",
       "slug": "os-teus-dias-livres-habituais-extras-candidatos-e-quem-volta",
       "title": "Os teus dias livres habituais (extras, candidatos e quem volta)",
       "level": 2,
       "summary": "Um esboço da tua escala: não são datas, são os dias e as alturas em que costumas estar livre (ex.: \"terças à tarde, quartas de manhã e todos os fins de…",
       "children": [],
       "container": false,
       "chars": 1138
      },
      {
       "id": "disponibilidade.md#marcar-a-tua-disponibilidade-extras",
       "file": "disponibilidade.md",
       "slug": "marcar-a-tua-disponibilidade-extras",
       "title": "Marcar a tua disponibilidade (extras)",
       "level": 2,
       "summary": "Menu Operações → A minha disponibilidade (ou Perfil → A minha disponibilidade, ou o link que recebes por WhatsApp/email).",
       "children": [],
       "container": false,
       "chars": 2410
      },
      {
       "id": "disponibilidade.md#gestao-backoffice-e-acima",
       "file": "disponibilidade.md",
       "slug": "gestao-backoffice-e-acima",
       "title": "Gestão (backoffice e acima)",
       "level": 2,
       "summary": "A mesma página mostra a matriz das disponibilidades só dos extras (função \"extra\"), por cidade.",
       "children": [],
       "container": false,
       "chars": 5068
      },
      {
       "id": "disponibilidade.md#metricas-dos-extras-por-baixo-na-gestao",
       "file": "disponibilidade.md",
       "slug": "metricas-dos-extras-por-baixo-na-gestao",
       "title": "Métricas dos extras (por baixo, na gestão)",
       "level": 2,
       "summary": "O que quer dizer cada número também está no ecrã, em O que quer dizer cada número?",
       "children": [],
       "container": false,
       "chars": 1539
      }
     ]
    },
    {
     "id": "extras-dia",
     "file": "extras-dia.md",
     "group": "Operações",
     "module": "extras_dia",
     "title": "Extras-Dia",
     "routes": [
      "/extras-dia"
     ],
     "tabs": [
      {
       "tab": "dia",
       "section": "Ver a previsão",
       "sectionId": "extras-dia.md#ver-a-previsao"
      },
      {
       "tab": "pressao",
       "section": "Separador \"Pressão\"",
       "sectionId": "extras-dia.md#separador-pressao-quando-e-que-aperta"
      }
     ],
     "summary": "Planeamento do dia seguinte: chegadas, saídas, lavagens e quantos condutores são precisos por hora, e a escala dos extras.",
     "sections": [
      {
       "id": "extras-dia.md#inicio",
       "file": "extras-dia.md",
       "slug": "inicio",
       "title": "Extras-Dia",
       "level": 1,
       "summary": "Planeamento do dia seguinte: chegadas, saídas, lavagens e quantos condutores são precisos por hora, e a escala dos extras.",
       "children": [],
       "container": false,
       "chars": 122
      },
      {
       "id": "extras-dia.md#ver-a-previsao",
       "file": "extras-dia.md",
       "slug": "ver-a-previsao",
       "title": "Ver a previsão",
       "level": 4,
       "summary": "Menu Operações → Extras Dia.",
       "children": [],
       "container": false,
       "chars": 2962
      },
      {
       "id": "extras-dia.md#separador-pressao-quando-e-que-aperta",
       "file": "extras-dia.md",
       "slug": "separador-pressao-quando-e-que-aperta",
       "title": "Separador \"Pressão\" (quando é que aperta)",
       "level": 2,
       "summary": "Em cima, escolhe o separador Pressão (o separador Dia é a previsão de sempre).",
       "children": [
        "extras-dia.md#ler-o-mapa-e-onde-aperta",
        "extras-dia.md#tempo-por-carro-por-condutor-e-carga-tempo-de-entrega",
        "extras-dia.md#notas-do-dia",
        "extras-dia.md#de-onde-vem-os-dados-desde-abril-lidos-todas-as-noites"
       ],
       "container": false,
       "chars": 3857
      },
      {
       "id": "extras-dia.md#ler-o-mapa-e-onde-aperta",
       "file": "extras-dia.md",
       "slug": "ler-o-mapa-e-onde-aperta",
       "title": "Ler o mapa e onde aperta",
       "level": 3,
       "summary": "O mapa (dia da semana × hora) ocupa quase o ecrã.",
       "children": [],
       "container": false,
       "chars": 2871
      },
      {
       "id": "extras-dia.md#tempo-por-carro-por-condutor-e-carga-tempo-de-entrega",
       "file": "extras-dia.md",
       "slug": "tempo-por-carro-por-condutor-e-carga-tempo-de-entrega",
       "title": "Tempo por carro por condutor e carga × tempo de entrega",
       "level": 3,
       "summary": "Tempo por carro, por condutor (só na cidade toda): tabela por número de pessoas a trabalhar (os escalões da tabela de máximos das Definições).",
       "children": [],
       "container": false,
       "chars": 830
      },
      {
       "id": "extras-dia.md#notas-do-dia",
       "file": "extras-dia.md",
       "slug": "notas-do-dia",
       "title": "Notas do dia",
       "level": 3,
       "summary": "Notas do dia (por cidade): o cartão Notas do dia DD/MM mostra as notas internas desse dia de trabalho (das 03h às 03h do dia seguinte).",
       "children": [],
       "container": false,
       "chars": 1030
      },
      {
       "id": "extras-dia.md#de-onde-vem-os-dados-desde-abril-lidos-todas-as-noites",
       "file": "extras-dia.md",
       "slug": "de-onde-vem-os-dados-desde-abril-lidos-todas-as-noites",
       "title": "De onde vêm os dados (desde abril, lidos todas as noites)",
       "level": 3,
       "summary": "Os dados vêm da BD da Multipark desde 3 de abril de 2026 e a janela cresce todos os dias: nunca se deita fora o que já foi medido, para no próximo ano haver o…",
       "children": [],
       "container": false,
       "chars": 2009
      },
      {
       "id": "extras-dia.md#de-onde-vem-os-tempos-so-o-super-admin",
       "file": "extras-dia.md",
       "slug": "de-onde-vem-os-tempos-so-o-super-admin",
       "title": "De onde vêm os tempos (só o super admin)",
       "level": 2,
       "summary": "Em Extras-Dia → Pressão, perto do fim, o cartão De onde vêm os tempos mostra, por cidade e semana (as últimas 8):",
       "children": [],
       "container": false,
       "chars": 980
      },
      {
       "id": "extras-dia.md#diagnostico-dos-tempos-calibracao-so-o-super-admin",
       "file": "extras-dia.md",
       "slug": "diagnostico-dos-tempos-calibracao-so-o-super-admin",
       "title": "Diagnóstico dos tempos (calibração) (só o super admin)",
       "level": 2,
       "summary": "Em Extras-Dia → Pressão, no fim da página, está o cartão Diagnóstico dos tempos (calibração).",
       "children": [
        "extras-dia.md#recolha-pelo-meio-de-uma-entrega"
       ],
       "container": false,
       "chars": 2344
      },
      {
       "id": "extras-dia.md#recolha-pelo-meio-de-uma-entrega",
       "file": "extras-dia.md",
       "slug": "recolha-pelo-meio-de-uma-entrega",
       "title": "Recolha pelo meio de uma entrega",
       "level": 4,
       "summary": "Quem leva um carro ao aeroporto volta ao parque com o carro de uma recolha, se houver uma aí: essa recolha não lhe custa um carro a mais.",
       "children": [],
       "container": false,
       "chars": 701
      },
      {
       "id": "extras-dia.md#escalar-a-equipa-team-leader-supervisor-e-acima",
       "file": "extras-dia.md",
       "slug": "escalar-a-equipa-team-leader-supervisor-e-acima",
       "title": "Escalar a equipa (Team Leader, Supervisor e acima)",
       "level": 2,
       "summary": "Na secção Equipa Manhã / Noite, carrega em Adicionar, escreve o nome da pessoa e escolhe-a da lista do RH; depois as horas de início e de fim.",
       "children": [
        "extras-dia.md#proposta-automatica"
       ],
       "container": false,
       "chars": 5959
      },
      {
       "id": "extras-dia.md#proposta-automatica",
       "file": "extras-dia.md",
       "slug": "proposta-automatica",
       "title": "Proposta automática",
       "level": 4,
       "summary": "A mão humana manda.",
       "children": [],
       "container": false,
       "chars": 2264
      },
      {
       "id": "extras-dia.md#horas-da-escala-automatica-lembretes-e-novas-tentativas",
       "file": "extras-dia.md",
       "slug": "horas-da-escala-automatica-lembretes-e-novas-tentativas",
       "title": "Horas da escala automática, lembretes e novas tentativas",
       "level": 2,
       "summary": "Quando (por omissão): a proposta automática sai a partir das 11:00 e a confirmação, com o aviso de trabalho a cada extra (WhatsApp e email), a partir das…",
       "children": [
        "extras-dia.md#quem-ve-o-que",
        "extras-dia.md#notas"
       ],
       "container": false,
       "chars": 3723
      },
      {
       "id": "extras-dia.md#quem-ve-o-que",
       "file": "extras-dia.md",
       "slug": "quem-ve-o-que",
       "title": "Quem vê o quê",
       "level": 4,
       "summary": "Quem só vê a escala (por exemplo, um condutor) vê as escalas e os turnos, sem euros e sem os botões de ação.",
       "children": [],
       "container": false,
       "chars": 580
      },
      {
       "id": "extras-dia.md#notas",
       "file": "extras-dia.md",
       "slug": "notas",
       "title": "Notas",
       "level": 4,
       "summary": "\"Formação em falta\" = a pessoa ainda não concluiu a formação obrigatória.",
       "children": [],
       "container": false,
       "chars": 618
      }
     ]
    },
    {
     "id": "operacional",
     "file": "atividade-diaria.md",
     "group": "Operações",
     "module": "atividade_diaria",
     "title": "Actividade Diária (quem fez o quê, GPS e PDAs)",
     "routes": [
      "/operacional"
     ],
     "tabs": [
      {
       "tab": "dia",
       "section": "Atividade do Dia",
       "sectionId": "atividade-diaria.md#atividade-do-dia"
      },
      {
       "tab": "resumo",
       "section": "Resumo do dia",
       "sectionId": "atividade-diaria.md#resumo-do-dia-supervisao"
      },
      {
       "tab": "semana",
       "section": "Semana",
       "sectionId": "atividade-diaria.md#semana"
      },
      {
       "tab": "mes",
       "section": "Avaliação do mês",
       "sectionId": "atividade-diaria.md#avaliacao-do-mes"
      },
      {
       "tab": "live",
       "section": "Ao Vivo",
       "sectionId": "atividade-diaria.md#ao-vivo"
      },
      {
       "tab": "history",
       "section": "Histórico Diário",
       "sectionId": "atividade-diaria.md#historico-diario"
      },
      {
       "tab": "pdas",
       "section": "PDAs",
       "sectionId": "atividade-diaria.md#pdas"
      },
      {
       "tab": "radio",
       "section": "Rádio",
       "sectionId": "atividade-diaria.md#radio"
      }
     ],
     "summary": "Menu Operações → Actividade Diária: quem fez o quê nas reservas, o Resumo do dia, a Semana por hora, a Avaliação do mês, os km e as velocidades do GPS…",
     "sections": [
      {
       "id": "atividade-diaria.md#inicio",
       "file": "atividade-diaria.md",
       "slug": "inicio",
       "title": "Actividade Diária (quem fez o quê, GPS e PDAs)",
       "level": 1,
       "summary": "Menu Operações → Actividade Diária: quem fez o quê nas reservas, o Resumo do dia, a Semana por hora, a Avaliação do mês, os km e as velocidades do GPS…",
       "children": [],
       "container": false,
       "chars": 279
      },
      {
       "id": "atividade-diaria.md#que-abas-ves",
       "file": "atividade-diaria.md",
       "slug": "que-abas-ves",
       "title": "Que abas vês",
       "level": 4,
       "summary": "Só aparecem as abas a que a tua conta tem acesso.",
       "children": [],
       "container": false,
       "chars": 587
      },
      {
       "id": "atividade-diaria.md#atividade-do-dia",
       "file": "atividade-diaria.md",
       "slug": "atividade-do-dia",
       "title": "Atividade do Dia",
       "level": 4,
       "summary": "Escolhe Hoje, Ontem, Últimos 7d, Últimos 30d, Este mês ou um Intervalo.",
       "children": [],
       "container": false,
       "chars": 1675
      },
      {
       "id": "atividade-diaria.md#resumo-do-dia-supervisao",
       "file": "atividade-diaria.md",
       "slug": "resumo-do-dia-supervisao",
       "title": "Resumo do dia (supervisão)",
       "level": 2,
       "summary": "Estava na Passagem de turno e passou para aqui (12 out 2026), com tudo o que tinha.",
       "children": [
        "atividade-diaria.md#entregas-tarde-e-recolhas-manha-os-tempos",
        "atividade-diaria.md#o-que-se-passava-e-quem-trabalhou"
       ],
       "container": false,
       "chars": 2405
      },
      {
       "id": "atividade-diaria.md#entregas-tarde-e-recolhas-manha-os-tempos",
       "file": "atividade-diaria.md",
       "slug": "entregas-tarde-e-recolhas-manha-os-tempos",
       "title": "Entregas (tarde) e recolhas (manhã): os tempos",
       "level": 3,
       "summary": "Entregas (tarde): um cartão por tempo, com a mediana em grande, o p75 e a média por baixo e medido em X % (de quantas entregas há esse tempo).",
       "children": [],
       "container": false,
       "chars": 3605
      },
      {
       "id": "atividade-diaria.md#o-que-se-passava-e-quem-trabalhou",
       "file": "atividade-diaria.md",
       "slug": "o-que-se-passava-e-quem-trabalhou",
       "title": "O que se passava e quem trabalhou",
       "level": 3,
       "summary": "O que se passava nesse horário (ao tocar numa das mais lentas):",
       "children": [
        "atividade-diaria.md#semana",
        "atividade-diaria.md#avaliacao-do-mes",
        "atividade-diaria.md#historico-diario",
        "atividade-diaria.md#ao-vivo",
        "atividade-diaria.md#pdas"
       ],
       "container": false,
       "chars": 2869
      },
      {
       "id": "atividade-diaria.md#semana",
       "file": "atividade-diaria.md",
       "slug": "semana",
       "title": "Semana",
       "level": 4,
       "summary": "O quadro da Pressão do Extras Dia, mas para uma semana escolhida, de domingo a sábado.",
       "children": [],
       "container": false,
       "chars": 2853
      },
      {
       "id": "atividade-diaria.md#avaliacao-do-mes",
       "file": "atividade-diaria.md",
       "slug": "avaliacao-do-mes",
       "title": "Avaliação do mês",
       "level": 4,
       "summary": "É o mesmo separador Mês da Avaliação (Pessoas → Avaliação), aqui também: o período (Este mês ou outro), o ranking (Totais / Por hora, CSV, Google Sheets e…",
       "children": [],
       "container": false,
       "chars": 340
      },
      {
       "id": "atividade-diaria.md#historico-diario",
       "file": "atividade-diaria.md",
       "slug": "historico-diario",
       "title": "Histórico Diário",
       "level": 4,
       "summary": "O GPS de um dia por pessoa: km, horas em movimento e paradas, velocidades, excessos, bateria e trajeto.",
       "children": [],
       "container": false,
       "chars": 3192
      },
      {
       "id": "atividade-diaria.md#ao-vivo",
       "file": "atividade-diaria.md",
       "slug": "ao-vivo",
       "title": "Ao Vivo",
       "level": 4,
       "summary": "Terminal agora (em cima; só com o interruptor \"Terminal no ponto (aeroporto)\" ligado): por cidade, quem está no terminal e desde quando, como entrou (pelo…",
       "children": [],
       "container": false,
       "chars": 2320
      },
      {
       "id": "atividade-diaria.md#pdas",
       "file": "atividade-diaria.md",
       "slug": "pdas",
       "title": "PDAs",
       "level": 4,
       "summary": "Os PDAs da cidade, quem está com cada um e desde quando.",
       "children": [],
       "container": false,
       "chars": 1352
      },
      {
       "id": "atividade-diaria.md#telemoveis-pessoais-por-baixo-dos-pdas",
       "file": "atividade-diaria.md",
       "slug": "telemoveis-pessoais-por-baixo-dos-pdas",
       "title": "Telemóveis pessoais (por baixo dos PDAs)",
       "level": 2,
       "summary": "São os telemóveis de uma pessoa (team leaders, supervisores, qualquer um), não PDAs partilhados.",
       "children": [
        "atividade-diaria.md#radio",
        "atividade-diaria.md#quando-a-leitura-falha"
       ],
       "container": false,
       "chars": 1821
      },
      {
       "id": "atividade-diaria.md#radio",
       "file": "atividade-diaria.md",
       "slug": "radio",
       "title": "Rádio",
       "level": 4,
       "summary": "O separador Rádio (quem tem o módulo Rádio) tem as gravações do Zello, as provas e as transcrições — ver a ajuda \"Rádio\".",
       "children": [],
       "container": false,
       "chars": 127
      },
      {
       "id": "atividade-diaria.md#quando-a-leitura-falha",
       "file": "atividade-diaria.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Aparece um aviso vermelho \"Não foi possível carregar…\" com Tentar de novo.",
       "children": [],
       "container": false,
       "chars": 308
      }
     ]
    },
    {
     "id": "operacoes",
     "file": "reservas-do-dia.md",
     "group": "Operações",
     "module": "reservas_operacoes",
     "title": "Reservas do dia (entradas e saídas)",
     "routes": [
      "/operacoes"
     ],
     "tabs": [
      {
       "tab": "dia",
       "section": "Reservas do dia",
       "sectionId": "reservas-do-dia.md#reservas-do-dia-o-separador"
      }
     ],
     "summary": "Uma só lista com as entradas (check-in) e as saídas (check-out) de um dia.",
     "sections": [
      {
       "id": "reservas-do-dia.md#reservas-do-dia-o-separador",
       "file": "reservas-do-dia.md",
       "slug": "reservas-do-dia-o-separador",
       "title": "Reservas do dia (o separador)",
       "level": 2,
       "summary": "Uma só lista com as entradas (check-in) e as saídas (check-out) de um dia.",
       "children": [
        "reservas-do-dia.md#onde",
        "reservas-do-dia.md#o-dia",
        "reservas-do-dia.md#cada-linha",
        "reservas-do-dia.md#que-parques-aparecem",
        "reservas-do-dia.md#por-cidade-por-hora-e-por-marca",
        "reservas-do-dia.md#grupos-um-por-parque",
        "reservas-do-dia.md#contadores-e-filtros"
       ],
       "container": false,
       "chars": 195
      },
      {
       "id": "reservas-do-dia.md#onde",
       "file": "reservas-do-dia.md",
       "slug": "onde",
       "title": "Onde",
       "level": 4,
       "summary": "Menu Operações → Reservas & Operações, aba Reservas do dia.",
       "children": [],
       "container": false,
       "chars": 224
      },
      {
       "id": "reservas-do-dia.md#o-dia",
       "file": "reservas-do-dia.md",
       "slug": "o-dia",
       "title": "O dia",
       "level": 4,
       "summary": "Abre sempre no dia de hoje (hora de Lisboa) e carrega só esse dia, por isso é rápida.",
       "children": [],
       "container": false,
       "chars": 265
      },
      {
       "id": "reservas-do-dia.md#cada-linha",
       "file": "reservas-do-dia.md",
       "slug": "cada-linha",
       "title": "Cada linha",
       "level": 4,
       "summary": "É um movimento: Entrada (seta para baixo, a verde) ou Saída (seta para cima, a laranja), com a hora.",
       "children": [],
       "container": false,
       "chars": 1039
      },
      {
       "id": "reservas-do-dia.md#que-parques-aparecem",
       "file": "reservas-do-dia.md",
       "slug": "que-parques-aparecem",
       "title": "Que parques aparecem",
       "level": 4,
       "summary": "A lista é só da operação: estão as entradas e saídas de todos os parques da base de dados da Multipark (das tuas cidades), porque a operação recolhe e entrega…",
       "children": [],
       "container": false,
       "chars": 1381
      },
      {
       "id": "reservas-do-dia.md#por-cidade-por-hora-e-por-marca",
       "file": "reservas-do-dia.md",
       "slug": "por-cidade-por-hora-e-por-marca",
       "title": "Por cidade, por hora e por marca",
       "level": 4,
       "summary": "Por cima da lista há um botão por cidade (Lisboa, Porto, Faro) com as entradas e saídas de cada uma.",
       "children": [],
       "container": false,
       "chars": 1089
      },
      {
       "id": "reservas-do-dia.md#grupos-um-por-parque",
       "file": "reservas-do-dia.md",
       "slug": "grupos-um-por-parque",
       "title": "Grupos: um por parque",
       "level": 4,
       "summary": "Cada parque tem o seu bloco, com o nome no cabeçalho e as contagens de entradas e saídas.",
       "children": [],
       "container": false,
       "chars": 677
      },
      {
       "id": "reservas-do-dia.md#contadores-e-filtros",
       "file": "reservas-do-dia.md",
       "slug": "contadores-e-filtros",
       "title": "Contadores e filtros",
       "level": 4,
       "summary": "No topo: entradas, saídas (com as que ainda estão por fazer) e canceladas, da cidade escolhida.",
       "children": [],
       "container": false,
       "chars": 1170
      }
     ]
    },
    {
     "id": "operacoes.listas",
     "file": "operacoes-listas.md",
     "group": "Operações",
     "module": "reservas_operacoes",
     "title": "Reservas, Recolhas, Entregas e Cancelados (listas por período)",
     "routes": [
      "/operacoes"
     ],
     "tabs": [
      {
       "tab": "dashboard",
       "section": "O Dashboard (primeira aba)",
       "sectionId": "operacoes-listas.md#o-dashboard-primeira-aba"
      },
      {
       "tab": "reservas",
       "section": "Reservas",
       "sectionId": "operacoes-listas.md#reservas"
      },
      {
       "tab": "entradas",
       "section": "Recolhas",
       "sectionId": "operacoes-listas.md#recolhas"
      },
      {
       "tab": "saidas",
       "section": "Entregas",
       "sectionId": "operacoes-listas.md#entregas"
      },
      {
       "tab": "cancelados",
       "section": "Cancelados",
       "sectionId": "operacoes-listas.md#cancelados"
      }
     ],
     "summary": "Quatro listas por período, nas Operações → Reservas & Operações, ao lado de \"Reservas do dia\".",
     "sections": [
      {
       "id": "operacoes-listas.md#inicio",
       "file": "operacoes-listas.md",
       "slug": "inicio",
       "title": "Reservas, Recolhas, Entregas e Cancelados (listas por período)",
       "level": 1,
       "summary": "Quatro listas por período, nas Operações → Reservas & Operações, ao lado de \"Reservas do dia\".",
       "children": [],
       "container": false,
       "chars": 184
      },
      {
       "id": "operacoes-listas.md#as-quatro-listas",
       "file": "operacoes-listas.md",
       "slug": "as-quatro-listas",
       "title": "As quatro listas",
       "level": 2,
       "summary": "O tipo de lugar Toldo é o antigo \"coberto\" (o carro fica sob toldo); Descoberto, Interior e VIP ficam iguais.",
       "children": [
        "operacoes-listas.md#reservas",
        "operacoes-listas.md#recolhas",
        "operacoes-listas.md#entregas",
        "operacoes-listas.md#cancelados"
       ],
       "container": false,
       "chars": 518
      },
      {
       "id": "operacoes-listas.md#reservas",
       "file": "operacoes-listas.md",
       "slug": "reservas",
       "title": "Reservas",
       "level": 3,
       "summary": "Reservas criadas no período (pela data de criação), incluindo as que entretanto foram canceladas.",
       "children": [],
       "container": false,
       "chars": 101
      },
      {
       "id": "operacoes-listas.md#recolhas",
       "file": "operacoes-listas.md",
       "slug": "recolhas",
       "title": "Recolhas",
       "level": 3,
       "summary": "Reservas com recolha (check-in) no período, sem as canceladas.",
       "children": [],
       "container": false,
       "chars": 66
      },
      {
       "id": "operacoes-listas.md#entregas",
       "file": "operacoes-listas.md",
       "slug": "entregas",
       "title": "Entregas",
       "level": 3,
       "summary": "Reservas com entrega (check-out) no período, sem as canceladas.",
       "children": [],
       "container": false,
       "chars": 67
      },
      {
       "id": "operacoes-listas.md#cancelados",
       "file": "operacoes-listas.md",
       "slug": "cancelados",
       "title": "Cancelados",
       "level": 3,
       "summary": "Reservas canceladas no período, pela data do cancelamento.",
       "children": [],
       "container": false,
       "chars": 420
      },
      {
       "id": "operacoes-listas.md#ler-as-listas",
       "file": "operacoes-listas.md",
       "slug": "ler-as-listas",
       "title": "Ler as listas",
       "level": 2,
       "summary": "",
       "children": [
        "operacoes-listas.md#o-periodo",
        "operacoes-listas.md#contadores-e-comparacao",
        "operacoes-listas.md#porque-e-que-o-numero-e-diferente-do-dashboard",
        "operacoes-listas.md#filtros-e-tabela",
        "operacoes-listas.md#o-dashboard-primeira-aba"
       ],
       "container": true,
       "chars": 0
      },
      {
       "id": "operacoes-listas.md#o-periodo",
       "file": "operacoes-listas.md",
       "slug": "o-periodo",
       "title": "O período",
       "level": 4,
       "summary": "Abre em hoje (hora de Lisboa) — ou no período do Dashboard, quando se chega lá a partir de um cartão.",
       "children": [],
       "container": false,
       "chars": 435
      },
      {
       "id": "operacoes-listas.md#contadores-e-comparacao",
       "file": "operacoes-listas.md",
       "slug": "contadores-e-comparacao",
       "title": "Contadores e comparação",
       "level": 4,
       "summary": "O total do período e a diferença para o período anterior com a mesma duração (por exemplo, hoje contra ontem, ou estes 7 dias contra os 7 anteriores).",
       "children": [],
       "container": false,
       "chars": 1160
      },
      {
       "id": "operacoes-listas.md#porque-e-que-o-numero-e-diferente-do-dashboard",
       "file": "operacoes-listas.md",
       "slug": "porque-e-que-o-numero-e-diferente-do-dashboard",
       "title": "Porque é que o número é diferente do Dashboard?",
       "level": 4,
       "summary": "O Dashboard (primeira aba) conta só os parques nossos; as listas mostram todos os parques das tuas cidades, também os Marketplace.",
       "children": [],
       "container": false,
       "chars": 508
      },
      {
       "id": "operacoes-listas.md#filtros-e-tabela",
       "file": "operacoes-listas.md",
       "slug": "filtros-e-tabela",
       "title": "Filtros e tabela",
       "level": 4,
       "summary": "Filtros: parque, estado (Reservas: não canceladas / canceladas; Recolhas: recolhidas / por recolher; Entregas: entregues / por entregar; Cancelados: com / sem…",
       "children": [],
       "container": false,
       "chars": 677
      },
      {
       "id": "operacoes-listas.md#o-dashboard-primeira-aba",
       "file": "operacoes-listas.md",
       "slug": "o-dashboard-primeira-aba",
       "title": "O Dashboard (primeira aba)",
       "level": 4,
       "summary": "Cartões Reservas criadas, Recolhas, Entregas e Cancelamentos no período, a percentagem de cancelamento e os gráficos por cidade ou parque.",
       "children": [],
       "container": false,
       "chars": 557
      }
     ]
    },
    {
     "id": "passagem-turno",
     "file": "passagem-turno.md",
     "group": "Operações",
     "module": "passagem_turno",
     "title": "Passagem de turno",
     "routes": [
      "/passagem-turno"
     ],
     "tabs": [],
     "summary": "Checklist de fim de turno dos team leaders e o histórico das passagens.",
     "sections": [
      {
       "id": "passagem-turno.md#inicio",
       "file": "passagem-turno.md",
       "slug": "inicio",
       "title": "Passagem de turno",
       "level": 1,
       "summary": "Checklist de fim de turno dos team leaders e o histórico das passagens.",
       "children": [],
       "container": false,
       "chars": 368
      },
      {
       "id": "passagem-turno.md#preencher-team-leader",
       "file": "passagem-turno.md",
       "slug": "preencher-team-leader",
       "title": "Preencher (Team Leader)",
       "level": 2,
       "summary": "Menu Operações → Passagem de Turno.",
       "children": [
        "passagem-turno.md#resumo-ia-para-o-turno-seguinte",
        "passagem-turno.md#pendentes-que-passam-de-turno"
       ],
       "container": false,
       "chars": 682
      },
      {
       "id": "passagem-turno.md#resumo-ia-para-o-turno-seguinte",
       "file": "passagem-turno.md",
       "slug": "resumo-ia-para-o-turno-seguinte",
       "title": "Resumo IA para o turno seguinte",
       "level": 4,
       "summary": "A IA faz o resumo quando entregas a passagem (a 1.ª vez que carregas em Guardar passagem de turno).",
       "children": [],
       "container": false,
       "chars": 748
      },
      {
       "id": "passagem-turno.md#pendentes-que-passam-de-turno",
       "file": "passagem-turno.md",
       "slug": "pendentes-que-passam-de-turno",
       "title": "Pendentes que passam de turno",
       "level": 4,
       "summary": "Só passam de turno os PDAs ainda com check-in e o que o team leader escreve (as notas).",
       "children": [],
       "container": false,
       "chars": 1387
      },
      {
       "id": "passagem-turno.md#resumo-automatico-no-topo-de-preencher",
       "file": "passagem-turno.md",
       "slug": "resumo-automatico-no-topo-de-preencher",
       "title": "Resumo automático (no topo de Preencher)",
       "level": 2,
       "summary": "As recolhas e entregas do próximo turno (com voo e valor a pagar), as entregas pendentes e os carros p/ toldo vêm ao vivo da BD da Multipark.",
       "children": [
        "passagem-turno.md#estado-do-parque-ao-vivo",
        "passagem-turno.md#alteracoes-por-gravar",
        "passagem-turno.md#quando-a-leitura-falha",
        "passagem-turno.md#notas"
       ],
       "container": false,
       "chars": 653
      },
      {
       "id": "passagem-turno.md#estado-do-parque-ao-vivo",
       "file": "passagem-turno.md",
       "slug": "estado-do-parque-ao-vivo",
       "title": "Estado do parque (ao vivo)",
       "level": 4,
       "summary": "Separador com o estado atual dos parques da cidade, lido diretamente da BD da Multipark (só leitura).",
       "children": [],
       "container": false,
       "chars": 3828
      },
      {
       "id": "passagem-turno.md#alteracoes-por-gravar",
       "file": "passagem-turno.md",
       "slug": "alteracoes-por-gravar",
       "title": "Alterações por gravar",
       "level": 4,
       "summary": "O que escreveste não se perde ao mudar de separador.",
       "children": [],
       "container": false,
       "chars": 150
      },
      {
       "id": "passagem-turno.md#quando-a-leitura-falha",
       "file": "passagem-turno.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Cada parte (as tuas cidades, o registo do turno, o resumo automático, o histórico) mostra \"Não foi possível carregar…\" com Tentar de novo.",
       "children": [],
       "container": false,
       "chars": 222
      },
      {
       "id": "passagem-turno.md#notas",
       "file": "passagem-turno.md",
       "slug": "notas",
       "title": "Notas",
       "level": 4,
       "summary": "Depois de 24 h só um supervisor, ou quem tem acesso ao Resumo do dia, pode alterar a passagem.",
       "children": [],
       "container": false,
       "chars": 2211
      }
     ]
    },
    {
     "id": "radio",
     "file": "radio.md",
     "group": "Operações",
     "module": "radio",
     "title": "Rádio (gravações do Zello e transcrições)",
     "routes": [
      "/radio",
      "/operacional"
     ],
     "tabs": [],
     "summary": "Menu Operações → Actividade Diária, separador Rádio (o antigo endereço /radio vai lá ter).",
     "sections": [
      {
       "id": "radio.md#inicio",
       "file": "radio.md",
       "slug": "inicio",
       "title": "Rádio (gravações do Zello e transcrições)",
       "level": 1,
       "summary": "Menu Operações → Actividade Diária, separador Rádio (o antigo endereço /radio vai lá ter).",
       "children": [],
       "container": false,
       "chars": 187
      },
      {
       "id": "radio.md#gravacoes-do-zello",
       "file": "radio.md",
       "slug": "gravacoes-do-zello",
       "title": "Gravações do Zello",
       "level": 2,
       "summary": "As mensagens de voz vêm diretamente do histórico do Zello, cruzadas com o GPS e com a Multipark.",
       "children": [
        "radio.md#guardar-como-prova-supervisores-backoffice-e-administracao"
       ],
       "container": false,
       "chars": 1671
      },
      {
       "id": "radio.md#guardar-como-prova-supervisores-backoffice-e-administracao",
       "file": "radio.md",
       "slug": "guardar-como-prova-supervisores-backoffice-e-administracao",
       "title": "Guardar como prova (supervisores, backoffice e administração)",
       "level": 3,
       "summary": "Numa mensagem, Guardar como prova.",
       "children": [],
       "container": false,
       "chars": 843
      },
      {
       "id": "radio.md#provas",
       "file": "radio.md",
       "slug": "provas",
       "title": "Provas",
       "level": 2,
       "summary": "As mensagens guardadas como prova, das mais recentes para as mais antigas.",
       "children": [],
       "container": false,
       "chars": 585
      },
      {
       "id": "radio.md#transcricoes",
       "file": "radio.md",
       "slug": "transcricoes",
       "title": "Transcrições",
       "level": 2,
       "summary": "As comunicações de rádio passadas a texto a partir de um ficheiro de áudio, com um resumo de 1 ou 2 frases.",
       "children": [
        "radio.md#a-lista",
        "radio.md#nova-transcricao-team-leaders-supervisores-e-administracao"
       ],
       "container": false,
       "chars": 107
      },
      {
       "id": "radio.md#a-lista",
       "file": "radio.md",
       "slug": "a-lista",
       "title": "A lista",
       "level": 4,
       "summary": "Das mais recentes para as mais antigas, 50 de cada vez.",
       "children": [],
       "container": false,
       "chars": 357
      },
      {
       "id": "radio.md#nova-transcricao-team-leaders-supervisores-e-administracao",
       "file": "radio.md",
       "slug": "nova-transcricao-team-leaders-supervisores-e-administracao",
       "title": "Nova transcrição (team leaders, supervisores e administração)",
       "level": 3,
       "summary": "Escolhe o ficheiro de áudio (até 4 MB).",
       "children": [
        "radio.md#quando-a-leitura-falha"
       ],
       "container": false,
       "chars": 344
      },
      {
       "id": "radio.md#quando-a-leitura-falha",
       "file": "radio.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Aparece \"Não foi possível carregar as transcrições\" com Tentar de novo, em vez de \"Sem transcrições\".",
       "children": [],
       "container": false,
       "chars": 216
      }
     ]
    },
    {
     "id": "reserva",
     "file": "ficha-reserva.md",
     "group": "Operações",
     "module": "reservas_operacoes",
     "title": "Ficha da reserva",
     "routes": [
      "/reserva"
     ],
     "tabs": [],
     "summary": "Tudo sobre uma reserva num só sítio, lido em tempo real da base de dados da Multipark.",
     "sections": [
      {
       "id": "ficha-reserva.md#inicio",
       "file": "ficha-reserva.md",
       "slug": "inicio",
       "title": "Ficha da reserva",
       "level": 1,
       "summary": "Tudo sobre uma reserva num só sítio, lido em tempo real da base de dados da Multipark.",
       "children": [],
       "container": false,
       "chars": 170
      },
      {
       "id": "ficha-reserva.md#abrir",
       "file": "ficha-reserva.md",
       "slug": "abrir",
       "title": "Abrir",
       "level": 4,
       "summary": "Em Reclamações e Perdidos e Achados, no cartão \"Dados da Reserva\", carrega em Abrir ficha da reserva.",
       "children": [],
       "container": false,
       "chars": 418
      },
      {
       "id": "ficha-reserva.md#o-que-mostra",
       "file": "ficha-reserva.md",
       "slug": "o-que-mostra",
       "title": "O que mostra",
       "level": 4,
       "summary": "Cabeçalho: n.º, estado, parque, entrada e saída, voos com a hora prevista atualizada (ETA), tipo de entrega, o canal para a contabilidade (Direto, Parceiro ·…",
       "children": [],
       "container": false,
       "chars": 5822
      }
     ]
    },
    {
     "id": "servicos",
     "file": "servicos.md",
     "group": "Operações",
     "module": "servicos",
     "title": "Serviços",
     "routes": [
      "/servicos"
     ],
     "tabs": [],
     "summary": "Menu Operações → Serviços: os serviços extra das reservas (lavagens, carregamentos elétricos, valet…) no período escolhido, com totais por tipo e por parque.",
     "sections": [
      {
       "id": "servicos.md#inicio",
       "file": "servicos.md",
       "slug": "inicio",
       "title": "Serviços",
       "level": 1,
       "summary": "Menu Operações → Serviços: os serviços extra das reservas (lavagens, carregamentos elétricos, valet…) no período escolhido, com totais por tipo e por parque.",
       "children": [],
       "container": false,
       "chars": 1392
      },
      {
       "id": "servicos.md#limites-e-falhas",
       "file": "servicos.md",
       "slug": "limites-e-falhas",
       "title": "Limites e falhas",
       "level": 4,
       "summary": "A leitura traz até 5000 serviços por período.",
       "children": [],
       "container": false,
       "chars": 275
      },
      {
       "id": "servicos.md#tarefas-automaticas-dos-servicos",
       "file": "servicos.md",
       "slug": "tarefas-automaticas-dos-servicos",
       "title": "Tarefas automáticas dos serviços",
       "level": 4,
       "summary": "Em Definições → Parâmetros → Serviços → tarefas (admin) escolhe-se, por cidade e por tipo de serviço, se cada reserva com esse serviço gera uma tarefa e quem…",
       "children": [],
       "container": false,
       "chars": 1627
      }
     ]
    },
    {
     "id": "tarefas",
     "file": "tarefas.md",
     "group": "Operações",
     "module": "tarefas",
     "title": "Tarefas",
     "routes": [
      "/tarefas"
     ],
     "tabs": [],
     "summary": "As minhas tarefas",
     "sections": [
      {
       "id": "tarefas.md#as-minhas-tarefas",
       "file": "tarefas.md",
       "slug": "as-minhas-tarefas",
       "title": "As minhas tarefas",
       "level": 4,
       "summary": "Menu Operações → Tarefas.",
       "children": [],
       "container": false,
       "chars": 704
      },
      {
       "id": "tarefas.md#filtros-em-as-minhas-tarefas-no-quadro-e-na-lista",
       "file": "tarefas.md",
       "slug": "filtros-em-as-minhas-tarefas-no-quadro-e-na-lista",
       "title": "Filtros (em As minhas tarefas, no Quadro e na Lista)",
       "level": 2,
       "summary": "Carrega em Filtros: abre um painel (de baixo, no telemóvel) com:",
       "children": [],
       "container": false,
       "chars": 1473
      },
      {
       "id": "tarefas.md#criar-e-gerir-team-leader-e-acima",
       "file": "tarefas.md",
       "slug": "criar-e-gerir-team-leader-e-acima",
       "title": "Criar e gerir (Team Leader e acima)",
       "level": 2,
       "summary": "Nova tarefa: título, descrição, centro de custos, prioridade, data limite e Responsáveis (só pessoas ativas das tuas cidades).",
       "children": [],
       "container": false,
       "chars": 1164
      },
      {
       "id": "tarefas.md#checklists-recorrentes-supervisor-frontoffice-backoffice-e-a",
       "file": "tarefas.md",
       "slug": "checklists-recorrentes-supervisor-frontoffice-backoffice-e-a",
       "title": "Checklists recorrentes (supervisor, frontoffice, backoffice e admin)",
       "level": 2,
       "summary": "Tarefas que se criam sozinhas por turno e cidade (ex.: abertura do turno), nos dias escolhidos.",
       "children": [],
       "container": false,
       "chars": 869
      },
      {
       "id": "tarefas.md#avisos-de-atraso-e-conclusao-de-hora-a-hora",
       "file": "tarefas.md",
       "slug": "avisos-de-atraso-e-conclusao-de-hora-a-hora",
       "title": "Avisos de atraso e conclusão (de hora a hora)",
       "level": 2,
       "summary": "Tarefas criadas à mão: quando passam o prazo avisam no sino quem a criou, os gestores do centro de custos e os responsáveis; quem a criou recebe também email.",
       "children": [
        "tarefas.md#aviso-nova-tarefa-para-ti"
       ],
       "container": false,
       "chars": 745
      },
      {
       "id": "tarefas.md#aviso-nova-tarefa-para-ti",
       "file": "tarefas.md",
       "slug": "aviso-nova-tarefa-para-ti",
       "title": "Aviso \"Nova tarefa para ti\"",
       "level": 4,
       "summary": "Quando alguém te põe como responsável numa tarefa (ao criar, ao criar a partir de texto ou ao editar), recebes no sino Nova tarefa para ti com o título, o…",
       "children": [],
       "container": false,
       "chars": 600
      },
      {
       "id": "tarefas.md#tarefas-dos-servicos-das-reservas-automaticas",
       "file": "tarefas.md",
       "slug": "tarefas-dos-servicos-das-reservas-automaticas",
       "title": "Tarefas dos serviços das reservas (automáticas)",
       "level": 2,
       "summary": "Quando uma reserva tem um serviço extra (ex.: lavagem, carregamento elétrico) de um tipo ligado em Definições → Parâmetros → Serviços → tarefas, aparece…",
       "children": [],
       "container": false,
       "chars": 1084
      },
      {
       "id": "tarefas.md#tarefas-de-candidatura-automaticas-origem-candidatura-de-con",
       "file": "tarefas.md",
       "slug": "tarefas-de-candidatura-automaticas-origem-candidatura-de-con",
       "title": "Tarefas de candidatura (automáticas, origem Candidatura de condutor)",
       "level": 2,
       "summary": "Cada candidatura nova que entra nos Leads de Extras (formulário \"Be a Driver\" do site ou email para a recursos-humanos@) cria uma tarefa \"Candidatura de…",
       "children": [],
       "container": false,
       "chars": 1149
      }
     ]
    }
   ]
  },
  {
   "group": "Suporte",
   "pages": [
    {
     "id": "clientes",
     "file": "clientes.md",
     "group": "Suporte",
     "module": "clientes",
     "title": "Clientes (CRM: fichas, filtros, juntar e separar)",
     "routes": [
      "/clientes",
      "/clientes/rever"
     ],
     "tabs": [],
     "summary": "Cada cliente tem uma ficha com o nosso n.º de cliente.",
     "sections": [
      {
       "id": "clientes.md#inicio",
       "file": "clientes.md",
       "slug": "inicio",
       "title": "Clientes (CRM: fichas, filtros, juntar e separar)",
       "level": 1,
       "summary": "Cada cliente tem uma ficha com o nosso n.º de cliente.",
       "children": [],
       "container": false,
       "chars": 317
      },
      {
       "id": "clientes.md#de-onde-vem-os-clientes",
       "file": "clientes.md",
       "slug": "de-onde-vem-os-clientes",
       "title": "De onde vêm os clientes",
       "level": 4,
       "summary": "As reservas são lidas ao vivo da base de dados da Multipark.",
       "children": [],
       "container": false,
       "chars": 953
      },
      {
       "id": "clientes.md#quando-duas-fichas-sao-a-mesma-pessoa-regras-do-dono",
       "file": "clientes.md",
       "slug": "quando-duas-fichas-sao-a-mesma-pessoa-regras-do-dono",
       "title": "Quando duas fichas são a mesma pessoa (regras do dono)",
       "level": 2,
       "summary": "O mesmo nome: o 1.º e o último nome iguais, sem contar acentos, maiúsculas, pontos, traços, \"_\", asteriscos, apóstrofos ou números (\"António Gonçalves\"…",
       "children": [
        "clientes.md#como-uma-reserva-se-liga-a-uma-ficha"
       ],
       "container": false,
       "chars": 895
      },
      {
       "id": "clientes.md#como-uma-reserva-se-liga-a-uma-ficha",
       "file": "clientes.md",
       "slug": "como-uma-reserva-se-liga-a-uma-ficha",
       "title": "Como uma reserva se liga a uma ficha",
       "level": 4,
       "summary": "Com as regras de cima: a reserva liga-se sozinha à ficha com o mesmo nome e um dado igual, ou com o mesmo email e telefone.",
       "children": [],
       "container": false,
       "chars": 388
      },
      {
       "id": "clientes.md#lista-menu-suporte-clientes",
       "file": "clientes.md",
       "slug": "lista-menu-suporte-clientes",
       "title": "Lista (menu Suporte → Clientes)",
       "level": 2,
       "summary": "Na barra de pesquisa escreve e escolhe onde procurar (nome, email, telefone, matrícula, NIF, n.º de cliente, n.º de reserva, cor ou modelo do carro, notas).",
       "children": [
        "clientes.md#ficha",
        "clientes.md#o-cliente-nas-outras-paginas"
       ],
       "container": false,
       "chars": 2074
      },
      {
       "id": "clientes.md#ficha",
       "file": "clientes.md",
       "slug": "ficha",
       "title": "Ficha",
       "level": 4,
       "summary": "No cabeçalho, Ligar, WhatsApp e Email (o telefone e o email principais primeiro; com vários, escolhes qual).",
       "children": [],
       "container": false,
       "chars": 1712
      },
      {
       "id": "clientes.md#o-cliente-nas-outras-paginas",
       "file": "clientes.md",
       "slug": "o-cliente-nas-outras-paginas",
       "title": "O cliente nas outras páginas",
       "level": 4,
       "summary": "O Histórico do cliente (Reclamações, Perdidos & Achados, Críticas, WhatsApp) encontra a ficha pelo email, telefone ou matrícula e mostra as reservas dela…",
       "children": [],
       "container": false,
       "chars": 1169
      },
      {
       "id": "clientes.md#clientes-pro-e-conta-corrente-separador-pro",
       "file": "clientes.md",
       "slug": "clientes-pro-e-conta-corrente-separador-pro",
       "title": "Clientes Pro e conta corrente (separador Pro)",
       "level": 2,
       "summary": "Os Pro pagam no fim do mês.",
       "children": [],
       "container": false,
       "chars": 845
      },
      {
       "id": "clientes.md#agregadores-e-agencias-separador-na-lista-de-clientes",
       "file": "clientes.md",
       "slug": "agregadores-e-agencias-separador-na-lista-de-clientes",
       "title": "Agregadores e agências (separador na lista de clientes)",
       "level": 2,
       "summary": "Os parceiros que trabalham nos nossos parques, lidos ao vivo da Multipark: tipo, percentagem que ficam em cada parque, reservas deste mês e dos últimos 12…",
       "children": [],
       "container": false,
       "chars": 1095
      },
      {
       "id": "clientes.md#parcerias-nos-agregamos-separador-na-lista-de-clientes",
       "file": "clientes.md",
       "slug": "parcerias-nos-agregamos-separador-na-lista-de-clientes",
       "title": "Parcerias (nós agregamos) (separador na lista de clientes)",
       "level": 2,
       "summary": "Os parques que não são nossos, em que levamos clientes pelo marketplace e ficamos com uma comissão: dono, contactos, reservas e a nossa comissão, mês a mês.",
       "children": [],
       "container": false,
       "chars": 596
      },
      {
       "id": "clientes.md#rever-fichas-botao-rever-fichas-na-lista",
       "file": "clientes.md",
       "slug": "rever-fichas-botao-rever-fichas-na-lista",
       "title": "Rever fichas (botão Rever fichas na lista)",
       "level": 2,
       "summary": "Junção automática: todas as madrugadas, depois das sugestões das 05:15 (se não acabar, continua), o CRM junta sozinho os pares que as regras do dono resolvem…",
       "children": [],
       "container": false,
       "chars": 3758
      }
     ]
    },
    {
     "id": "contactos",
     "file": "contactos.md",
     "group": "Suporte",
     "module": "contactos",
     "title": "Contactos (pesquisa, diretório e Google Contactos)",
     "routes": [
      "/contactos",
      "/perfil"
     ],
     "tabs": [],
     "summary": "Cartões ou Lista (botão no topo da lista): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
     "sections": [
      {
       "id": "contactos.md#inicio",
       "file": "contactos.md",
       "slug": "inicio",
       "title": "Contactos (pesquisa, diretório e Google Contactos)",
       "level": 1,
       "summary": "Cartões ou Lista (botão no topo da lista): vês as pessoas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
       "children": [],
       "container": false,
       "chars": 194
      },
      {
       "id": "contactos.md#filtrar-e-ordenar-por-cima-em-todos-os-tipos-como-nos-client",
       "file": "contactos.md",
       "slug": "filtrar-e-ordenar-por-cima-em-todos-os-tipos-como-nos-client",
       "title": "Filtrar e ordenar por cima (em todos os tipos, como nos Clientes)",
       "level": 2,
       "summary": "Ordenar: Mais recentes (a ordem normal de cada tipo), Nome A–Z ou Nome Z–A. Na lista, carregar no cabeçalho Nome faz o mesmo (A–Z → Z–A → ordem normal).",
       "children": [],
       "container": false,
       "chars": 437
      },
      {
       "id": "contactos.md#importar-contactos-quem-pode-editar-os-clientes",
       "file": "contactos.md",
       "slug": "importar-contactos-quem-pode-editar-os-clientes",
       "title": "Importar contactos (quem pode editar os Clientes)",
       "level": 2,
       "summary": "Pesquisa → Importar contactos e escolhe o ficheiro: CSV exportado do Google Contactos ou do Outlook, um CSV/Excel com as colunas nome, email, telefone…",
       "children": [],
       "container": false,
       "chars": 862
      },
      {
       "id": "contactos.md#pesquisa-menu-suporte-contactos",
       "file": "contactos.md",
       "slug": "pesquisa-menu-suporte-contactos",
       "title": "Pesquisa (menu Suporte → Contactos)",
       "level": 2,
       "summary": "Escreve pelo menos 2 letras (nome, email, telefone ou matrícula).",
       "children": [
        "contactos.md#diretorio"
       ],
       "container": false,
       "chars": 1548
      },
      {
       "id": "contactos.md#diretorio",
       "file": "contactos.md",
       "slug": "diretorio",
       "title": "Diretório",
       "level": 4,
       "summary": "Pessoas do Google Workspace da empresa: foto, cargo, departamento, telefone e email.",
       "children": [],
       "container": false,
       "chars": 253
      },
      {
       "id": "contactos.md#os-meus-contactos-google-separador-meus-google",
       "file": "contactos.md",
       "slug": "os-meus-contactos-google-separador-meus-google",
       "title": "Os meus contactos Google (separador Meus Google)",
       "level": 2,
       "summary": "No Perfil → Google Contactos carrega em Ativar Contactos (autoriza só os Contactos; o resto que já autorizaste mantém-se).",
       "children": [],
       "container": false,
       "chars": 511
      },
      {
       "id": "contactos.md#grupo-multipark-servico-no-telemovel-so-supervisor-ou-acima",
       "file": "contactos.md",
       "slug": "grupo-multipark-servico-no-telemovel-so-supervisor-ou-acima",
       "title": "Grupo \"Multipark — Serviço\" no telemóvel (só supervisor ou acima: supervisor, admin e super admin por omissão)",
       "level": 2,
       "summary": "Com os Contactos ativos, a app mantém no teu Google Contactos um grupo com os clientes das recolhas e entregas de hoje e amanhã (nome e matrícula), para veres…",
       "children": [],
       "container": false,
       "chars": 885
      },
      {
       "id": "contactos.md#configuracao-super-admin-definicoes-comunicacao-contactos-go",
       "file": "contactos.md",
       "slug": "configuracao-super-admin-definicoes-comunicacao-contactos-go",
       "title": "Configuração (super admin, Definições → Comunicação → Contactos Google)",
       "level": 2,
       "summary": "Diretório: ligar e indicar a conta do Workspace a usar (ex.: um administrador).",
       "children": [],
       "container": false,
       "chars": 280
      }
     ]
    },
    {
     "id": "criticas",
     "file": "criticas.md",
     "group": "Suporte",
     "module": "criticas",
     "title": "Críticas Google",
     "routes": [
      "/criticas"
     ],
     "tabs": [
      {
       "tab": "dashboard",
       "section": "Dashboard",
       "sectionId": "criticas.md#dashboard"
      },
      {
       "tab": "list",
       "section": "Reviews",
       "sectionId": "criticas.md#reviews"
      },
      {
       "tab": "cleanup",
       "section": "Limpeza",
       "sectionId": "criticas.md#limpeza"
      }
     ],
     "summary": "As avaliações do Google de todos os parques, juntas e separadas por parque, com a resposta preparada aqui.",
     "sections": [
      {
       "id": "criticas.md#inicio",
       "file": "criticas.md",
       "slug": "inicio",
       "title": "Críticas Google",
       "level": 1,
       "summary": "As avaliações do Google de todos os parques, juntas e separadas por parque, com a resposta preparada aqui.",
       "children": [],
       "container": false,
       "chars": 106
      },
      {
       "id": "criticas.md#de-onde-vem",
       "file": "criticas.md",
       "slug": "de-onde-vem",
       "title": "De onde vêm",
       "level": 4,
       "summary": "Pela API do Google (perfis ligados em Integrações): ficam no parque escolhido para o perfil e a resposta publica-se daqui.",
       "children": [],
       "container": false,
       "chars": 1192
      },
      {
       "id": "criticas.md#parque-marca-ou-lixo-ja-nao-ha-sem-parque",
       "file": "criticas.md",
       "slug": "parque-marca-ou-lixo-ja-nao-ha-sem-parque",
       "title": "Parque, marca ou lixo (já não há \"Sem parque\")",
       "level": 2,
       "summary": "Cada crítica fica no parque dela.",
       "children": [
        "criticas.md#dashboard",
        "criticas.md#reviews",
        "criticas.md#responder-respondida-publicada",
        "criticas.md#reclamacoes",
        "criticas.md#dispensar",
        "criticas.md#numeros",
        "criticas.md#quando-a-leitura-falha"
       ],
       "container": false,
       "chars": 506
      },
      {
       "id": "criticas.md#dashboard",
       "file": "criticas.md",
       "slug": "dashboard",
       "title": "Dashboard",
       "level": 4,
       "summary": "Um quadrado por parque com a média, as estrelas, o n.º de avaliações, as por responder e as reclamações.",
       "children": [],
       "container": false,
       "chars": 149
      },
      {
       "id": "criticas.md#reviews",
       "file": "criticas.md",
       "slug": "reviews",
       "title": "Reviews",
       "level": 4,
       "summary": "Um separador por parque.",
       "children": [],
       "container": false,
       "chars": 168
      },
      {
       "id": "criticas.md#responder-respondida-publicada",
       "file": "criticas.md",
       "slug": "responder-respondida-publicada",
       "title": "Responder (respondida = publicada)",
       "level": 4,
       "summary": "A IA só prepara rascunhos; publica sempre uma pessoa (a única exceção são as respostas automáticas às 5★, com o interruptor delas ligado — ver \"Respostas…",
       "children": [],
       "container": false,
       "chars": 1434
      },
      {
       "id": "criticas.md#reclamacoes",
       "file": "criticas.md",
       "slug": "reclamacoes",
       "title": "Reclamações",
       "level": 4,
       "summary": "Criar Reclamação (até 3★): prazo de 24 h e responsável na Reclamação.",
       "children": [],
       "container": false,
       "chars": 253
      },
      {
       "id": "criticas.md#dispensar",
       "file": "criticas.md",
       "slug": "dispensar",
       "title": "Dispensar",
       "level": 4,
       "summary": "Dispensar tira-a de \"por responder\" (pede confirmação); Reabrir devolve-a.",
       "children": [],
       "container": false,
       "chars": 84
      },
      {
       "id": "criticas.md#numeros",
       "file": "criticas.md",
       "slug": "numeros",
       "title": "Números",
       "level": 4,
       "summary": "Respondidas = publicadas no Google.",
       "children": [],
       "container": false,
       "chars": 540
      },
      {
       "id": "criticas.md#quando-a-leitura-falha",
       "file": "criticas.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Lista, números, parques e crítica mostram \"Não foi possível carregar…\" com Tentar de novo, nunca \"sem avaliações\" ou \"sem dados\".",
       "children": [],
       "container": false,
       "chars": 139
      },
      {
       "id": "criticas.md#emails-que-nao-sao-criticas-e-criticas-repetidas",
       "file": "criticas.md",
       "slug": "emails-que-nao-sao-criticas-e-criticas-repetidas",
       "title": "Emails que não são críticas e críticas repetidas",
       "level": 2,
       "summary": "Dois interruptores em Definições → Automações, desligados por omissão.",
       "children": [],
       "container": false,
       "chars": 1650
      },
      {
       "id": "criticas.md#respostas-automaticas-as-5",
       "file": "criticas.md",
       "slug": "respostas-automaticas-as-5",
       "title": "Respostas automáticas às 5★",
       "level": 2,
       "summary": "Interruptor Críticas 5★: publicar a resposta sozinho (6 h depois) em Definições → Automações: desligado por omissão, e só o super admin o liga.",
       "children": [],
       "container": false,
       "chars": 3447
      },
      {
       "id": "criticas.md#limpeza",
       "file": "criticas.md",
       "slug": "limpeza",
       "title": "Limpeza",
       "level": 2,
       "summary": "Separador para admin e super admin, para as que já existem; nunca corre sozinha.",
       "children": [
        "criticas.md#quem-pode"
       ],
       "container": false,
       "chars": 658
      },
      {
       "id": "criticas.md#quem-pode",
       "file": "criticas.md",
       "slug": "quem-pode",
       "title": "Quem pode",
       "level": 4,
       "summary": "Condutores e extras não veem as Críticas — nem as em que estão envolvidos.",
       "children": [],
       "container": false,
       "chars": 263
      }
     ]
    },
    {
     "id": "ocorrencias",
     "file": "ocorrencias.md",
     "group": "Suporte",
     "module": "ocorrencias",
     "title": "Ocorrências",
     "routes": [
      "/ocorrencias"
     ],
     "tabs": [],
     "summary": "As ocorrências registadas pelos agentes na app Multipark (vidro aberto, acidente, atraso…).",
     "sections": [
      {
       "id": "ocorrencias.md#inicio",
       "file": "ocorrencias.md",
       "slug": "inicio",
       "title": "Ocorrências",
       "level": 1,
       "summary": "As ocorrências registadas pelos agentes na app Multipark (vidro aberto, acidente, atraso…).",
       "children": [],
       "container": false,
       "chars": 196
      },
      {
       "id": "ocorrencias.md#ver-e-procurar",
       "file": "ocorrencias.md",
       "slug": "ver-e-procurar",
       "title": "Ver e procurar",
       "level": 4,
       "summary": "Menu Suporte → Ocorrências.",
       "children": [],
       "container": false,
       "chars": 1102
      },
      {
       "id": "ocorrencias.md#fecham-sozinhas-ao-fim-de-3-dias",
       "file": "ocorrencias.md",
       "slug": "fecham-sozinhas-ao-fim-de-3-dias",
       "title": "Fecham sozinhas ao fim de 3 dias",
       "level": 4,
       "summary": "Uma ocorrência de prioridade média, por resolver, que não tenha a ver com dinheiro, danos nem reclamações, fica Fechada (3 dias) no dashboard, 3 dias depois…",
       "children": [],
       "container": false,
       "chars": 1069
      },
      {
       "id": "ocorrencias.md#resolver",
       "file": "ocorrencias.md",
       "slug": "resolver",
       "title": "Resolver",
       "level": 4,
       "summary": "As ocorrências resolvem-se na app Multipark.",
       "children": [],
       "container": false,
       "chars": 284
      },
      {
       "id": "ocorrencias.md#foi-um-acidente-6000-na-avaliacao",
       "file": "ocorrencias.md",
       "slug": "foi-um-acidente-6000-na-avaliacao",
       "title": "Foi um acidente? (−6000 na avaliação)",
       "level": 4,
       "summary": "Ao abrir uma ocorrência, o team leader (ou acima) vê Foi um acidente?.",
       "children": [],
       "container": false,
       "chars": 1116
      },
      {
       "id": "ocorrencias.md#quando-a-leitura-falha",
       "file": "ocorrencias.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "\"Ocorrências indisponíveis\": a base de dados da Multipark não respondeu.",
       "children": [],
       "container": false,
       "chars": 426
      },
      {
       "id": "ocorrencias.md#avisos-de-ocorrencia-por-email",
       "file": "ocorrencias.md",
       "slug": "avisos-de-ocorrencia-por-email",
       "title": "Avisos de ocorrência por email",
       "level": 4,
       "summary": "A app Multipark manda um email por cada ocorrência registada (\"Tipo de ocorrência\", \"Matrícula\", \"Observações\", \"Link reserva\").",
       "children": [],
       "container": false,
       "chars": 938
      },
      {
       "id": "ocorrencias.md#ocorrencias-antigas-do-dashboard",
       "file": "ocorrencias.md",
       "slug": "ocorrencias-antigas-do-dashboard",
       "title": "Ocorrências antigas do dashboard",
       "level": 4,
       "summary": "As ocorrências registadas no dashboard antes da ligação à app Multipark ficam guardadas, mas já não entram nos números nem nos lembretes.",
       "children": [],
       "container": false,
       "chars": 441
      }
     ]
    },
    {
     "id": "perdidos",
     "file": "perdidos.md",
     "group": "Suporte",
     "module": "perdidos",
     "title": "Perdidos e Achados",
     "routes": [
      "/perdidos-achados"
     ],
     "tabs": [],
     "summary": "Objetos esquecidos pelos clientes nos carros.",
     "sections": [
      {
       "id": "perdidos.md#inicio",
       "file": "perdidos.md",
       "slug": "inicio",
       "title": "Perdidos e Achados",
       "level": 1,
       "summary": "Objetos esquecidos pelos clientes nos carros.",
       "children": [],
       "container": false,
       "chars": 45
      },
      {
       "id": "perdidos.md#registar",
       "file": "perdidos.md",
       "slug": "registar",
       "title": "Registar",
       "level": 4,
       "summary": "Menu Suporte → Perdidos e Achados → Novo Registo.",
       "children": [],
       "container": false,
       "chars": 591
      },
      {
       "id": "perdidos.md#por-email",
       "file": "perdidos.md",
       "slug": "por-email",
       "title": "Por email",
       "level": 4,
       "summary": "Os emails para perdidos@ criam o caso sozinhos (como sempre).",
       "children": [],
       "container": false,
       "chars": 2185
      },
      {
       "id": "perdidos.md#tratar",
       "file": "perdidos.md",
       "slug": "tratar",
       "title": "Tratar",
       "level": 4,
       "summary": "Quadro por estados: Novo → Investigação → Encontrado → Devolvido/Fechado.",
       "children": [],
       "container": false,
       "chars": 1436
      },
      {
       "id": "perdidos.md#condutores-do-caso-team-leader-e-acima",
       "file": "perdidos.md",
       "slug": "condutores-do-caso-team-leader-e-acima",
       "title": "Condutores do caso (team leader e acima)",
       "level": 2,
       "summary": "Quem mexeu no carro: agentes da Multipark com ações na matrícula, ligados à ficha pela conta do agente (nunca pelo nome); ações de sistema/API não contam.",
       "children": [
        "perdidos.md#arquivar-em-vez-de-eliminar",
        "perdidos.md#quando-a-leitura-falha",
        "perdidos.md#quem-pode"
       ],
       "container": false,
       "chars": 680
      },
      {
       "id": "perdidos.md#arquivar-em-vez-de-eliminar",
       "file": "perdidos.md",
       "slug": "arquivar-em-vez-de-eliminar",
       "title": "Arquivar (em vez de eliminar)",
       "level": 4,
       "summary": "Arquivar (admin) pede o motivo.",
       "children": [],
       "container": false,
       "chars": 237
      },
      {
       "id": "perdidos.md#quando-a-leitura-falha",
       "file": "perdidos.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Lista, caso, fotos, mensagens, reserva, histórico, condutores, correspondências e cruzamento mostram \"Não foi possível carregar…\" com Tentar de novo.",
       "children": [],
       "container": false,
       "chars": 271
      },
      {
       "id": "perdidos.md#quem-pode",
       "file": "perdidos.md",
       "slug": "quem-pode",
       "title": "Quem pode",
       "level": 4,
       "summary": "CSV (leva contactos do cliente): só quem pode exportar.",
       "children": [],
       "container": false,
       "chars": 334
      }
     ]
    },
    {
     "id": "reclamacoes",
     "file": "reclamacoes.md",
     "group": "Suporte",
     "module": "reclamacoes",
     "title": "Reclamações",
     "routes": [
      "/reclamacoes"
     ],
     "tabs": [],
     "summary": "Casos de clientes insatisfeitos (danos, sujidade, atraso, cobrança, staff…).",
     "sections": [
      {
       "id": "reclamacoes.md#inicio",
       "file": "reclamacoes.md",
       "slug": "inicio",
       "title": "Reclamações",
       "level": 1,
       "summary": "Casos de clientes insatisfeitos (danos, sujidade, atraso, cobrança, staff…).",
       "children": [],
       "container": false,
       "chars": 76
      },
      {
       "id": "reclamacoes.md#criar",
       "file": "reclamacoes.md",
       "slug": "criar",
       "title": "Criar",
       "level": 4,
       "summary": "Menu Suporte → Reclamações → Nova Reclamação.",
       "children": [],
       "container": false,
       "chars": 865
      },
      {
       "id": "reclamacoes.md#reclamacoes-que-a-ia-ve-noutras-caixas",
       "file": "reclamacoes.md",
       "slug": "reclamacoes-que-a-ia-ve-noutras-caixas",
       "title": "Reclamações que a IA vê noutras caixas",
       "level": 4,
       "summary": "A IA lê cada email das caixas partilhadas (info@, reservas@, cancelamentos…) pelo sentido — não por palavras.",
       "children": [],
       "container": false,
       "chars": 4164
      },
      {
       "id": "reclamacoes.md#filtros",
       "file": "reclamacoes.md",
       "slug": "filtros",
       "title": "Filtros",
       "level": 4,
       "summary": "Pesquisar: nº, título, nome, email, telefone, reserva, matrícula e responsável (sem acentos nem traços: \"aa12bb\" encontra \"AA-12-BB\"). #12 abre só a…",
       "children": [],
       "container": false,
       "chars": 1150
      },
      {
       "id": "reclamacoes.md#tratar",
       "file": "reclamacoes.md",
       "slug": "tratar",
       "title": "Tratar",
       "level": 4,
       "summary": "O quadro mostra os estados: Novo → Em Análise → Aguarda Cliente → Resolvido/Fechado.",
       "children": [],
       "container": false,
       "chars": 2941
      },
      {
       "id": "reclamacoes.md#prazo-sla",
       "file": "reclamacoes.md",
       "slug": "prazo-sla",
       "title": "Prazo (SLA)",
       "level": 4,
       "summary": "O prazo corre em Novo e Em Análise; em Aguarda Cliente para.",
       "children": [],
       "container": false,
       "chars": 222
      },
      {
       "id": "reclamacoes.md#condutores-em-servico",
       "file": "reclamacoes.md",
       "slug": "condutores-em-servico",
       "title": "Condutores (Em serviço)",
       "level": 4,
       "summary": "Sugeridos: quem mexeu na reserva (ligado à ficha pela conta do agente na Multipark, nunca pelo nome) e quem estava escalado (confirmado) nos dias de entrada e…",
       "children": [],
       "container": false,
       "chars": 350
      },
      {
       "id": "reclamacoes.md#fotos",
       "file": "reclamacoes.md",
       "slug": "fotos",
       "title": "Fotos",
       "level": 4,
       "summary": "Só fotos (JPG, PNG, WebP, GIF, HEIC).",
       "children": [],
       "container": false,
       "chars": 148
      },
      {
       "id": "reclamacoes.md#arquivar-em-vez-de-eliminar",
       "file": "reclamacoes.md",
       "slug": "arquivar-em-vez-de-eliminar",
       "title": "Arquivar (em vez de eliminar)",
       "level": 4,
       "summary": "Arquivar (admin) pede o motivo.",
       "children": [],
       "container": false,
       "chars": 244
      },
      {
       "id": "reclamacoes.md#quando-a-leitura-falha",
       "file": "reclamacoes.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Lista, caso, reserva, histórico, condutores, sugestões da IA, histórico do cliente e emails do cliente mostram \"Não foi possível carregar…\" com Tentar de novo.",
       "children": [],
       "container": false,
       "chars": 413
      },
      {
       "id": "reclamacoes.md#quem-pode",
       "file": "reclamacoes.md",
       "slug": "quem-pode",
       "title": "Quem pode",
       "level": 4,
       "summary": "Ver, criar e tratar: conforme o acesso a Reclamações, sempre na tua cidade.",
       "children": [],
       "container": false,
       "chars": 513
      }
     ]
    }
   ]
  },
  {
   "group": "Comunicação",
   "pages": [
    {
     "id": "central",
     "file": "central.md",
     "group": "Comunicação",
     "module": "central",
     "title": "Central (as minhas chamadas)",
     "routes": [
      "/central"
     ],
     "tabs": [],
     "summary": "Menu Comunicação → Central.",
     "sections": [
      {
       "id": "central.md#inicio",
       "file": "central.md",
       "slug": "inicio",
       "title": "Central (as minhas chamadas)",
       "level": 1,
       "summary": "Menu Comunicação → Central.",
       "children": [],
       "container": false,
       "chars": 131
      },
      {
       "id": "central.md#quem-ve-o-que",
       "file": "central.md",
       "slug": "quem-ve-o-que",
       "title": "Quem vê o quê",
       "level": 4,
       "summary": "Cada pessoa vê só as suas chamadas (team leader, supervisor, front office e back office).",
       "children": [],
       "container": false,
       "chars": 335
      },
      {
       "id": "central.md#o-que-mostra",
       "file": "central.md",
       "slug": "o-que-mostra",
       "title": "O que mostra",
       "level": 4,
       "summary": "Período (Hoje e ontem, 7, 30 ou 90 dias) e Todas / Recebidas / Feitas.",
       "children": [],
       "container": false,
       "chars": 839
      },
      {
       "id": "central.md#quando-a-central-toca-no-dashboard",
       "file": "central.md",
       "slug": "quando-a-central-toca-no-dashboard",
       "title": "Quando a central toca no dashboard",
       "level": 4,
       "summary": "Com o \"tocar no dashboard\" ligado, a chamada aparece ao meio, em cima, e toca no máximo 12 segundos.",
       "children": [],
       "container": false,
       "chars": 506
      }
     ]
    },
    {
     "id": "comunicacao",
     "file": "comunicacao.md",
     "group": "Comunicação",
     "module": "comunicacao",
     "title": "Comunicação (email e calendário)",
     "routes": [
      "/comunicacao",
      "/comunicacao/meu-email",
      "/calendario"
     ],
     "tabs": [],
     "summary": "Os emails das caixas partilhadas da empresa e o teu próprio email @multipark, dentro do dashboard.",
     "sections": [
      {
       "id": "comunicacao.md#inicio",
       "file": "comunicacao.md",
       "slug": "inicio",
       "title": "Comunicação (email e calendário)",
       "level": 1,
       "summary": "Os emails das caixas partilhadas da empresa e o teu próprio email @multipark, dentro do dashboard.",
       "children": [],
       "container": false,
       "chars": 263
      },
      {
       "id": "comunicacao.md#caixas-de-email-menu-comunicacao-caixas-de-email",
       "file": "comunicacao.md",
       "slug": "caixas-de-email-menu-comunicacao-caixas-de-email",
       "title": "Caixas de email (menu Comunicação → Caixas de email)",
       "level": 2,
       "summary": "As caixas ficam à esquerda, umas por baixo das outras, como no Gmail: carregas numa e a lista muda logo ao lado, sem sair da página.",
       "children": [],
       "container": false,
       "chars": 4678
      },
      {
       "id": "comunicacao.md#o-resto-da-comunicacao-menu-por-esta-ordem",
       "file": "comunicacao.md",
       "slug": "o-resto-da-comunicacao-menu-por-esta-ordem",
       "title": "O resto da Comunicação (menu, por esta ordem)",
       "level": 2,
       "summary": "Caixas de email → O meu email → Drive → WhatsApp → Central → Calendário → Tarefas.",
       "children": [
        "comunicacao.md#caixas-por-tema"
       ],
       "container": false,
       "chars": 823
      },
      {
       "id": "comunicacao.md#caixas-por-tema",
       "file": "comunicacao.md",
       "slug": "caixas-por-tema",
       "title": "Caixas por tema",
       "level": 4,
       "summary": "As caixas são as mesmas do WhatsApp: além das que já havia (Reclamações, Perdidos, Críticas, Ocorrências, RH, Info, Comercial…) há Alterações, Cancelamentos…",
       "children": [],
       "container": false,
       "chars": 5313
      },
      {
       "id": "comunicacao.md#ligar-whatsapp-e-email-a-partir-das-fichas-ficha-do-cliente",
       "file": "comunicacao.md",
       "slug": "ligar-whatsapp-e-email-a-partir-das-fichas-ficha-do-cliente",
       "title": "Ligar, WhatsApp e email a partir das fichas (ficha do cliente, da reserva e do colaborador)",
       "level": 2,
       "summary": "WhatsApp abre a conversa desse número.",
       "children": [
        "comunicacao.md#ligacoes"
       ],
       "container": false,
       "chars": 830
      },
      {
       "id": "comunicacao.md#ligacoes",
       "file": "comunicacao.md",
       "slug": "ligacoes",
       "title": "Ligações",
       "level": 4,
       "summary": "Cada email fica ligado automaticamente ao cliente, à reserva, à reclamação, ao perdido ou à ocorrência da app (com a confiança da ligação).",
       "children": [],
       "container": false,
       "chars": 500
      },
      {
       "id": "comunicacao.md#emails-que-criam-casos-reclamacoes-perdidos-criticas",
       "file": "comunicacao.md",
       "slug": "emails-que-criam-casos-reclamacoes-perdidos-criticas",
       "title": "Emails que criam casos (reclamacoes@, perdidos@, críticas…)",
       "level": 2,
       "summary": "Com \"Críticas: só cria crítica a partir de um aviso de avaliação\" (Definições → Automações, desligado por omissão), um email que entrou pela caixa Críticas…",
       "children": [
        "comunicacao.md#caixas-super-admin"
       ],
       "container": false,
       "chars": 642
      },
      {
       "id": "comunicacao.md#caixas-super-admin",
       "file": "comunicacao.md",
       "slug": "caixas-super-admin",
       "title": "Caixas (super admin)",
       "level": 4,
       "summary": "Uma caixa já não se apaga: Desativar tira-a das listas e da sincronização, e as conversas ficam guardadas (o super admin continua a vê-las).",
       "children": [],
       "container": false,
       "chars": 179
      },
      {
       "id": "comunicacao.md#o-meu-email-menu-comunicacao-o-meu-email-ou-o-meu-email-na-l",
       "file": "comunicacao.md",
       "slug": "o-meu-email-menu-comunicacao-o-meu-email-ou-o-meu-email-na-l",
       "title": "O meu email (menu Comunicação → O meu email, ou O meu email na lista das caixas)",
       "level": 2,
       "summary": "Carrega em Ligar a minha conta Google (também no Perfil).",
       "children": [
        "comunicacao.md#seguranca",
        "comunicacao.md#quando-a-leitura-falha"
       ],
       "container": false,
       "chars": 662
      },
      {
       "id": "comunicacao.md#seguranca",
       "file": "comunicacao.md",
       "slug": "seguranca",
       "title": "Segurança",
       "level": 4,
       "summary": "As imagens de fora ficam bloqueadas até carregares em Mostrar imagens (evita pixels de rastreio).",
       "children": [],
       "container": false,
       "chars": 978
      },
      {
       "id": "comunicacao.md#quando-a-leitura-falha",
       "file": "comunicacao.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Caixas, lista, conversa, comunicações de um registo e a classificação mostram \"Não foi possível carregar…\" com Tentar de novo.",
       "children": [],
       "container": false,
       "chars": 246
      },
      {
       "id": "comunicacao.md#calendario-menu-comunicacao-calendario-em-calendario",
       "file": "comunicacao.md",
       "slug": "calendario-menu-comunicacao-calendario-em-calendario",
       "title": "Calendário (menu Comunicação → Calendário, em /calendario)",
       "level": 2,
       "summary": "A tua agenda do Google Calendar dentro do dashboard, como no Google.",
       "children": [],
       "container": false,
       "chars": 2694
      }
     ]
    },
    {
     "id": "comunicacao.aliases",
     "file": "email-aliases.md",
     "group": "Comunicação",
     "module": "comunicacao",
     "title": "Email por alias (encaminhamento, Por classificar e envio)",
     "routes": [
      "/definicoes",
      "/comunicacao"
     ],
     "tabs": [],
     "summary": "Todo o email passa pela API do Gmail — não há SMTP nem IMAP.",
     "sections": [
      {
       "id": "email-aliases.md#inicio",
       "file": "email-aliases.md",
       "slug": "inicio",
       "title": "Email por alias (encaminhamento, Por classificar e envio)",
       "level": 1,
       "summary": "Todo o email passa pela API do Gmail — não há SMTP nem IMAP.",
       "children": [],
       "container": false,
       "chars": 273
      },
      {
       "id": "email-aliases.md#o-workspace-real-multipark-pt-set-2026",
       "file": "email-aliases.md",
       "slug": "o-workspace-real-multipark-pt-set-2026",
       "title": "O Workspace real (multipark.pt, set 2026)",
       "level": 2,
       "summary": "Duas contas partilhadas: reservas@multipark.pt (aliases reclamacoes@, perdidos@, criticas@, recursos-humanos@, escala@) e info@multipark.pt (aliases redpark@…",
       "children": [
        "email-aliases.md#como-o-alias-e-lido"
       ],
       "container": false,
       "chars": 2699
      },
      {
       "id": "email-aliases.md#como-o-alias-e-lido",
       "file": "email-aliases.md",
       "slug": "como-o-alias-e-lido",
       "title": "Como o alias é lido",
       "level": 4,
       "summary": "Por esta ordem: Delivered-To → X-Original-To → To → Cc (nos enviados, o From).",
       "children": [],
       "container": false,
       "chars": 275
      },
      {
       "id": "email-aliases.md#preencher-a-tabela-definicoes-comunicacao-encaminhamento-por",
       "file": "email-aliases.md",
       "slug": "preencher-a-tabela-definicoes-comunicacao-encaminhamento-por",
       "title": "Preencher a tabela (Definições → Comunicação → Encaminhamento por alias; admin e super admin)",
       "level": 2,
       "summary": "+ Alias e escreve o endereço completo (qualquer domínio: reservas@skypark.pt, info@multibacks.app…).",
       "children": [],
       "container": false,
       "chars": 760
      },
      {
       "id": "email-aliases.md#depois-do-alias-a-triagem-da-ia-14-out-2026",
       "file": "email-aliases.md",
       "slug": "depois-do-alias-a-triagem-da-ia-14-out-2026",
       "title": "Depois do alias: a triagem da IA (14 out 2026)",
       "level": 2,
       "summary": "O alias decide a caixa onde o email entra.",
       "children": [],
       "container": false,
       "chars": 1029
      },
      {
       "id": "email-aliases.md#por-classificar-comunicacao-caixa-por-classificar-so-admin-e",
       "file": "email-aliases.md",
       "slug": "por-classificar-comunicacao-caixa-por-classificar-so-admin-e",
       "title": "Por classificar (Comunicação → caixa Por classificar, só admin e super admin)",
       "level": 2,
       "summary": "Emails que chegaram por um endereço fora da tabela (ex.: em Bcc, ou um alias novo por configurar).",
       "children": [
        "email-aliases.md#envio",
        "email-aliases.md#o-que-falta-do-lado-do-dono"
       ],
       "container": false,
       "chars": 406
      },
      {
       "id": "email-aliases.md#envio",
       "file": "email-aliases.md",
       "slug": "envio",
       "title": "Envio",
       "level": 4,
       "summary": "Emails de sistema (notificações, briefing, escala, tarefas, formação, relatórios) saem da conta em Envio de email (Gmail) (Definições → Comunicação; Testar…",
       "children": [],
       "container": false,
       "chars": 574
      },
      {
       "id": "email-aliases.md#o-que-falta-do-lado-do-dono",
       "file": "email-aliases.md",
       "slug": "o-que-falta-do-lado-do-dono",
       "title": "O que falta do lado do dono",
       "level": 4,
       "summary": "Se quiser airpark.pt: Google Admin → Domínios → acrescentar airpark.pt como domínio alternativo (depois acrescenta-o também em Definições → Parâmetros →…",
       "children": [],
       "container": false,
       "chars": 748
      }
     ]
    },
    {
     "id": "drive",
     "file": "drive.md",
     "group": "Comunicação",
     "module": "drive",
     "title": "Google Drive, Docs e Sheets",
     "routes": [
      "/drive",
      "/perfil"
     ],
     "tabs": [],
     "summary": "Liga ficheiros do Google Drive aos registos, guarda anexos e documentos no teu Drive, gera documentos a partir de modelos Google Docs e exporta relatórios…",
     "sections": [
      {
       "id": "drive.md#inicio",
       "file": "drive.md",
       "slug": "inicio",
       "title": "Google Drive, Docs e Sheets",
       "level": 1,
       "summary": "Liga ficheiros do Google Drive aos registos, guarda anexos e documentos no teu Drive, gera documentos a partir de modelos Google Docs e exporta relatórios…",
       "children": [],
       "container": false,
       "chars": 176
      },
      {
       "id": "drive.md#abrir-o-drive-menu-comunicacao-drive",
       "file": "drive.md",
       "slug": "abrir-o-drive-menu-comunicacao-drive",
       "title": "Abrir o Drive (menu Comunicação → Drive)",
       "level": 2,
       "summary": "Abre o Drive da empresa (o Shared Drive configurado) num separador novo, na tua conta Google: a que ligaste no Perfil → Google ou, sem ela, o email com que…",
       "children": [],
       "container": false,
       "chars": 573
      },
      {
       "id": "drive.md#ativar-o-drive-cada-pessoa-no-perfil-google-drive",
       "file": "drive.md",
       "slug": "ativar-o-drive-cada-pessoa-no-perfil-google-drive",
       "title": "Ativar o Drive (cada pessoa, no Perfil → Google Drive)",
       "level": 2,
       "summary": "Liga primeiro a tua conta Google (Perfil → Google).",
       "children": [],
       "container": false,
       "chars": 563
      },
      {
       "id": "drive.md#anexar-do-drive-clientes-reclamacoes-conversas-de-email-fich",
       "file": "drive.md",
       "slug": "anexar-do-drive-clientes-reclamacoes-conversas-de-email-fich",
       "title": "Anexar do Drive (clientes, reclamações, conversas de email, fichas do RH, tarefas e parcerias)",
       "level": 2,
       "summary": "Abre o registo e, em Google Drive, carrega em Anexar do Drive.",
       "children": [
        "drive.md#guardar-no-drive"
       ],
       "container": false,
       "chars": 536
      },
      {
       "id": "drive.md#guardar-no-drive",
       "file": "drive.md",
       "slug": "guardar-no-drive",
       "title": "Guardar no Drive",
       "level": 4,
       "summary": "Nos anexos dos emails e nas fotos/provas das reclamações há o botão Guardar no meu Drive (ícone do Drive).",
       "children": [],
       "container": false,
       "chars": 313
      },
      {
       "id": "drive.md#gerar-documento-contrato-de-trabalho-declaracao-resposta-a-r",
       "file": "drive.md",
       "slug": "gerar-documento-contrato-de-trabalho-declaracao-resposta-a-r",
       "title": "Gerar documento (contrato de trabalho, declaração, resposta a reclamação, propostas)",
       "level": 2,
       "summary": "Na ficha do colaborador (RH → Documentos), na reclamação (separador Comunicações), no cliente ou na parceria (ícone do Drive), carrega em Gerar documento.",
       "children": [],
       "container": false,
       "chars": 763
      },
      {
       "id": "drive.md#exportar-para-sheets-faturacao-financeiro-clientes-avaliacao",
       "file": "drive.md",
       "slug": "exportar-para-sheets-faturacao-financeiro-clientes-avaliacao",
       "title": "Exportar para Sheets (Faturação, Financeiro, Clientes, Avaliação individual, Métricas dos extras)",
       "level": 2,
       "summary": "O botão Exportar para Sheets cria uma folha nova na tua pasta \"Multipark\" com os mesmos números da página (e as mesmas permissões e cidades).",
       "children": [],
       "container": false,
       "chars": 268
      },
      {
       "id": "drive.md#importar-do-google-sheets-importar-extras-no-rh-historico-fi",
       "file": "drive.md",
       "slug": "importar-do-google-sheets-importar-extras-no-rh-historico-fi",
       "title": "Importar do Google Sheets (Importar extras no RH; histórico financeiro no Anual)",
       "level": 2,
       "summary": "Carrega em Importar do Google Sheets e escolhe a folha ou cola o link de qualquer folha que consegues abrir no Google (precisa da leitura de folhas autorizada…",
       "children": [],
       "container": false,
       "chars": 376
      },
      {
       "id": "drive.md#configuracao-definicoes-comunicacao-google-drive",
       "file": "drive.md",
       "slug": "configuracao-definicoes-comunicacao-google-drive",
       "title": "Configuração (Definições → Comunicação → Google Drive)",
       "level": 2,
       "summary": "Super admin: Shared Drive da empresa (conta do Workspace membro do Shared Drive e nome) e cópia automática das provas das reclamações.",
       "children": [],
       "container": false,
       "chars": 1256
      }
     ]
    },
    {
     "id": "whatsapp",
     "file": "whatsapp.md",
     "group": "Comunicação",
     "module": "whatsapp",
     "title": "WhatsApp",
     "routes": [
      "/whatsapp"
     ],
     "tabs": [],
     "summary": "Caixa de entrada partilhada das conversas de WhatsApp com colaboradores e clientes.",
     "sections": [
      {
       "id": "whatsapp.md#inicio",
       "file": "whatsapp.md",
       "slug": "inicio",
       "title": "WhatsApp",
       "level": 1,
       "summary": "Caixa de entrada partilhada das conversas de WhatsApp com colaboradores e clientes.",
       "children": [],
       "container": false,
       "chars": 83
      },
      {
       "id": "whatsapp.md#quem-ve-o-que",
       "file": "whatsapp.md",
       "slug": "quem-ve-o-que",
       "title": "Quem vê o quê",
       "level": 4,
       "summary": "Cada pessoa vê as conversas das suas cidades: um colaborador pela cidade da ficha, um lead pela cidade do lead, um número solto pela cidade da reserva com…",
       "children": [],
       "container": false,
       "chars": 325
      },
      {
       "id": "whatsapp.md#comecar-uma-conversa",
       "file": "whatsapp.md",
       "slug": "comecar-uma-conversa",
       "title": "Começar uma conversa",
       "level": 4,
       "summary": "Nas fichas do cliente, da reserva e do colaborador há o botão WhatsApp: abre a conversa desse número ou cria-a (sem enviar nada).",
       "children": [],
       "container": false,
       "chars": 199
      },
      {
       "id": "whatsapp.md#quem-e",
       "file": "whatsapp.md",
       "slug": "quem-e",
       "title": "Quem é",
       "level": 4,
       "summary": "O nome da conversa vem da ficha do colaborador, do candidato a extra ou do cliente no CRM (pelo número); só depois o nome do perfil do WhatsApp.",
       "children": [],
       "container": false,
       "chars": 437
      },
      {
       "id": "whatsapp.md#responder",
       "file": "whatsapp.md",
       "slug": "responder",
       "title": "Responder",
       "level": 4,
       "summary": "Menu Comunicação → WhatsApp (o WhatsApp tem a página dele; as Caixas de email são só de email).",
       "children": [],
       "container": false,
       "chars": 1629
      },
      {
       "id": "whatsapp.md#estado-de-cada-mensagem-enviada-o-icone-ao-lado-da-hora-pass",
       "file": "whatsapp.md",
       "slug": "estado-de-cada-mensagem-enviada-o-icone-ao-lado-da-hora-pass",
       "title": "Estado de cada mensagem enviada (o ícone ao lado da hora; passa o rato para ver o nome)",
       "level": 2,
       "summary": "🕓 A enviar → ✓ esbatido Aceite (a Meta aceitou o pedido, mas ainda não avisou que saiu) → ✓ Enviado → ✓✓ Entregue → ✓✓ azul Lido.",
       "children": [
        "whatsapp.md#mensagem-sem-confirmacao",
        "whatsapp.md#templates-por-cidade-motoristas-extra",
        "whatsapp.md#respostas-automaticas-sem-uma-pessoa",
        "whatsapp.md#caixas-por-tema",
        "whatsapp.md#organizar",
        "whatsapp.md#conversas-de-colaboradores-e-a-ia",
        "whatsapp.md#a-triagem-propoe-o-caso",
        "whatsapp.md#ficheiros-e-localizacoes-recebidos",
        "whatsapp.md#envios-em-massa-extras-dia-leads",
        "whatsapp.md#respostas-rapidas",
        "whatsapp.md#quando-a-leitura-falha",
        "whatsapp.md#chamadas-de-voz"
       ],
       "container": false,
       "chars": 277
      },
      {
       "id": "whatsapp.md#mensagem-sem-confirmacao",
       "file": "whatsapp.md",
       "slug": "mensagem-sem-confirmacao",
       "title": "Mensagem \"sem confirmação\"",
       "level": 4,
       "summary": "Se a Meta não responder ao envio (rede, prazo), a mensagem fica com ⚠ \"Sem confirmação da Meta: pode ter chegado ao cliente\".",
       "children": [],
       "container": false,
       "chars": 408
      },
      {
       "id": "whatsapp.md#templates-por-cidade-motoristas-extra",
       "file": "whatsapp.md",
       "slug": "templates-por-cidade-motoristas-extra",
       "title": "Templates por cidade (motoristas extra)",
       "level": 4,
       "summary": "Recrutamento, morada e regras, aviso de trabalho, turno confirmado e pedido de disponibilidade têm uma versão por cidade (Lisboa e Porto).",
       "children": [],
       "container": false,
       "chars": 941
      },
      {
       "id": "whatsapp.md#respostas-automaticas-sem-uma-pessoa",
       "file": "whatsapp.md",
       "slug": "respostas-automaticas-sem-uma-pessoa",
       "title": "Respostas automáticas (sem uma pessoa)",
       "level": 4,
       "summary": "Confirmação do STOP / INICIAR (sempre).",
       "children": [],
       "container": false,
       "chars": 718
      },
      {
       "id": "whatsapp.md#caixas-por-tema",
       "file": "whatsapp.md",
       "slug": "caixas-por-tema",
       "title": "Caixas por tema",
       "level": 4,
       "summary": "Cada conversa fica numa caixa: Recursos Humanos, Reservas, Alterações, Cancelamentos, Serviços extra, Reclamações, Perdidos e Achados, Parcerias, Faturação……",
       "children": [],
       "container": false,
       "chars": 1296
      },
      {
       "id": "whatsapp.md#organizar",
       "file": "whatsapp.md",
       "slug": "organizar",
       "title": "Organizar",
       "level": 4,
       "summary": "Estados: Aberta (precisa de atenção), Pendente (à espera de algo), Resolvida.",
       "children": [],
       "container": false,
       "chars": 1361
      },
      {
       "id": "whatsapp.md#conversas-de-colaboradores-e-a-ia",
       "file": "whatsapp.md",
       "slug": "conversas-de-colaboradores-e-a-ia",
       "title": "Conversas de colaboradores e a IA",
       "level": 4,
       "summary": "Interruptor \"IA: não ler com IA as conversas de colaboradores no WhatsApp\", desligado por omissão.",
       "children": [],
       "container": false,
       "chars": 814
      },
      {
       "id": "whatsapp.md#a-triagem-propoe-o-caso",
       "file": "whatsapp.md",
       "slug": "a-triagem-propoe-o-caso",
       "title": "A triagem propõe o caso",
       "level": 4,
       "summary": "Quando a triagem por IA acha que a conversa de um cliente é uma reclamação ou um perdido/achado, aparece por cima das mensagens: \"A triagem acha que isto é…",
       "children": [],
       "container": false,
       "chars": 686
      },
      {
       "id": "whatsapp.md#ficheiros-e-localizacoes-recebidos",
       "file": "whatsapp.md",
       "slug": "ficheiros-e-localizacoes-recebidos",
       "title": "Ficheiros e localizações recebidos",
       "level": 4,
       "summary": "Imagens, áudios, vídeos e documentos ficam guardados até 16 MB.",
       "children": [],
       "container": false,
       "chars": 392
      },
      {
       "id": "whatsapp.md#envios-em-massa-extras-dia-leads",
       "file": "whatsapp.md",
       "slug": "envios-em-massa-extras-dia-leads",
       "title": "Envios em massa (Extras-Dia, leads)",
       "level": 4,
       "summary": "Só com templates aprovados.",
       "children": [],
       "container": false,
       "chars": 1297
      },
      {
       "id": "whatsapp.md#respostas-rapidas",
       "file": "whatsapp.md",
       "slug": "respostas-rapidas",
       "title": "Respostas rápidas",
       "level": 4,
       "summary": "Por cidade: cada cidade vê as suas e as nacionais.",
       "children": [],
       "container": false,
       "chars": 290
      },
      {
       "id": "whatsapp.md#quando-a-leitura-falha",
       "file": "whatsapp.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 4,
       "summary": "Lista, conversa, contexto e respostas rápidas mostram \"Não foi possível carregar…\" com Tentar de novo, nunca \"Ainda sem conversas\" ou \"janela fechada\".",
       "children": [],
       "container": false,
       "chars": 161
      },
      {
       "id": "whatsapp.md#chamadas-de-voz",
       "file": "whatsapp.md",
       "slug": "chamadas-de-voz",
       "title": "Chamadas de voz",
       "level": 4,
       "summary": "Os clientes podem ligar para o WhatsApp da empresa e a chamada toca no dashboard (Atender / Recusar); na conversa há o botão Ligar para devolver chamadas.",
       "children": [],
       "container": false,
       "chars": 210
      }
     ]
    },
    {
     "id": "whatsapp.chamadas",
     "file": "whatsapp-chamadas.md",
     "group": "Comunicação",
     "module": "whatsapp_chamadas",
     "title": "WhatsApp — Chamadas de voz",
     "routes": [
      "/whatsapp"
     ],
     "tabs": [],
     "summary": "Os clientes podem ligar para o número de WhatsApp da empresa e a chamada é atendida no dashboard, no browser (microfone e colunas/auscultadores do computador).",
     "sections": [
      {
       "id": "whatsapp-chamadas.md#inicio",
       "file": "whatsapp-chamadas.md",
       "slug": "inicio",
       "title": "WhatsApp — Chamadas de voz",
       "level": 1,
       "summary": "Os clientes podem ligar para o número de WhatsApp da empresa e a chamada é atendida no dashboard, no browser (microfone e colunas/auscultadores do computador).",
       "children": [],
       "container": false,
       "chars": 230
      },
      {
       "id": "whatsapp-chamadas.md#atender",
       "file": "whatsapp-chamadas.md",
       "slug": "atender",
       "title": "Atender",
       "level": 2,
       "summary": "Quando um cliente liga, aparece um aviso \"Chamada WhatsApp\" com toque, em qualquer página, a quem tem o WhatsApp com permissão de editar na cidade da conversa…",
       "children": [],
       "container": false,
       "chars": 1610
      },
      {
       "id": "whatsapp-chamadas.md#aviso-com-o-separador-em-segundo-plano",
       "file": "whatsapp-chamadas.md",
       "slug": "aviso-com-o-separador-em-segundo-plano",
       "title": "Aviso com o separador em segundo plano",
       "level": 2,
       "summary": "O toque chega ao dashboard em cerca de 1 segundo, mesmo com o separador escondido, desde que o separador esteja aberto.",
       "children": [],
       "container": false,
       "chars": 729
      },
      {
       "id": "whatsapp-chamadas.md#ligar-devolver-uma-chamada",
       "file": "whatsapp-chamadas.md",
       "slug": "ligar-devolver-uma-chamada",
       "title": "Ligar / devolver uma chamada",
       "level": 2,
       "summary": "Abre a conversa e carrega em Ligar.",
       "children": [
        "whatsapp-chamadas.md#limites-da-meta-o-dashboard-avisa"
       ],
       "container": false,
       "chars": 748
      },
      {
       "id": "whatsapp-chamadas.md#limites-da-meta-o-dashboard-avisa",
       "file": "whatsapp-chamadas.md",
       "slug": "limites-da-meta-o-dashboard-avisa",
       "title": "Limites da Meta (o dashboard avisa)",
       "level": 3,
       "summary": "pedidos de autorização: 1 por 24 h e 2 por 7 dias, por cliente;",
       "children": [],
       "container": false,
       "chars": 386
      },
      {
       "id": "whatsapp-chamadas.md#configuracao-dono-super-admin",
       "file": "whatsapp-chamadas.md",
       "slug": "configuracao-dono-super-admin",
       "title": "Configuração (dono / super admin)",
       "level": 2,
       "summary": "Interruptor geral: Definições → Automações → Chamadas de voz do WhatsApp vem desligado.",
       "children": [],
       "container": false,
       "chars": 2022
      },
      {
       "id": "whatsapp-chamadas.md#quando-a-leitura-falha",
       "file": "whatsapp-chamadas.md",
       "slug": "quando-a-leitura-falha",
       "title": "Quando a leitura falha",
       "level": 2,
       "summary": "A lista por devolver, as chamadas da conversa e a configuração das chamadas mostram \"Não foi possível carregar…\" com Tentar de novo — nunca \"Nada por…",
       "children": [],
       "container": false,
       "chars": 266
      },
      {
       "id": "whatsapp-chamadas.md#problemas-comuns",
       "file": "whatsapp-chamadas.md",
       "slug": "problemas-comuns",
       "title": "Problemas comuns",
       "level": 2,
       "summary": "Não toca: o separador tem de estar aberto (pode estar em segundo plano, com o som ligado).",
       "children": [],
       "container": false,
       "chars": 515
      }
     ]
    }
   ]
  },
  {
   "group": "Sistema",
   "pages": [
    {
     "id": "api-keys",
     "file": "api-keys.md",
     "group": "Sistema",
     "module": "api_keys",
     "title": "API Keys (chaves para o site, o MCP e os dispositivos)",
     "routes": [
      "/api-keys"
     ],
     "tabs": [
      {
       "tab": "keys",
       "section": "Criar e gerir as chaves",
       "sectionId": "api-keys.md#criar-e-gerir-as-chaves"
      },
      {
       "tab": "docs",
       "section": "Documentação API",
       "sectionId": "api-keys.md#documentacao-api"
      }
     ],
     "summary": "Página API Keys (menu Sistema, só super admin): as chaves que os programas de fora usam para falar com a dashboard — o site (candidaturas e disponibilidades)…",
     "sections": [
      {
       "id": "api-keys.md#inicio",
       "file": "api-keys.md",
       "slug": "inicio",
       "title": "API Keys (chaves para o site, o MCP e os dispositivos)",
       "level": 1,
       "summary": "Página API Keys (menu Sistema, só super admin): as chaves que os programas de fora usam para falar com a dashboard — o site (candidaturas e disponibilidades)…",
       "children": [],
       "container": false,
       "chars": 320
      },
      {
       "id": "api-keys.md#criar-e-gerir-as-chaves",
       "file": "api-keys.md",
       "slug": "criar-e-gerir-as-chaves",
       "title": "Criar e gerir as chaves",
       "level": 2,
       "summary": "Cada chave diz o que pode fazer (desde out 2026).",
       "children": [],
       "container": false,
       "chars": 3310
      },
      {
       "id": "api-keys.md#documentacao-api",
       "file": "api-keys.md",
       "slug": "documentacao-api",
       "title": "Documentação API",
       "level": 2,
       "summary": "Documentação API (segundo separador): exemplos de cada rota e a capacidade que pede.",
       "children": [],
       "container": false,
       "chars": 169
      }
     ]
    },
    {
     "id": "definicoes",
     "file": "definicoes.md",
     "group": "Sistema",
     "module": "definicoes",
     "title": "Definições",
     "routes": [
      "/definicoes"
     ],
     "tabs": [
      {
       "tab": "estado",
       "section": "Estado",
       "sectionId": "definicoes.md#estado"
      },
      {
       "tab": "automacoes",
       "section": "Automações",
       "sectionId": "definicoes.md#automacoes"
      },
      {
       "tab": "integracoes",
       "section": "Integrações",
       "sectionId": "definicoes.md#integracoes"
      },
      {
       "tab": "comunicacao",
       "section": "Comunicação",
       "sectionId": "definicoes.md#comunicacao"
      },
      {
       "tab": "parametros",
       "section": "Parâmetros",
       "sectionId": "definicoes.md#parametros"
      },
      {
       "tab": "notificacoes",
       "section": "Notificações",
       "sectionId": "definicoes.md#notificacoes"
      },
      {
       "tab": "seguranca",
       "section": "Segurança",
       "sectionId": "definicoes.md#seguranca"
      }
     ],
     "summary": "Quem entra: administradores e super admin (pela matriz de permissões, com as exceções por pessoa).",
     "sections": [
      {
       "id": "definicoes.md#inicio",
       "file": "definicoes.md",
       "slug": "inicio",
       "title": "Definições",
       "level": 1,
       "summary": "Quem entra: administradores e super admin (pela matriz de permissões, com as exceções por pessoa).",
       "children": [],
       "container": false,
       "chars": 524
      },
      {
       "id": "definicoes.md#estado",
       "file": "definicoes.md",
       "slug": "estado",
       "title": "Estado",
       "level": 2,
       "summary": "Saúde das tarefas automáticas (crons), o cartão Agendador (só o super admin) e IA — custo do mês.",
       "children": [],
       "container": false,
       "chars": 1283
      },
      {
       "id": "definicoes.md#automacoes",
       "file": "definicoes.md",
       "slug": "automacoes",
       "title": "Automações",
       "level": 2,
       "summary": "Interruptores de cada automação, incluindo a Inteligência artificial.",
       "children": [],
       "container": false,
       "chars": 1919
      },
      {
       "id": "definicoes.md#integracoes",
       "file": "definicoes.md",
       "slug": "integracoes",
       "title": "Integrações",
       "level": 2,
       "summary": "Resumo; o estado, os testes e a gestão de cada ligação vivem na página Integrações.",
       "children": [],
       "container": false,
       "chars": 87
      },
      {
       "id": "definicoes.md#comunicacao",
       "file": "definicoes.md",
       "slug": "comunicacao",
       "title": "Comunicação",
       "level": 2,
       "summary": "Caixas de email, Envio de email (Gmail) — o remetente só o super admin muda (os admins podem testá-lo) —, calendários partilhados da escala, Google em tempo…",
       "children": [],
       "container": false,
       "chars": 1323
      },
      {
       "id": "definicoes.md#parametros",
       "file": "definicoes.md",
       "slug": "parametros",
       "title": "Parâmetros",
       "level": 2,
       "summary": "Um valor gravado que já não é válido fica assinalado (a aplicação usa a omissão até se gravar de novo).",
       "children": [
        "definicoes.md#aeroportos-e-zonas-da-operacao-gps",
        "definicoes.md#garagens-e-tempos-de-entrega-e-de-recolha",
        "definicoes.md#extras-dia-parametros"
       ],
       "container": false,
       "chars": 2575
      },
      {
       "id": "definicoes.md#aeroportos-e-zonas-da-operacao-gps",
       "file": "definicoes.md",
       "slug": "aeroportos-e-zonas-da-operacao-gps",
       "title": "Aeroportos e zonas da operação (GPS)",
       "level": 3,
       "summary": "Aeroportos (terminal no ponto) (no cartão Extras-dia): latitude, longitude e raio (metros) do aeroporto de Lisboa, Porto e Faro.",
       "children": [],
       "container": false,
       "chars": 3146
      },
      {
       "id": "definicoes.md#garagens-e-tempos-de-entrega-e-de-recolha",
       "file": "definicoes.md",
       "slug": "garagens-e-tempos-de-entrega-e-de-recolha",
       "title": "Garagens e tempos de entrega e de recolha",
       "level": 3,
       "summary": "Papéis das garagens (tempos das recolhas) (Operação; só o super admin muda): cada garagem da app é provisória (P2: conta o tempo até sair), já num parque…",
       "children": [],
       "container": false,
       "chars": 2571
      },
      {
       "id": "definicoes.md#extras-dia-parametros",
       "file": "definicoes.md",
       "slug": "extras-dia-parametros",
       "title": "Extras-dia (parâmetros)",
       "level": 3,
       "summary": "Extras-dia (cartão no fim dos Parâmetros; mudam a previsão, a Pressão e a proposta automática da escala do Extras-dia):",
       "children": [],
       "container": false,
       "chars": 2407
      },
      {
       "id": "definicoes.md#notificacoes",
       "file": "definicoes.md",
       "slug": "notificacoes",
       "title": "Notificações",
       "level": 2,
       "summary": "Quem recebe cada aviso (só o super admin muda).",
       "children": [],
       "container": false,
       "chars": 47
      },
      {
       "id": "definicoes.md#seguranca",
       "file": "definicoes.md",
       "slug": "seguranca",
       "title": "Segurança",
       "level": 2,
       "summary": "Validade das API keys (até ao fim do dia escolhido, hora de Lisboa) e Terminar sessões.",
       "children": [],
       "container": false,
       "chars": 91
      },
      {
       "id": "definicoes.md#gravar-ao-mesmo-tempo-e-historico",
       "file": "definicoes.md",
       "slug": "gravar-ao-mesmo-tempo-e-historico",
       "title": "Gravar ao mesmo tempo e histórico",
       "level": 2,
       "summary": "Duas pessoas a mudar ao mesmo tempo: se outra pessoa gravou a mesma definição ou interruptor depois de abrires a página, aparece \"Alguém mudou isto…",
       "children": [],
       "container": false,
       "chars": 397
      }
     ]
    },
    {
     "id": "definicoes.agendador",
     "file": "agendador.md",
     "group": "Sistema",
     "module": "definicoes",
     "title": "Agendador (tarefas automáticas)",
     "routes": [
      "/definicoes"
     ],
     "tabs": [],
     "summary": "Todas as tarefas automáticas da app (sincronizar o Gmail, reservas Multipark, extras, recolha GPS do Zello, relatórios, Google Ads…) correm a partir de um só…",
     "sections": [
      {
       "id": "agendador.md#inicio",
       "file": "agendador.md",
       "slug": "inicio",
       "title": "Agendador (tarefas automáticas)",
       "level": 1,
       "summary": "Todas as tarefas automáticas da app (sincronizar o Gmail, reservas Multipark, extras, recolha GPS do Zello, relatórios, Google Ads…) correm a partir de um só…",
       "children": [],
       "container": false,
       "chars": 844
      },
      {
       "id": "agendador.md#configurar-o-cron-job-org-dono-super-admin-uma-vez",
       "file": "agendador.md",
       "slug": "configurar-o-cron-job-org-dono-super-admin-uma-vez",
       "title": "Configurar o cron-job.org (dono / super admin, uma vez)",
       "level": 2,
       "summary": "Cria uma conta em cron-job.org e carrega em Create cronjob.",
       "children": [],
       "container": false,
       "chars": 1296
      },
      {
       "id": "agendador.md#o-que-corre-e-quando-hora-de-lisboa",
       "file": "agendador.md",
       "slug": "o-que-corre-e-quando-hora-de-lisboa",
       "title": "O que corre e quando (hora de Lisboa)",
       "level": 2,
       "summary": "Reservas: as páginas (Reservas do dia, ficha da reserva, Ocorrências, Avaliação, Extras-Dia, Parcerias) leem a BD da Multipark ao vivo — nada é copiado por…",
       "children": [],
       "container": false,
       "chars": 14153
      },
      {
       "id": "agendador.md#ler-o-cartao-agendador-definicoes-estado-so-super-admin",
       "file": "agendador.md",
       "slug": "ler-o-cartao-agendador-definicoes-estado-so-super-admin",
       "title": "Ler o cartão \"Agendador\" (Definições → Estado, só super admin)",
       "level": 2,
       "summary": "Cada linha é uma tarefa, com a cadência, e:",
       "children": [],
       "container": false,
       "chars": 1089
      },
      {
       "id": "agendador.md#corridas-manuais",
       "file": "agendador.md",
       "slug": "corridas-manuais",
       "title": "Corridas manuais",
       "level": 2,
       "summary": "GitHub → Actions → \"Agendador — tick (corrida manual)\" → Run workflow: corre um tick completo e mostra o relatório (vermelho se alguma tarefa falhou).",
       "children": [],
       "container": false,
       "chars": 611
      }
     ]
    },
    {
     "id": "definicoes.google-tempo-real",
     "file": "google-tempo-real.md",
     "group": "Sistema",
     "module": "definicoes",
     "title": "Google em tempo real (Calendário, Drive, Tarefas e Contactos)",
     "routes": [
      "/definicoes",
      "/perfil"
     ],
     "tabs": [],
     "summary": "Desde 26 set 2026 a app já não pergunta à Google de 15 em 15 minutos se mudou alguma coisa.",
     "sections": [
      {
       "id": "google-tempo-real.md#inicio",
       "file": "google-tempo-real.md",
       "slug": "inicio",
       "title": "Google em tempo real (Calendário, Drive, Tarefas e Contactos)",
       "level": 1,
       "summary": "Desde 26 set 2026 a app já não pergunta à Google de 15 em 15 minutos se mudou alguma coisa.",
       "children": [],
       "container": false,
       "chars": 132
      },
      {
       "id": "google-tempo-real.md#o-que-muda-no-dashboard-vai-logo-para-o-google",
       "file": "google-tempo-real.md",
       "slug": "o-que-muda-no-dashboard-vai-logo-para-o-google",
       "title": "O que muda no dashboard vai logo para o Google",
       "level": 2,
       "summary": "Criar, editar ou concluir uma tarefa, mudar a escala (turno criado, alterado, apagado ou escala confirmada), atribuir uma formação, mudar o responsável ou o…",
       "children": [],
       "container": false,
       "chars": 423
      },
      {
       "id": "google-tempo-real.md#calendario-e-drive-em-tempo-real",
       "file": "google-tempo-real.md",
       "slug": "calendario-e-drive-em-tempo-real",
       "title": "Calendário e Drive: em tempo real",
       "level": 2,
       "summary": "Calendário \"Multipark\" de cada pessoa e calendários partilhados da escala (um por cidade): quando alguém mexe num evento no Google Calendar, a Google avisa a…",
       "children": [],
       "container": false,
       "chars": 794
      },
      {
       "id": "google-tempo-real.md#tarefas-e-contactos-enquanto-tens-o-dashboard-aberto",
       "file": "google-tempo-real.md",
       "slug": "tarefas-e-contactos-enquanto-tens-o-dashboard-aberto",
       "title": "Tarefas e Contactos: enquanto tens o dashboard aberto",
       "level": 2,
       "summary": "O Google Tasks e os Contactos Google não avisam a app quando mudam.",
       "children": [],
       "container": false,
       "chars": 513
      },
      {
       "id": "google-tempo-real.md#rede-de-seguranca-de-4-em-4-horas",
       "file": "google-tempo-real.md",
       "slug": "rede-de-seguranca-de-4-em-4-horas",
       "title": "Rede de segurança: de 4 em 4 horas",
       "level": 2,
       "summary": "Mesmo sem avisos, a app faz uma sincronização completa de 4 em 4 horas (Tarefas, Calendário, Contactos, calendários partilhados, Drive e base de conhecimento).",
       "children": [],
       "container": false,
       "chars": 237
      },
      {
       "id": "google-tempo-real.md#ver-o-estado",
       "file": "google-tempo-real.md",
       "slug": "ver-o-estado",
       "title": "Ver o estado",
       "level": 2,
       "summary": "Perfil → Google Tarefas & Calendário: a última sincronização, se o teu calendário está \"em tempo real\" (e o último aviso da Google) e a última sincronização…",
       "children": [],
       "container": false,
       "chars": 844
      },
      {
       "id": "google-tempo-real.md#configuracao",
       "file": "google-tempo-real.md",
       "slug": "configuracao",
       "title": "Configuração",
       "level": 2,
       "summary": "Não é preciso configurar nada na Google Cloud: os avisos usam as APIs do Calendário e do Drive que já estão ligadas.",
       "children": [],
       "container": false,
       "chars": 436
      }
     ]
    },
    {
     "id": "definicoes.ia",
     "file": "ia-no-dashboard.md",
     "group": "Sistema",
     "module": "ia",
     "title": "Onde é que a IA trabalha no dashboard",
     "routes": [
      "/definicoes"
     ],
     "tabs": [],
     "summary": "A IA escreve textos e sugere.",
     "sections": [
      {
       "id": "ia-no-dashboard.md#inicio",
       "file": "ia-no-dashboard.md",
       "slug": "inicio",
       "title": "Onde é que a IA trabalha no dashboard",
       "level": 1,
       "summary": "A IA escreve textos e sugere.",
       "children": [],
       "container": false,
       "chars": 227
      },
      {
       "id": "ia-no-dashboard.md#so-quando-carregas-no-botao",
       "file": "ia-no-dashboard.md",
       "slug": "so-quando-carregas-no-botao",
       "title": "Só quando carregas no botão",
       "level": 4,
       "summary": "Despesas: \"Extrair com IA\" lê a fatura e preenche o formulário.",
       "children": [],
       "container": false,
       "chars": 1387
      },
      {
       "id": "ia-no-dashboard.md#sozinha-automatica",
       "file": "ia-no-dashboard.md",
       "slug": "sozinha-automatica",
       "title": "Sozinha (automática)",
       "level": 4,
       "summary": "Passagem de turno: resumo para o turno seguinte quando entregas a passagem (a 1.ª vez que a guardas); à segunda-feira, o resumo da semana.",
       "children": [],
       "container": false,
       "chars": 2945
      },
      {
       "id": "ia-no-dashboard.md#comecam-desligadas-so-um-administrador-as-liga",
       "file": "ia-no-dashboard.md",
       "slug": "comecam-desligadas-so-um-administrador-as-liga",
       "title": "Começam desligadas (só um administrador as liga)",
       "level": 2,
       "summary": "ler os documentos do RH para preencher a ficha (o IBAN fica sempre como pedido ao RH, exceto para quem o pode mudar na hora);",
       "children": [
        "ia-no-dashboard.md#dados-pessoais",
        "ia-no-dashboard.md#quanto-a-ia-usa-administradores",
        "ia-no-dashboard.md#multis-do-piloto-e-o-orcamento"
       ],
       "container": false,
       "chars": 610
      },
      {
       "id": "ia-no-dashboard.md#dados-pessoais",
       "file": "ia-no-dashboard.md",
       "slug": "dados-pessoais",
       "title": "Dados pessoais",
       "level": 4,
       "summary": "Nos textos, os emails, os telefones, o NIF, o IBAN e as matrículas são tapados antes de irem para a IA.",
       "children": [],
       "container": false,
       "chars": 343
      },
      {
       "id": "ia-no-dashboard.md#quanto-a-ia-usa-administradores",
       "file": "ia-no-dashboard.md",
       "slug": "quanto-a-ia-usa-administradores",
       "title": "Quanto a IA usa (administradores)",
       "level": 4,
       "summary": "Em Definições → Estado, o cartão IA — custo do mês mostra o gasto por funcionalidade.",
       "children": [],
       "container": false,
       "chars": 1430
      },
      {
       "id": "ia-no-dashboard.md#multis-do-piloto-e-o-orcamento",
       "file": "ia-no-dashboard.md",
       "slug": "multis-do-piloto-e-o-orcamento",
       "title": "Multis do piloto e o orçamento",
       "level": 4,
       "summary": "O Multis do piloto (modelo smart) tem teto próprio em Definições → Parâmetros → IA → Multis do piloto: teto de gasto (omissão: 10 € por dia, 150 € por mês, 3…",
       "children": [],
       "container": false,
       "chars": 711
      }
     ]
    },
    {
     "id": "integracoes",
     "file": "integracoes.md",
     "group": "Sistema",
     "module": "integracoes",
     "title": "Integrações (estado das ligações externas)",
     "routes": [
      "/integracoes"
     ],
     "tabs": [],
     "summary": "Página Integrações (menu Sistema): um cartão por ligação externa — Google Ads, Meta, Google Business, WhatsApp, Gmail, Google…",
     "sections": [
      {
       "id": "integracoes.md#inicio",
       "file": "integracoes.md",
       "slug": "inicio",
       "title": "Integrações (estado das ligações externas)",
       "level": 1,
       "summary": "Página Integrações (menu Sistema): um cartão por ligação externa — Google Ads, Meta, Google Business, WhatsApp, Gmail, Google…",
       "children": [],
       "container": false,
       "chars": 1557
      },
      {
       "id": "integracoes.md#o-que-cada-cartao-diz",
       "file": "integracoes.md",
       "slug": "o-que-cada-cartao-diz",
       "title": "O que cada cartão diz",
       "level": 4,
       "summary": "Configurada / Não configurada: se as variáveis do servidor existem (os valores nunca aparecem).",
       "children": [],
       "container": false,
       "chars": 770
      },
      {
       "id": "integracoes.md#testar",
       "file": "integracoes.md",
       "slug": "testar",
       "title": "Testar",
       "level": 4,
       "summary": "Não envia nem altera nada.",
       "children": [],
       "container": false,
       "chars": 584
      },
      {
       "id": "integracoes.md#central-vodafone-consola-one-net-so-o-super-admin",
       "file": "integracoes.md",
       "slug": "central-vodafone-consola-one-net-so-o-super-admin",
       "title": "Central Vodafone (consola One Net) (só o super admin)",
       "level": 2,
       "summary": "A consola da Vodafone (One Net Attendant Console) só regista chamadas num CRM conhecido.",
       "children": [
        "integracoes.md#xsi-da-one-net-todas-as-linhas-telemoveis-incluidos"
       ],
       "container": false,
       "chars": 4830
      },
      {
       "id": "integracoes.md#xsi-da-one-net-todas-as-linhas-telemoveis-incluidos",
       "file": "integracoes.md",
       "slug": "xsi-da-one-net-todas-as-linhas-telemoveis-incluidos",
       "title": "Xsi da One Net (todas as linhas, telemóveis incluídos)",
       "level": 3,
       "summary": "O Xsi é a ligação direta à plataforma da Vodafone.",
       "children": [],
       "container": false,
       "chars": 1504
      }
     ]
    },
    {
     "id": "integracoes.google-ads",
     "file": "integracoes-google-ads.md",
     "group": "Sistema",
     "module": "integracoes",
     "title": "Integrações → Google Ads e Meta Ads",
     "routes": [
      "/integracoes/google-ads"
     ],
     "tabs": [],
     "summary": "Aqui liga-se o Google Ads, escolhem-se as contas a recolher e vê-se o histórico das recolhas.",
     "sections": [
      {
       "id": "integracoes-google-ads.md#inicio",
       "file": "integracoes-google-ads.md",
       "slug": "inicio",
       "title": "Integrações → Google Ads e Meta Ads",
       "level": 1,
       "summary": "Aqui liga-se o Google Ads, escolhem-se as contas a recolher e vê-se o histórico das recolhas.",
       "children": [],
       "container": false,
       "chars": 173
      },
      {
       "id": "integracoes-google-ads.md#quem-faz-o-que",
       "file": "integracoes-google-ads.md",
       "slug": "quem-faz-o-que",
       "title": "Quem faz o quê",
       "level": 4,
       "summary": "Ligar, voltar a autorizar e desligar o Google Ads: só o super admin.",
       "children": [],
       "container": false,
       "chars": 344
      },
      {
       "id": "integracoes-google-ads.md#contas",
       "file": "integracoes-google-ads.md",
       "slug": "contas",
       "title": "Contas",
       "level": 4,
       "summary": "O interruptor diz se a conta é recolhida.",
       "children": [],
       "container": false,
       "chars": 317
      },
      {
       "id": "integracoes-google-ads.md#recolhas-automaticas",
       "file": "integracoes-google-ads.md",
       "slug": "recolhas-automaticas",
       "title": "Recolhas automáticas",
       "level": 4,
       "summary": "Diária (a partir das 05:45): última semana.",
       "children": [],
       "container": false,
       "chars": 656
      },
      {
       "id": "integracoes-google-ads.md#cliques-gclid-campanha-no-cartao-recolha-jorge-8-out-2026-as",
       "file": "integracoes-google-ads.md",
       "slug": "cliques-gclid-campanha-no-cartao-recolha-jorge-8-out-2026-as",
       "title": "Cliques (gclid → campanha) (no cartão Recolha; Jorge, 8 out 2026 — as campanhas davam 0 reservas ligadas)",
       "level": 2,
       "summary": "Com o auto-tagging, o link da reserva só traz o gclid.",
       "children": [
        "integracoes-google-ads.md#estados"
       ],
       "container": false,
       "chars": 1396
      },
      {
       "id": "integracoes-google-ads.md#estados",
       "file": "integracoes-google-ads.md",
       "slug": "estados",
       "title": "Estados",
       "level": 4,
       "summary": "Reautorização necessária: a Google deixou de aceitar a autorização (ou o token guardado já não se consegue abrir porque a chave de cifra mudou).",
       "children": [],
       "container": false,
       "chars": 988
      }
     ]
    },
    {
     "id": "logs",
     "file": "logs.md",
     "group": "Sistema",
     "module": "logs",
     "title": "Logs (registo de atividade)",
     "routes": [
      "/logs"
     ],
     "tabs": [],
     "summary": "Página Logs (menu Sistema): o registo do que se faz na plataforma — quem, quando, o quê e em que registo.",
     "sections": [
      {
       "id": "logs.md#inicio",
       "file": "logs.md",
       "slug": "inicio",
       "title": "Logs (registo de atividade)",
       "level": 1,
       "summary": "Página Logs (menu Sistema): o registo do que se faz na plataforma — quem, quando, o quê e em que registo.",
       "children": [],
       "container": false,
       "chars": 186
      },
      {
       "id": "logs.md#quem-fez",
       "file": "logs.md",
       "slug": "quem-fez",
       "title": "Quem fez",
       "level": 4,
       "summary": "Uma pessoa: aparece o nome dela.",
       "children": [],
       "container": false,
       "chars": 2234
      }
     ]
    },
    {
     "id": "multis",
     "file": "multis.md",
     "group": "Sistema",
     "module": "multis",
     "title": "Multis (o assistente de IA da equipa)",
     "routes": [
      "/multis/falhas",
      "/perfil"
     ],
     "tabs": [],
     "summary": "O Multis é o assistente de IA da Multipark dentro da aplicação.",
     "sections": [
      {
       "id": "multis.md#inicio",
       "file": "multis.md",
       "slug": "inicio",
       "title": "Multis (o assistente de IA da equipa)",
       "level": 1,
       "summary": "O Multis é o assistente de IA da Multipark dentro da aplicação.",
       "children": [],
       "container": false,
       "chars": 240
      },
      {
       "id": "multis.md#o-que-lhe-podes-pedir",
       "file": "multis.md",
       "slug": "o-que-lhe-podes-pedir",
       "title": "O que lhe podes pedir",
       "level": 4,
       "summary": "Como se usa a aplicação (\"Como crio uma tarefa?\"): responde com os passos e os nomes dos menus e botões.",
       "children": [],
       "container": false,
       "chars": 857
      },
      {
       "id": "multis.md#regras",
       "file": "multis.md",
       "slug": "regras",
       "title": "Regras",
       "level": 4,
       "summary": "Só lê: não cria, não altera, não envia nada.",
       "children": [],
       "container": false,
       "chars": 296
      },
      {
       "id": "multis.md#memoria-o-que-o-multis-tem-de-lembrar",
       "file": "multis.md",
       "slug": "memoria-o-que-o-multis-tem-de-lembrar",
       "title": "Memória (o que o Multis tem de lembrar)",
       "level": 4,
       "summary": "Escreve uma mensagem a começar por \"Lembra-te\" (ou \"Memoriza\", \"Não te esqueças\"), por exemplo: «Lembra-te: sou do Porto, dá-me sempre os números por parque».",
       "children": [],
       "container": false,
       "chars": 1024
      },
      {
       "id": "multis.md#avaliar-respostas",
       "file": "multis.md",
       "slug": "avaliar-respostas",
       "title": "Avaliar respostas (👍/👎)",
       "level": 4,
       "summary": "Por baixo de cada resposta há 👍 e 👎.",
       "children": [],
       "container": false,
       "chars": 394
      },
      {
       "id": "multis.md#perguntas-que-falharam-so-administradores",
       "file": "multis.md",
       "slug": "perguntas-que-falharam-so-administradores",
       "title": "Perguntas que falharam (só administradores)",
       "level": 2,
       "summary": "Abre no relógio do Multis → Perguntas que falharam, ou em Definições → Automações → Inteligência artificial → Multis: perguntas que falharam.",
       "children": [
        "multis.md#o-multis-sabe-o-que-tens-aberto",
        "multis.md#piloto-do-multis-modelo-smart",
        "multis.md#regras-em-vigor-piloto",
        "multis.md#multis-por-pagina-piloto",
        "multis.md#dados-que-o-multis-le-piloto"
       ],
       "container": false,
       "chars": 980
      },
      {
       "id": "multis.md#o-multis-sabe-o-que-tens-aberto",
       "file": "multis.md",
       "slug": "o-multis-sabe-o-que-tens-aberto",
       "title": "O Multis sabe o que tens aberto",
       "level": 4,
       "summary": "Nas páginas com separadores (Extras-Dia, Atividade diária, Avaliação, Despesas, Parcerias, Condutores e agentes, Críticas, Formação) o Multis sabe em que…",
       "children": [],
       "container": false,
       "chars": 341
      },
      {
       "id": "multis.md#piloto-do-multis-modelo-smart",
       "file": "multis.md",
       "slug": "piloto-do-multis-modelo-smart",
       "title": "Piloto do Multis (modelo smart)",
       "level": 4,
       "summary": "Algumas pessoas experimentam o Multis com um modelo mais forte.",
       "children": [],
       "container": false,
       "chars": 952
      },
      {
       "id": "multis.md#regras-em-vigor-piloto",
       "file": "multis.md",
       "slug": "regras-em-vigor-piloto",
       "title": "Regras em vigor (piloto)",
       "level": 4,
       "summary": "No piloto, o Multis consegue ler as regras em vigor de um módulo — Avaliação (pontos e velocidade), Extras Dia (pressão e escala), Tempos de entrega e de…",
       "children": [],
       "container": false,
       "chars": 910
      },
      {
       "id": "multis.md#multis-por-pagina-piloto",
       "file": "multis.md",
       "slug": "multis-por-pagina-piloto",
       "title": "Multis por página (piloto)",
       "level": 4,
       "summary": "No piloto, o Multis sabe em que página e em que separador estás: junta à pergunta a parte da ajuda desse separador (por exemplo, a do separador Pressão do…",
       "children": [],
       "container": false,
       "chars": 1093
      },
      {
       "id": "multis.md#dados-que-o-multis-le-piloto",
       "file": "multis.md",
       "slug": "dados-que-o-multis-le-piloto",
       "title": "Dados que o Multis lê (piloto)",
       "level": 4,
       "summary": "No piloto, o Multis lê também estes dados, sempre como tu (as tuas cidades e permissões), só para ler e sem usar IA para os ir buscar.",
       "children": [],
       "container": false,
       "chars": 1475
      }
     ]
    },
    {
     "id": "perfil",
     "file": "perfil.md",
     "group": "Sistema",
     "module": "ficha",
     "title": "Perfil (foto, notificações, palavra-passe, sessões, contas Google)",
     "routes": [
      "/perfil"
     ],
     "tabs": [],
     "summary": "O Perfil tem o teu cartão, atalhos e o que é só teu.",
     "sections": [
      {
       "id": "perfil.md#inicio",
       "file": "perfil.md",
       "slug": "inicio",
       "title": "Perfil (foto, notificações, palavra-passe, sessões, contas Google)",
       "level": 1,
       "summary": "O Perfil tem o teu cartão, atalhos e o que é só teu.",
       "children": [],
       "container": false,
       "chars": 245
      },
      {
       "id": "perfil.md#atalhos",
       "file": "perfil.md",
       "slug": "atalhos",
       "title": "Atalhos",
       "level": 4,
       "summary": "O meu ponto abre o separador Ponto da tua ficha.",
       "children": [],
       "container": false,
       "chars": 451
      },
      {
       "id": "perfil.md#este-telemovel-no-telemovel-num-pda-nao-aparece",
       "file": "perfil.md",
       "slug": "este-telemovel-no-telemovel-num-pda-nao-aparece",
       "title": "Este telemóvel (no telemóvel; num PDA não aparece)",
       "level": 2,
       "summary": "Registar este telemóvel como meu: o teu telemóvel passa a telemóvel pessoal (não é um PDA partilhado).",
       "children": [
        "perfil.md#foto",
        "perfil.md#notificacoes"
       ],
       "container": false,
       "chars": 800
      },
      {
       "id": "perfil.md#foto",
       "file": "perfil.md",
       "slug": "foto",
       "title": "Foto",
       "level": 4,
       "summary": "Adicionar foto / Trocar a foto: tira com a câmara ou carrega uma imagem (JPEG, PNG ou WebP; a app reduz-a antes de enviar).",
       "children": [],
       "container": false,
       "chars": 233
      },
      {
       "id": "perfil.md#notificacoes",
       "file": "perfil.md",
       "slug": "notificacoes",
       "title": "Notificações",
       "level": 4,
       "summary": "Só aparecem os tipos que te podem chegar (pela tua área e cidade).",
       "children": [],
       "container": false,
       "chars": 692
      },
      {
       "id": "perfil.md#palavra-passe-so-com-entrar-com-email-e-codigo-ligado-so-uti",
       "file": "perfil.md",
       "slug": "palavra-passe-so-com-entrar-com-email-e-codigo-ligado-so-uti",
       "title": "Palavra-passe (só com Entrar com email e código ligado; só utilizadores, extras e condutores)",
       "level": 2,
       "summary": "Diz se já tens palavra-passe.",
       "children": [],
       "container": false,
       "chars": 439
      },
      {
       "id": "perfil.md#avisos-no-telemovel-team-leaders-e-acima-com-entrar-com-emai",
       "file": "perfil.md",
       "slug": "avisos-no-telemovel-team-leaders-e-acima-com-entrar-com-emai",
       "title": "Avisos no telemóvel (team leaders e acima, com Entrar com email e código ligado)",
       "level": 2,
       "summary": "Ativar avisos: recebes no telemóvel os códigos de entrada de quem os pede, mesmo com a app fechada.",
       "children": [],
       "container": false,
       "chars": 580
      },
      {
       "id": "perfil.md#contas-google-email-tarefas-calendario-contactos",
       "file": "perfil.md",
       "slug": "contas-google-email-tarefas-calendario-contactos",
       "title": "Contas Google (email, Tarefas, Calendário, Contactos)",
       "level": 2,
       "summary": "Se as tuas preferências não se conseguirem ler, os interruptores ficam bloqueados com um aviso — nada é gravado por cima com os valores de omissão.",
       "children": [
        "perfil.md#terminar-sessoes-noutros-aparelhos"
       ],
       "container": false,
       "chars": 269
      },
      {
       "id": "perfil.md#terminar-sessoes-noutros-aparelhos",
       "file": "perfil.md",
       "slug": "terminar-sessoes-noutros-aparelhos",
       "title": "Terminar sessões noutros aparelhos",
       "level": 4,
       "summary": "Num PDA (aparelho registado), ao entrar a Google pede sempre para escolher a conta — assim ninguém entra por engano com a conta de quem usou o PDA antes.",
       "children": [],
       "container": false,
       "chars": 2084
      }
     ]
    },
    {
     "id": "permissoes",
     "file": "permissoes.md",
     "group": "Sistema",
     "module": "permissoes",
     "title": "Permissões",
     "routes": [
      "/permissoes",
      "/utilizadores"
     ],
     "tabs": [],
     "summary": "Utilizadores — Cartões ou Lista (botão no topo da lista de utilizadores): vês as contas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
     "sections": [
      {
       "id": "permissoes.md#inicio",
       "file": "permissoes.md",
       "slug": "inicio",
       "title": "Permissões",
       "level": 1,
       "summary": "Utilizadores — Cartões ou Lista (botão no topo da lista de utilizadores): vês as contas em cartões com foto ou numa lista compacta — no telemóvel e no PC.",
       "children": [],
       "container": false,
       "chars": 224
      },
      {
       "id": "permissoes.md#utilizadores-agente-e-ligacoes",
       "file": "permissoes.md",
       "slug": "utilizadores-agente-e-ligacoes",
       "title": "Utilizadores — agente e ligações",
       "level": 4,
       "summary": "A coluna Agente mostra o agente da Multipark da ficha de cada conta (das fichas ativas; \"extra\" quando é um segundo agente da mesma pessoa).",
       "children": [],
       "container": false,
       "chars": 2527
      },
      {
       "id": "permissoes.md#pagina-permissoes-supervisor-backoffice-admin-e-acima",
       "file": "permissoes.md",
       "slug": "pagina-permissoes-supervisor-backoffice-admin-e-acima",
       "title": "Página Permissões (Supervisor, Backoffice, Admin e acima)",
       "level": 2,
       "summary": "Menu Sistema → Permissões.",
       "children": [],
       "container": false,
       "chars": 589
      }
     ]
    }
   ]
  }
 ]
};
