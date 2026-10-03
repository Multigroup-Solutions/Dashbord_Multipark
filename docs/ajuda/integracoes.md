---
modulo: integracoes
titulo: Integrações (estado das ligações externas)
rotas: /integracoes
palavras: aviso ao desligar, integração desligada, integrações, integracoes, ligações, testar ligação, estado desconhecido, sem problemas conhecidos, reautorização, religar, chave de cifra, google business, google ads, meta, whatsapp, gmail, zello, ia, gemini, drive, armazenamento, s3, base de dados, bd multipark, quem pode testar, limite de testes
---
# Integrações

Página **Integrações** (menu Sistema): um cartão por ligação externa — Google Ads, Meta, Google Business, WhatsApp, Gmail, Google Tarefas/Calendário/Contactos/Drive, Analytics, Search Console, PageSpeed, Zello, IA, BD Multipark, armazenamento.

**Quem vê**: só **administradores e super admin** (desde out 2026). Os outros papéis deixaram de ver a página (viam erros de todo o país e corriam testes com custo).
- **Ligação Google Business Profile** (conta, perfis e importar avaliações): no fundo desta página — antes estava no topo das Críticas. Só aparece a admin/super admin com todas as cidades.
- **Ligar e desligar o Google Ads e o Google Business**: só o **super admin**. Ao desligar, a autorização é **revogada na Google**; os dados recolhidos e a escolha das contas/perfis ficam. Com o interruptor **Aviso quando desligam uma integração** ligado (Definições → Automações; vem desligado), os administradores e o super admin recebem no sino "Google … foi desligado" (menos quem desligou).
- O teste da **BD Multipark** é só do super admin.

**O que cada cartão diz**
- **Configurada / Não configurada**: se as variáveis do servidor existem (os valores nunca aparecem). O **armazenamento** só fica "Configurada" com o Vercel Blob ou com as **4** variáveis do S3 (região, bucket e as duas chaves).
- **Ligado / Reautorização necessária / Erro**: o estado guardado. "Ligado, com erro" (âmbar) quando está ligado mas a última recolha falhou.
- **Última recolha com sucesso**: a última recolha que acabou bem (não a última tentativa).
- Erros e avisos (ex.: a chave de cifra, o desempenho dos perfis Google).

**Estado desconhecido**: se o estado guardado não se consegue ler (base de dados em baixo, consulta a falhar), o selo fica cinzento "Estado desconhecido" com o motivo e "Tentar de novo" — nunca "Sem problemas conhecidos" por engano.

**Testar**
- Não envia nem altera nada. As partes pessoais do **Google Drive, Tarefas/Calendário e Contactos** testam-se com a **tua** conta Google (se ainda não as ativaste no Perfil, o teste diz que essa parte ficou por testar) — nunca com a de um colega.
- No máximo **10 testes por minuto** por pessoa.
- Um teste da **Meta** com o token recusado marca a ligação como "Reautorização necessária".

**Avisos aos administradores**: quando uma ligação passa a precisar de religar ou dá erro, ou um cron para, os administradores recebem um aviso (uma vez por mudança). O detalhe vai sem segredos.
