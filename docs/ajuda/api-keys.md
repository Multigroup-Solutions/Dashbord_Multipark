---
modulo: api_keys
titulo: API Keys (chaves para o site, o MCP e os dispositivos)
rotas: /api-keys
palavras: api key, api keys, chave, chaves, x-api-key, capacidades, permissões da chave, revogar, revogada, expirada, validade, mcp, claude, site, formulário, gps, zilo, rádio, gmail import, relatórios, dados pessoais, 403, 429, limite de pedidos
---
# API Keys

Página **API Keys** (menu Sistema, **só super admin**): as chaves que os programas de fora usam para falar com a dashboard — o site (candidaturas e disponibilidades), o MCP do Claude (relatórios), a importação do Gmail e os dispositivos (GPS, rádios).

**Cada chave diz o que pode fazer** (desde out 2026). Ao criar, marca só o necessário:
- **Formulários do site** — candidaturas "Be a Driver", disponibilidades dos extras, formulário de disponibilidades.
- **Relatórios de operação** — parques, projetos, viaturas, condutores, estatísticas de reservas e de reclamações.
- **Caixa e parceiros** — contagens e correções de caixa, passagens de turno, faturação e fecho de parceiros.
- **Marketing** — campanhas, gasto em anúncios, ROAS, Google Analytics, Search Console.
- **Dados pessoais** — reservas com os dados do cliente, reclamações, críticas, lista de colaboradores. À parte de propósito: um relatório raramente precisa disto.
- **Reclamações e críticas (escrever)** — criar e atualizar reclamações, mensagens e críticas; importação do Gmail.
- **Dispositivo (GPS / rádio)** — só a `/api/external`: alertas de velocidade, movimentos de viaturas, rádio.
- **Administração (tudo)** — tudo o resto, mais arquivar reclamações, criar projetos e as rotas `/admin`. Só para manutenção; nunca num MCP.

Sem a capacidade, o pedido recebe **403** e não faz nada.

**Chaves antigas** (criadas antes, como "Só leitura", "Leitura + escrita", "Admin" ou "Dispositivos"): continuam a fazer **exatamente o que faziam** — aparecem com as capacidades equivalentes e o aviso "Chave antiga". Em **Capacidades** podes reduzi-las ao que precisam; muda logo para quem as usa.

**A chave só aparece uma vez**, ao criar. Na base de dados fica só uma impressão digital (hash) e o início (`mp_ab12cd…`) para a reconhecer.

**Revogar em vez de apagar**: "Revogar" pede o motivo, desliga a chave para sempre (não se reativa) e fica o registo de quem, quando e porquê. Para ver as revogadas, liga **Mostrar revogadas**. Uma chave comprometida revoga-se e cria-se outra.

**Ativa / Inativa**: o interruptor pausa uma chave (volta a ligar-se quando quiseres). Revogada é diferente: é definitivo.

**Validade**: opcional, ao criar (30 dias, 90 dias, 1 ano) ou em **Definições → Segurança**. A chave funciona até ao **fim desse dia em Lisboa**. Chave errada, inativa, revogada ou expirada recebem todas a **mesma** resposta (403), para não dar pistas a quem tenta adivinhar.

**Limite**: 240 pedidos por minuto por chave; acima disso a resposta é **429** (com "tenta daqui a N s").

**Nos Logs**, o que uma chave faz aparece como **Sistema** com a etiqueta da chave (ex.: `[API key #3 «Site» mp_ab12cd…]`) — nunca em nome de quem a criou. Criar, mudar capacidades, ativar/desativar, validade e revogar ficam registados com o antes → depois.

**Erros**: quando algo corre mal do nosso lado, quem chama recebe "Erro interno (ref …)" — o detalhe fica nos registos do servidor com essa referência (nunca SQL nem nomes de tabelas para fora).

**Áudio de rádio** (`/api/external/radio-upload`): o endereço do áudio tem de ser `http(s)` e público; endereços internos são recusados.

**Documentação API** (segundo separador): exemplos de cada rota e a capacidade que pede. Para o MCP do Claude: `mcp-server/README.md` (sem instalar nada; só o Node 18+).
