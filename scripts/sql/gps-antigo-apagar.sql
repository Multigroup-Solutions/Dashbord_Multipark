-- ─────────────────────────────────────────────────────────────────────────────
-- GPS antigo (v1) — apagar à mão (OPCIONAL)
--
-- Linhas do Histórico Diário gravadas ANTES da correção das velocidades
-- (metricsVersion < 2: velocidades ×3,6 e sem funcionário). A app já não as
-- recalcula nem as usa na avaliação; ficam só como arquivo. Este script apaga-as
-- com as partes por pessoa (driver_day_shares). Linhas v2+ NUNCA são tocadas.
--
-- Não apaga: alertas GPS/velocidade (não têm ligação à linha) nem os GeoJSON
-- guardados no armazenamento.
--
-- Como usar (MySQL do Railway, ex.: DBeaver/TablePlus/mysql CLI):
--   1. Corre o PASSO 1 e confirma os números.
--   2. Faz um backup (Railway → base de dados → Backups) se quiseres volta atrás.
--   3. Corre o PASSO 2 inteiro (é uma transação: ou apaga tudo ou nada).
-- ─────────────────────────────────────────────────────────────────────────────

-- PASSO 1 — pré-visualizar (não altera nada)
SELECT COUNT(*)                  AS linhas_v1,
       MIN(DATE(date))           AS primeiro_dia,
       MAX(DATE(date))           AS ultimo_dia
  FROM daily_driver_history
 WHERE metricsVersion < 2;

SELECT COUNT(*) AS partes_por_pessoa_v1
  FROM driver_day_shares s
  JOIN daily_driver_history h ON h.id = s.historyId
 WHERE h.metricsVersion < 2;

-- PASSO 2 — apagar
START TRANSACTION;

DELETE s FROM driver_day_shares s
  JOIN daily_driver_history h ON h.id = s.historyId
 WHERE h.metricsVersion < 2;

DELETE FROM daily_driver_history
 WHERE metricsVersion < 2;

-- Confirma que ficou a zero antes de gravar:
SELECT COUNT(*) AS linhas_v1_restantes FROM daily_driver_history WHERE metricsVersion < 2;

COMMIT;
-- (se alguma coisa parecer mal antes do COMMIT: ROLLBACK;)
