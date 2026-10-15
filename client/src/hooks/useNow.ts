import { useEffect, useState } from "react";

/** A hora de agora (ms), atualizada a cada `everyMs` (cronómetros do ao vivo). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
