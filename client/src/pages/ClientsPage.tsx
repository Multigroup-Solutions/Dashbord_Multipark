import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useGlobalFilters } from "@/contexts/GlobalFiltersContext";
import { CrmWorkspace } from "@/components/crm/CrmWorkspace";
import { CrmBookingModal } from "@/components/crm/CrmBookingModal";
import type { CrmBooking, CrmFilters } from "@shared/crm";

export default function ClientsPage() {
  const scope = useGlobalFilters();
  const initialEmail =
    new URLSearchParams(window.location.search).get("email")?.slice(0, 150) ??
    "";
  const [filters, setFilters] = useState<CrmFilters>({
    search: initialEmail,
    segment: "all",
    sort: "recent",
    page: 1,
    inactiveDays: 180,
  });
  const [search, setSearch] = useState(filters.search);
  const [selected, setSelected] = useState<string>();
  const [bookingPage, setBookingPage] = useState(1);
  const [booking, setBooking] = useState<CrmBooking>();
  useEffect(() => {
    const timer = setTimeout(() => setSearch(filters.search), 250);
    return () => clearTimeout(timer);
  }, [filters.search]);
  useEffect(() => {
    setSelected(undefined);
    setBooking(undefined);
    setBookingPage(1);
    setFilters(f => ({ ...f, page: 1 }));
  }, [scope.projectId]);
  const list = trpc.clients.crmList.useQuery(
    { ...filters, search, projectId: scope.projectId },
    {
      enabled: !scope.isLoading && !scope.missingCostCenter,
      refetchOnWindowFocus: true,
    }
  );
  const detail = trpc.clients.crmDetail.useQuery(
    { key: selected ?? "", bookingPage, projectId: scope.projectId },
    { enabled: !!selected && !scope.isLoading && !scope.missingCostCenter }
  );
  const select = (key?: string) => {
    setSelected(key);
    setBookingPage(1);
    setBooking(undefined);
  };
  return (
    <>
      <CrmWorkspace
        filters={filters}
        onFilters={value => {
          setFilters(f => ({ ...f, ...value }));
          select(undefined);
        }}
        list={list.data}
        detail={detail.data}
        selected={selected}
        onSelect={select}
        loading={list.isLoading || scope.isLoading}
        detailLoading={detail.isLoading}
        error={list.error?.message}
        detailError={detail.error?.message}
        onRetry={() => {
          void list.refetch();
          if (selected) void detail.refetch();
        }}
        onDetailRetry={() => {
          void detail.refetch();
        }}
        onBookingPage={setBookingPage}
        onBooking={setBooking}
      />
      <CrmBookingModal booking={booking} close={() => setBooking(undefined)} />
    </>
  );
}
