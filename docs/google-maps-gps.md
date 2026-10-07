# Google Maps no GPS/Zello

O mapa em Operações → Zello usa a Maps JavaScript API, com marcadores avançados,
nomes dos condutores, detalhes do reporte, satélite, Street View, ecrã inteiro,
trânsito e o botão **Ver todos**. Os dados continuam a vir do Zello a cada 30 segundos.
A ligação do check-in diário do PDA tem precedência sobre a ligação fixa.

## Ativar

1. Escolher o projeto Google Cloud da Multipark, com faturação ativa, e ativar
   **Maps JavaScript API**. Não são necessárias Places, Routes nem Geocoding.
2. Criar uma chave dedicada ao browser. Restringir a API a **Maps JavaScript API**
   e os sites aos domínios reais da dashboard. Exemplos a confirmar no alojamento:
   `https://dashboard.multipark.pt/*` e `https://dashbord-multipark.vercel.app/*`.
   Para testes, autorizar apenas o endereço concreto do preview; evitar `*.vercel.app`.
   Para desenvolvimento, usar uma chave separada restrita a `http://localhost:5173/*`.
3. Em Google Maps Platform → Gestão de mapas, criar um **ID de mapa JavaScript**.
4. Definir no ambiente que faz o build (Vercel ou Railway):

   ```dotenv
   VITE_GOOGLE_MAPS_API_KEY=<chave de browser restrita>
   VITE_GOOGLE_MAPS_MAP_ID=<ID do mapa JavaScript>
   ```

5. Fazer novo build/deployment. As variáveis `VITE_*` são incorporadas no cliente:
   alterar só o ambiente do servidor depois do build não as atualiza. A chave é
   visível no browser por desenho da API; nunca reutilizar chaves de servidor.

## Custo e comportamento

- Consultar a tabela atual: https://developers.google.com/maps/billing-and-pricing/pricing
  (SKU Dynamic Maps). Não assumir custo zero; criar alertas de orçamento e avaliar
  as quotas aplicáveis. Os alertas de orçamento não interrompem a faturação.
- Na consulta de 7 de outubro de 2026, Dynamic Maps inclui 10 000 eventos mensais
  sem custo e cobra US$7/1 000 no primeiro escalão seguinte. O uso é agregado por
  conta de faturação. Street View tem uma SKU própria: 5 000 eventos sem custo,
  depois US$14/1 000 no primeiro escalão. Confirmar antes de estimar a fatura.
- O carregador é partilhado e a instância do mapa mantém-se durante as atualizações
  GPS. Atualizar posições não cria um novo mapa nem faz chamadas de cálculo de rotas.
- Sem chave/ID, aparece um estado de configuração pendente, sem pedidos à Google.
  Falhas de carregamento/autorização mostram erro e opção de tentar novamente.
- As posições não finitas, fora dos limites ou `(0, 0)` são ignoradas.
- Depois do primeiro enquadramento, o mapa conserva a vista escolhida. **Ver todos**
  volta a enquadrar os condutores. Sem condutores, mantém Lisboa como centro inicial.
- Os nomes/detalhes são inseridos como texto no DOM, preservando a proteção contra XSS.

## Validar no preview antes da publicação

- Confirmar mapa sem erros de chave, faturação, domínio ou ID.
- Confirmar posições reais, nomes de PDA, alertas e atualização após 30 segundos.
- Abrir detalhes, aguardar atualização e verificar que o reporte se atualiza.
- Arrastar/aproximar e confirmar que o polling conserva a vista.
- Testar Ver todos com um e vários condutores, satélite, trânsito e ecrã inteiro.
- Testar ausência de posições, falha de rede, mudança de separador e ecrã móvel.

Documentação: https://developers.google.com/maps/documentation/javascript/load-maps-js-api
e https://developers.google.com/maps/documentation/javascript/advanced-markers/overview.
