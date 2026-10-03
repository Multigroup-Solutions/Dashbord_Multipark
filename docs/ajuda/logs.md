---
modulo: logs
titulo: Logs (registo de atividade)
rotas: /logs
palavras: logs, registo, registo de atividade, quem fez, quem mudou, histórico, auditoria, sistema, automático, origem, api key, agendador, retenção, 24 meses, csv, exportar, apagou, arquivou, máscara, nif, iban, telefone
---
# Logs

Página **Logs** (menu Sistema): o registo do que se faz na plataforma — quem, quando, o quê e em que registo. **Só o super admin** a vê, e não se dá por exceção pessoal (desde out 2026).

**Quem fez**
- Uma pessoa: aparece o nome dela. Se a conta foi fundida noutra, os registos antigos **continuam com a conta antiga** (fica desativada, não se apaga) — já não passam para a outra pessoa.
- **Sistema** (ícone de robô): uma ação automática. A etiqueta diz de onde veio: **Automático (agendador)**, **API key** (com o nome e o início da chave nos detalhes), **Site**, **Webhook** ou **Sistema**. Antes, muitas destas apareciam em nome do primeiro super admin.
- Registos antigos não têm origem (filtro "Sem origem").

**Filtros**: pesquisa livre (detalhes, ação, entidade, pessoa), datas, **Quem** (uma pessoa ou "Só automático"), **Origem**, **Entidade** (os nomes repetidos, como employee/employees, contam como um), **Registo #** e **Ação** (todas as que existem). Carregar no **#número** de uma linha mostra só a história desse registo. **Limpar** tira todos os filtros.

**Dados sensíveis**: os detalhes nunca guardam o IBAN, o NIF, o telefone, o cartão ou um segredo por inteiro — ficam só os últimos dígitos (ex.: `PT50 •••0154`, `NIF •••6789`, `•••678`). Os emails ficam (identificam as contas).

**Retenção**: **24 meses** para tudo. Fica **sempre** o histórico de cada ficha do CRM e as mudanças de papel/permissões. O que a aplicação precisa de lembrar ("já se pediu a cidade a este extra", "esta ficha veio do site") vive na própria ficha, não nos logs.

**Apagar vs arquivar**: "Apagou" só aparece para coisas sem dados (ex.: um nó de projeto vazio, com o nome no registo). Parcerias, reclamações, chaves e o resto **arquivam** ou **revogam** — o registo diz o quê e porquê.

**CSV**: exporta as linhas carregadas (com a origem). Cada célula vai entre aspas e um texto começado por `=`, `+`, `-` ou `@` leva um apóstrofo, para o Excel nunca o correr como fórmula.

**Erro**: se a leitura falhar aparece o erro com "Tentar de novo" — nunca "Nenhum log".
