# Avaliações Google por parque

## Configuração

1. Obter aprovação do projeto Google Cloud para Business Profile. Ativar uma API com quota de pedidos por minuto igual a zero não concede acesso aos perfis.
2. Ativar My Business Account Management API, My Business Business Information API e Google My Business API (v4, avaliações).
3. No cliente OAuth Web, adicionar `https://dashboard.multipark.pt/api/integrations/google-business/oauth/callback`. A aplicação pede `business.manage`, `openid` e `email`. Manter o público definido para as contas que devem usar a integração.
4. Configurar `GOOGLE_BUSINESS_CLIENT_ID` e `GOOGLE_BUSINESS_CLIENT_SECRET`, ou reutilizar o cliente existente através das variáveis `GOOGLE_ADS_CLIENT_ID` e `GOOGLE_ADS_CLIENT_SECRET`. O token de Business Profile fica separado do token de Ads e cifrado na base de dados.
5. Em **Críticas → Ligação Google Business Profile**, autorizar a conta proprietária/gestora. Associar explicitamente cada perfil ao projeto/parque correto, ativar a importação e guardar. Identificadores da API operacional, projetos internos e perfis Google são identificadores diferentes.
6. Carregar em **Importar avaliações agora**. Verificar uma avaliação real e a sua associação ao parque. As avaliações de 1–3 estrelas criam uma reclamação com prazo de 24 horas na mesma transação. As restantes ficam disponíveis para resposta. Esta integração não publica respostas no Google.

A migração aditiva `0072` é aplicada pelo mecanismo de atualização do esquema já usado no arranque. Campos novos aceitam valores nulos para preservar o histórico. Uma associação com avaliações importadas não pode ser mudada de parque sem conciliação do histórico.

## Recolha periódica e notificações

O workflow `google-business-reviews.yml` chama `/api/cron/google-business` aproximadamente a cada dez minutos. Usa o mesmo `CRON_SECRET` da produção, guardado nos segredos de Actions; não imprime o resultado das avaliações. O agendamento do GitHub pode sofrer atrasos. Páginas incompletas são retomadas e entregas repetidas não criam novas críticas/reclamações.

Para receber notificações imediatas, após a aprovação da API:

- Ativar My Business Notifications API e Pub/Sub. Criar um tópico e conceder publicação a `mybusiness-api-pubsub@system.gserviceaccount.com` apenas nesse tópico.
- Criar uma subscrição push autenticada para `https://dashboard.multipark.pt/api/integrations/google-business/webhook`, com uma conta de serviço dedicada.
- Configurar `GOOGLE_BUSINESS_PUSH_AUDIENCE` com a audiência exata do token OIDC, `GOOGLE_BUSINESS_PUSH_EMAIL` com o email dessa conta de serviço e `GOOGLE_BUSINESS_SUBSCRIPTION` com o nome completo da subscrição.
- Consultar a configuração de notificações existente de cada conta Google antes de a alterar. O tópico é definido por conta e não deve substituir outra integração inadvertidamente. Subscrever `NEW_REVIEW` e `UPDATED_REVIEW`.
- Confirmar uma entrega autenticada. O servidor valida assinatura, emissor, audiência, identidade e subscrição; guarda o pedido de recolha antes de responder 204. O processo periódico recupera trabalho pendente.

O código do webhook não cria recursos Cloud nem ativa notificações por si só. Sem essa configuração, a recolha periódica continua a funcionar após OAuth e associação dos perfis.

## Histórico e autorizações

Possíveis avaliações já importadas por email ficam pendentes para comparação manual. O painel mostra texto, data, classificação e reclamação existente antes de associar. Não se deduz a identidade de um parque apenas pelo nome.

Só administradores com acesso global podem ligar contas, associar parques e resolver duplicados. Listas, estatísticas e acesso por identificador às críticas respeitam o acesso do utilizador à cidade/projeto.

## Verificação

```text
pnpm exec tsc --noEmit
pnpm exec vitest run server/integrations/googleBusiness server/integrations/googleAds server/cityScope.test.ts server/cityScopeRoutes.test.ts
pnpm run build
pnpm run build:api
```

Os testes locais usam respostas simuladas; aprovação da API, OAuth, primeira recolha e entrega Pub/Sub têm de ser confirmados no ambiente real.

Fontes: [pré-requisitos](https://developers.google.com/my-business/content/prereqs), [avaliações](https://developers.google.com/my-business/content/review-data), [notificações](https://developers.google.com/my-business/content/notification-setup).
