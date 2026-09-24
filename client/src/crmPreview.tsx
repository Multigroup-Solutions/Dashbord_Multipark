import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CrmWorkspace } from "./components/crm/CrmWorkspace";
import { CrmBookingModal } from "./components/crm/CrmBookingModal";
import { demoDetails, demoList } from "./components/crm/demoData";
import type { CrmBooking, CrmFilters } from "@shared/crm";
import "./index.css";
function Preview() {
  const [filters, setFilters] = useState<CrmFilters>({
    search: "",
    segment: "all",
    sort: "recent",
    page: 1,
    inactiveDays: 180,
  });
  const [selected, setSelected] = useState<string | undefined>(
    demoDetails[0].customer.key
  );
  const [booking, setBooking] = useState<CrmBooking>();
  const [simulate, setSimulate] = useState<"normal" | "error" | "loading">(
    "normal"
  );
  return (
    <main
      style={{
        background: "#f0f4f2",
        minHeight: "100vh",
        padding: "clamp(12px,3vw,42px)",
      }}
    >
      <div
        style={{
          maxWidth: 1540,
          margin: "0 auto 14px",
          display: "flex",
          gap: 10,
          justifyContent: "flex-end",
          fontSize: 11,
        }}
      >
        <label>
          Experimentar estados:{" "}
          <select
            aria-label="Estado de demonstração"
            value={simulate}
            onChange={e => setSimulate(e.target.value as typeof simulate)}
          >
            <option value="normal">Dados carregados</option>
            <option value="loading">A carregar</option>
            <option value="error">Falha de ligação</option>
          </select>
        </label>
      </div>
      <CrmWorkspace
        demo
        filters={filters}
        onFilters={v => {
          setFilters(f => ({ ...f, ...v }));
          setSelected(undefined);
        }}
        list={demoList(filters)}
        detail={demoDetails.find(d => d.customer.key === selected)}
        selected={selected}
        onSelect={setSelected}
        loading={simulate === "loading"}
        detailLoading={false}
        error={
          simulate === "error"
            ? "Falha simulada. Nenhuma ligação à base de dados foi feita."
            : undefined
        }
        onRetry={() => setSimulate("normal")}
        onDetailRetry={() => setSimulate("normal")}
        onBookingPage={() => {}}
        onBooking={setBooking}
      />
      <CrmBookingModal
        demo
        booking={booking}
        close={() => setBooking(undefined)}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
