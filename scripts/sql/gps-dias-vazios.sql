-- ─────────────────────────────────────────────────────────────────────────────
-- GPS do Zello — que dias ficaram vazios ou em falta? (SÓ LEITURA)
--
-- Antes da correção a app recolhia "ontem", que o Zello ainda não dá → linhas
-- com 0 pontos GPS. Este script lista, nos últimos 60 dias:
--   A) dias SEM nenhuma linha;
--   B) dias em que as linhas existem mas NENHUMA tem pontos GPS (tudo a zeros);
--   C) dias com ALGUMAS linhas vazias (vale a pena voltar a recolher).
--
-- Para voltar a buscar um dia: Histórico Diário → escolhe o dia → "Recolher
-- Dados". A recolha manual volta a pedir ao Zello só as linhas VAZIAS; as que
-- já têm dados não são tocadas. Ontem não dá (o Zello só o devolve 2 dias
-- depois). Se o Zello já não tiver esse dia guardado, a linha fica vazia na mesma.
--
-- Não altera nada. MySQL 8 (usa WITH RECURSIVE).
-- ─────────────────────────────────────────────────────────────────────────────

WITH RECURSIVE dias AS (
  SELECT CURDATE() - INTERVAL 60 DAY AS dia
  UNION ALL
  SELECT dia + INTERVAL 1 DAY FROM dias WHERE dia < CURDATE() - INTERVAL 2 DAY
),
resumo AS (
  SELECT DATE(date)                    AS dia,
         COUNT(*)                      AS linhas,
         SUM(gpsPointsCount > 0)       AS com_gps,
         SUM(COALESCE(gpsPointsCount, 0) = 0) AS vazias,
         ROUND(SUM(totalKm), 1)        AS km
    FROM daily_driver_history
   WHERE date >= CURDATE() - INTERVAL 60 DAY
   GROUP BY DATE(date)
)
SELECT d.dia,
       DAYNAME(d.dia)               AS dia_semana,
       COALESCE(r.linhas, 0)        AS linhas,
       COALESCE(r.com_gps, 0)       AS com_gps,
       COALESCE(r.vazias, 0)        AS vazias,
       COALESCE(r.km, 0)            AS km,
       CASE
         WHEN r.dia IS NULL      THEN 'A) sem nenhuma linha'
         WHEN r.com_gps = 0      THEN 'B) tudo a zeros'
         ELSE                         'C) algumas vazias'
       END                          AS situacao
  FROM dias d
  LEFT JOIN resumo r ON r.dia = d.dia
 WHERE r.dia IS NULL OR r.vazias > 0
 ORDER BY d.dia;
