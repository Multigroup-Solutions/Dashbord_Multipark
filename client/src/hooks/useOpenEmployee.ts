import { useLocation } from "wouter";

// Abrir a ficha de um colaborador a partir de QUALQUER página (pedido Jorge:
// "cada vez que carregamos num utilizador, abrir o funcionário"). O HRPage
// guarda a ficha aberta em sessionStorage (mp.filters.hr.selectedId) — basta
// escrever lá o id e navegar para /rh.
export function useOpenEmployee() {
  const [, navigate] = useLocation();
  return (employeeId: number | null | undefined) => {
    if (!employeeId) return;
    try {
      sessionStorage.setItem("mp.filters.hr.selectedId", JSON.stringify(employeeId));
    } catch { /* sessionStorage indisponível — a navegação abre a lista */ }
    navigate("/rh");
  };
}
