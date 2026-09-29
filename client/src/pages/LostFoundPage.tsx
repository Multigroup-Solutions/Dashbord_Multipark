import { useAuth } from "@/_core/hooks/useAuth";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { BASE_PATH } from "./lostFound/config";
import { KanbanView } from "./lostFound/KanbanView";
import { DetailView } from "./lostFound/DetailView";
import { CrossRefView } from "./lostFound/CrossRefView";
import { CreateDialog } from "./lostFound/CreateDialog";
import { BookingHistoryView } from "./lostFound/BookingHistoryView";

/**
 * Perdidos (casos reportados por CLIENTES). A página só decide a vista pelo
 * URL; cada vista vive em ./lostFound/*.
 */
export default function LostFoundPage() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const [filterType, setFilterType] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");

  // Deriva a view do URL — assim clicar no sidebar (que faz setLocation
  // para o path base) volta sempre ao kanban e o botão back do browser
  // funciona.
  const { view, selectedId } = useMemo(() => {
    const tail = location.startsWith(BASE_PATH) ? location.slice(BASE_PATH.length).replace(/^\//, "") : "";
    const [section, sub] = tail.split("/");
    if (section === "historico") return { view: "history" as const, selectedId: null };
    if (section === "cruzamento") return { view: "ranking" as const, selectedId: null };
    if (section === "caso" && sub) {
      const id = parseInt(sub, 10);
      if (!isNaN(id)) return { view: "detail" as const, selectedId: id };
    }
    return { view: "kanban" as const, selectedId: null };
  }, [location]);

  const goKanban = () => setLocation(BASE_PATH);
  const goHistory = () => setLocation(`${BASE_PATH}/historico`);
  const goRanking = () => setLocation(`${BASE_PATH}/cruzamento`);
  const goDetail = (id: number) => setLocation(`${BASE_PATH}/caso/${id}`);

  return (
    <>
      {view === "kanban" ? (
        <KanbanView
          user={user}
          filterType={filterType}
          setFilterType={setFilterType}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          onSelect={goDetail}
          onNew={() => setShowCreate(true)}
          onShowRanking={goRanking}
          onShowHistory={goHistory}
        />
      ) : view === "ranking" ? (
        <CrossRefView onBack={goKanban} />
      ) : view === "history" ? (
        <BookingHistoryView onBack={goKanban} />
      ) : selectedId ? (
        <DetailView
          id={selectedId}
          user={user}
          onBack={goKanban}
        />
      ) : null}
      {showCreate && <CreateDialog user={user} onClose={() => setShowCreate(false)} />}
    </>
  );
}
