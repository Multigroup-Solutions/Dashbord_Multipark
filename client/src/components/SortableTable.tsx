import { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

// Ordenação de tabelas transversal (pedido do Jorge 2026-08-06: "setas de
// ordenação em todas as colunas, em todo o lado"). Uso:
//   const { sorted, sortKey, sortDir, toggle } = useTableSort(rows);
//   <Th k="name" label="Nome" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
//   ... sorted.map(...)
// `k` pode ser a chave do objeto ("totalPrice") ou um caminho ("employee.fullName").
// O comparador percebe números (mesmo em string "12.50"), datas ISO e texto PT.

type Dir = 1 | -1;

function getPath(obj: any, path: string): any {
  if (!path.includes(".")) return obj?.[path];
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function rank(v: any): number {
  // nulls/vazios sempre no fim, independentemente da direção
  return v == null || v === "" ? 1 : 0;
}

function cmpValues(a: any, b: any): number {
  if (a == null || a === "") return 0;
  // números (inclui strings numéricas tipo "12.50" vindas de DECIMAL)
  const na = typeof a === "number" ? a : (typeof a === "string" && /^-?\d+([.,]\d+)?$/.test(a.trim()) ? parseFloat(a.replace(",", ".")) : NaN);
  const nb = typeof b === "number" ? b : (typeof b === "string" && /^-?\d+([.,]\d+)?$/.test(String(b).trim()) ? parseFloat(String(b).replace(",", ".")) : NaN);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  // datas ISO ("2026-08-06..." ) comparam bem como string; resto = texto PT
  return String(a).localeCompare(String(b), "pt", { numeric: true, sensitivity: "base" });
}

export function useTableSort<T>(rows: T[], defaultKey?: string, defaultDir: Dir = 1) {
  const [sortKey, setSortKey] = useState<string | null>(defaultKey ?? null);
  const [sortDir, setSortDir] = useState<Dir>(defaultDir);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const va = getPath(a, sortKey);
      const vb = getPath(b, sortKey);
      const r = rank(va) - rank(vb);
      if (r !== 0) return r; // vazios no fim
      return cmpValues(va, vb) * sortDir;
    });
  }, [rows, sortKey, sortDir]);

  const toggle = (key: string) => {
    if (sortKey !== key) { setSortKey(key); setSortDir(1); }
    else if (sortDir === 1) setSortDir(-1);
    else { setSortKey(null); setSortDir(1); } // 3º clique volta à ordem original
  };

  return { sorted, sortKey, sortDir, toggle };
}

/** Cabeçalho de coluna ordenável — substitui o <th>. */
export function Th({
  k, label, sortKey, sortDir, onToggle, className = "", align,
}: {
  k: string;
  label: React.ReactNode;
  sortKey: string | null;
  sortDir: Dir;
  onToggle: (k: string) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const active = sortKey === k;
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th
      className={`p-2 cursor-pointer select-none hover:bg-muted/70 transition-colors ${alignCls} ${className}`}
      onClick={() => onToggle(k)}
      title="Ordenar por esta coluna"
    >
      <span className={`inline-flex items-center gap-0.5 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        {active
          ? (sortDir === 1 ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />)
          : <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-30" />}
      </span>
    </th>
  );
}
