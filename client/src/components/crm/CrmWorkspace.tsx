import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Car,
  ChevronRight,
  CircleAlert,
  Mail,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import {
  CRM_PAGE_SIZE,
  CRM_SEGMENTS,
  type CrmDetail,
  type CrmFilters,
  type CrmList,
} from "@shared/crm";
import "./crm.css";

export const crmDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("pt-PT", {
        timeZone: "Europe/Lisbon",
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
export const amount = (value: number | null, currency: string | null) => {
  if (value == null || !Number.isFinite(value) || !currency) return "—";
  try {
    return new Intl.NumberFormat("pt-PT", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return "—";
  }
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase();
const statusName = (status: string | null) =>
  ({
    CHECKED_OUT: "Concluída",
    CANCELLED: "Cancelada",
    CANCELED: "Cancelada",
    CHECKED_IN: "No parque",
    CONFIRMED: "Confirmada",
    BOOKED: "Reservada",
    PENDING: "Pendente",
  })[status ?? ""] ??
  status ??
  "Por confirmar";
interface Props {
  filters: CrmFilters;
  onFilters: (value: Partial<CrmFilters>) => void;
  list?: CrmList;
  detail?: CrmDetail;
  selected?: string;
  onSelect: (key?: string) => void;
  loading: boolean;
  detailLoading: boolean;
  error?: string;
  detailError?: string;
  onRetry: () => void;
  onDetailRetry: () => void;
  onBookingPage: (page: number) => void;
  onBooking: (booking: CrmDetail["bookings"][number]) => void;
  demo?: boolean;
}

export function CrmWorkspace(p: Props) {
  const [tab, setTab] = useState<"reservas" | "contactos" | "interacoes">(
    "reservas"
  );
  const c = p.detail?.customer;
  const money = p.list?.canViewMoney ?? false;
  const totalPages = Math.max(
    1,
    Math.ceil((p.list?.total ?? 0) / CRM_PAGE_SIZE)
  );
  const change = (value: Partial<CrmFilters>) =>
    p.onFilters({ ...value, page: 1 });
  const months = new Map<string, number>();
  for (const m of p.detail?.monthly ?? [])
    months.set(m.month, (months.get(m.month) ?? 0) + m.visits);
  const anchor = new Date(p.list?.asOf ?? new Date());
  const bars = Array.from({ length: 12 }, (_, i) => {
    const date = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 11 + i, 1)
    );
    const key = date.toISOString().slice(0, 7);
    return {
      key,
      label: date.toLocaleDateString("pt-PT", {
        month: "short",
        timeZone: "UTC",
      }),
      value: months.get(key) ?? 0,
    };
  });
  const max = Math.max(1, ...bars.map(b => b.value));
  return (
    <section className="crm" aria-label="CRM de clientes">
      {p.demo && (
        <div className="crm-demo">
          <span>Demonstração da branch</span> Dados fictícios · nenhuma
          alteração em produção
        </div>
      )}
      <header className="crm-heading">
        <div>
          <div className="crm-eyebrow">MULTIPARK / RELAÇÃO COM O CLIENTE</div>
          <h1>Clientes que voltam.</h1>
          <p>Uma visão do histórico, da frequência e de cada próxima visita.</p>
        </div>
        <button className="crm-button" onClick={p.onRetry} disabled={p.loading}>
          <RefreshCw size={15} className={p.loading ? "crm-spin" : ""} />{" "}
          Atualizar
        </button>
      </header>
      <div className="crm-overview">
        <div>
          <span>Contactos no âmbito selecionado</span>
          <strong>
            {p.list?.overview.contacts.toLocaleString("pt-PT") ?? "—"}
          </strong>
          <small>Agrupados pelo email da reserva</small>
        </div>
        <div>
          <span>Clientes recorrentes</span>
          <strong>
            {p.list?.overview.returning.toLocaleString("pt-PT") ?? "—"}
          </strong>
          <small>Duas ou mais estadias concluídas</small>
        </div>
        <div>
          <span>Identidades a validar</span>
          <strong>
            {p.list?.overview.review.toLocaleString("pt-PT") ?? "—"}
          </strong>
          <small>Vários nomes ou nome em falta</small>
        </div>
      </div>
      {!!p.list?.overview.missingEmailBookings && (
        <div className="crm-notice">
          <CircleAlert size={16} />
          <span>
            {p.list.overview.missingEmailBookings} reservas sem email válido
            ficam por identificar e não foram agrupadas como clientes.
          </span>
        </div>
      )}
      <div className="crm-filters">
        <label className="crm-search">
          <Search size={17} />
          <input
            aria-label="Pesquisar clientes"
            placeholder="Nome, email, telefone ou matrícula"
            value={p.filters.search}
            onChange={e => change({ search: e.target.value })}
          />
          {p.filters.search && (
            <button
              aria-label="Limpar pesquisa"
              onClick={() => change({ search: "" })}
            >
              <X size={15} />
            </button>
          )}
        </label>
        <label>
          <span className="crm-sr">Segmento</span>
          <select
            aria-label="Segmento"
            value={p.filters.segment}
            onChange={e =>
              change({ segment: e.target.value as CrmFilters["segment"] })
            }
          >
            {Object.entries(CRM_SEGMENTS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="Período de última visita"
          value={p.filters.recentDays ?? ""}
          onChange={e =>
            change({
              recentDays: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        >
          <option value="">Todo o histórico</option>
          <option value="365">Visita nos últimos 12 meses</option>
          <option value="90">Visita nos últimos 90 dias</option>
        </select>
        <select
          aria-label="Ordenar clientes"
          value={p.filters.sort}
          onChange={e => change({ sort: e.target.value as CrmFilters["sort"] })}
        >
          <option value="recent">Visita mais recente</option>
          <option value="visits">Mais estadias</option>
          {money && <option value="value">Maior valor em EUR</option>}
        </select>
        {p.filters.segment === "inactive" && (
          <label className="crm-days">
            Sem visita há{" "}
            <select
              aria-label="Dias sem visita"
              value={p.filters.inactiveDays}
              onChange={e => change({ inactiveDays: Number(e.target.value) })}
            >
              <option value="90">90 dias</option>
              <option value="180">180 dias</option>
              <option value="365">365 dias</option>
            </select>
          </label>
        )}
      </div>
      {p.error ? (
        <div className="crm-empty" role="alert">
          <CircleAlert />
          <h2>Não foi possível carregar os clientes</h2>
          <p>{p.error}</p>
          <button className="crm-button" onClick={p.onRetry}>
            Tentar novamente
          </button>
        </div>
      ) : (
        <div className={`crm-layout ${p.selected ? "crm-has-selection" : ""}`}>
          <aside
            className="crm-directory"
            aria-label="Lista de clientes"
            aria-busy={p.loading}
          >
            <div className="crm-directory-title">
              <span>
                {p.loading
                  ? "A carregar…"
                  : `${p.list?.total ?? 0} contactos encontrados`}
              </span>
              <Users size={16} />
            </div>
            {!p.loading && p.list?.items.length === 0 && (
              <div className="crm-empty">
                <Search />
                <h2>Sem correspondências</h2>
                <p>Experimenta outro nome ou remove um filtro.</p>
              </div>
            )}
            {p.loading && (
              <div className="crm-loading" role="status">
                A consultar o histórico autorizado…
              </div>
            )}
            {!p.loading &&
              p.list?.items.map(person => (
                <button
                  className={`crm-person ${p.selected === person.key ? "crm-person-active" : ""}`}
                  key={person.key}
                  aria-pressed={p.selected === person.key}
                  onClick={() => {
                    p.onSelect(person.key);
                    setTab("reservas");
                  }}
                >
                  <span className="crm-avatar">{initials(person.name)}</span>
                  <span className="crm-person-text">
                    <strong>{person.name}</strong>
                    <span>{person.email}</span>
                    <small>
                      {person.completed}{" "}
                      {person.completed === 1 ? "estadia" : "estadias"} · última{" "}
                      {crmDate(person.lastVisit)}
                    </small>
                    {person.needsReview && <em>Identidade a validar</em>}
                  </span>
                  <span className="crm-person-value">
                    {money && (
                      <strong>
                        {amount(person.stayValue, person.currency)}
                      </strong>
                    )}
                    <ChevronRight size={16} />
                  </span>
                </button>
              ))}
            <div className="crm-pagination">
              <button
                aria-label="Página anterior de clientes"
                disabled={p.filters.page <= 1 || p.loading}
                onClick={() => p.onFilters({ page: p.filters.page - 1 })}
              >
                <ArrowLeft size={16} />
              </button>
              <span>
                {p.filters.page} / {totalPages}
              </span>
              <button
                aria-label="Página seguinte de clientes"
                disabled={p.filters.page >= totalPages || p.loading}
                onClick={() => p.onFilters({ page: p.filters.page + 1 })}
              >
                <ArrowRight size={16} />
              </button>
            </div>
          </aside>
          <article
            className="crm-profile"
            aria-label="Ficha do cliente"
            aria-busy={p.detailLoading}
          >
            {!p.selected ? (
              <div className="crm-welcome">
                <div className="crm-welcome-icon">
                  <Users size={30} />
                </div>
                <div className="crm-eyebrow">CADA VISITA TEM UMA HISTÓRIA</div>
                <h2>
                  Conhece quem está
                  <br />
                  do outro lado da reserva.
                </h2>
                <p>
                  Escolhe um cliente para ver as suas visitas, próximas reservas
                  e interações com a equipa.
                </p>
                <div className="crm-welcome-line" />
                <small>
                  O histórico respeita as cidades e os projetos a que tens
                  acesso.
                </small>
              </div>
            ) : (
              <>
                <button
                  className="crm-back"
                  onClick={() => p.onSelect(undefined)}
                >
                  <ArrowLeft size={15} /> Voltar à lista
                </button>
                {p.detailLoading ? (
                  <div className="crm-loading" role="status">
                    A abrir a ficha…
                  </div>
                ) : p.detailError ? (
                  <div className="crm-empty" role="alert">
                    <h2>Não foi possível abrir a ficha</h2>
                    <p>{p.detailError}</p>
                    <button className="crm-button" onClick={p.onDetailRetry}>
                      Tentar novamente
                    </button>
                  </div>
                ) : (
                  c &&
                  p.detail && (
                    <>
                      <div className="crm-profile-head">
                        <span className="crm-avatar crm-avatar-large">
                          {initials(c.name)}
                        </span>
                        <div>
                          <div className="crm-eyebrow">
                            {c.needsReview
                              ? "CONTACTO A VALIDAR"
                              : c.completed >= 2
                                ? "CLIENTE RECORRENTE"
                                : "HISTÓRICO DO CLIENTE"}
                          </div>
                          <h2>{c.name}</h2>
                          <p>
                            <Mail size={13} />
                            {c.email}
                          </p>
                        </div>
                        <span className="crm-since">
                          Primeira visita conhecida
                          <br />
                          <strong>{crmDate(c.firstVisit)}</strong>
                        </span>
                      </div>
                      {c.needsReview && (
                        <div className="crm-notice">
                          <CircleAlert size={17} />
                          <span>
                            Este email tem vários nomes ou não tem nome. As
                            reservas estão agrupadas pelo contacto; a identidade
                            da pessoa ainda precisa de validação.
                          </span>
                        </div>
                      )}
                      <div className="crm-metrics">
                        <div>
                          <span>Estadias concluídas</span>
                          <strong>{c.completed}</strong>
                          <small>{c.visitsLastYear} nos últimos 12 meses</small>
                        </div>
                        <div>
                          <span>Valor das estadias</span>
                          <strong>
                            {money
                              ? amount(c.stayValue, c.currency)
                              : "Reservado"}
                          </strong>
                          <small>
                            {!money
                              ? "Sem acesso financeiro"
                              : c.stayValue == null
                                ? "Dados em falta ou várias moedas"
                                : `Média ${amount(c.averageValue, c.currency)}`}
                          </small>
                        </div>
                        <div>
                          <span>Ritmo de visitas</span>
                          <strong>
                            {c.averageGapDays == null
                              ? "—"
                              : `${c.averageGapDays} dias`}
                          </strong>
                          <small>Intervalo médio no histórico</small>
                        </div>
                      </div>
                      <div className="crm-next">
                        <CalendarDays size={19} />
                        <div>
                          <span>
                            {c.nextVisit
                              ? "Próxima visita"
                              : "Sem próxima visita marcada"}
                          </span>
                          <strong>
                            {c.nextVisit
                              ? crmDate(c.nextVisit)
                              : `Última estadia: ${crmDate(c.lastVisit)}`}
                          </strong>
                        </div>
                        <span>
                          {c.upcoming} futuras · {c.cancelled} canceladas
                        </span>
                      </div>
                      <div className="crm-chart">
                        <div>
                          <h3>Um ano de visitas</h3>
                          <span>Estadias concluídas por mês</span>
                        </div>
                        <div
                          className="crm-bars"
                          role="img"
                          aria-label={bars
                            .map(b => `${b.key}: ${b.value} visitas`)
                            .join("; ")}
                        >
                          {bars.map(b => (
                            <div
                              key={b.key}
                              title={`${b.key}: ${b.value} visitas`}
                            >
                              <span>{b.value || ""}</span>
                              <i
                                style={{
                                  height: `${Math.max(3, (b.value / max) * 66)}px`,
                                  opacity: b.value ? 1 : 0.16,
                                }}
                              />
                              <small>{b.label}</small>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div
                        className="crm-tabs"
                        role="tablist"
                        aria-label="Detalhes do cliente"
                      >
                        {(["reservas", "contactos", "interacoes"] as const).map(
                          t => (
                            <button
                              id={`crm-tab-${t}`}
                              role="tab"
                              tabIndex={tab === t ? 0 : -1}
                              aria-selected={tab === t}
                              aria-controls="crm-tab-content"
                              key={t}
                              className={tab === t ? "active" : ""}
                              onClick={() => setTab(t)}
                              onKeyDown={event => {
                                const tabs = [
                                  "reservas",
                                  "contactos",
                                  "interacoes",
                                ] as const;
                                const index = tabs.indexOf(t);
                                const next =
                                  event.key === "ArrowRight"
                                    ? (index + 1) % 3
                                    : event.key === "ArrowLeft"
                                      ? (index + 2) % 3
                                      : event.key === "Home"
                                        ? 0
                                        : event.key === "End"
                                          ? 2
                                          : -1;
                                if (next < 0) return;
                                event.preventDefault();
                                setTab(tabs[next]);
                                document
                                  .getElementById(`crm-tab-${tabs[next]}`)
                                  ?.focus();
                              }}
                            >
                              {t === "reservas"
                                ? `Reservas (${c.bookingCount})`
                                : t === "contactos"
                                  ? "Contactos e viaturas"
                                  : "Interações"}
                            </button>
                          )
                        )}
                      </div>
                      <div
                        id="crm-tab-content"
                        role="tabpanel"
                        aria-labelledby={`crm-tab-${tab}`}
                      >
                        {tab === "reservas" && (
                          <>
                            <div className="crm-booking-table">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Reserva / entrada</th>
                                    <th>Parque</th>
                                    <th>Estado</th>
                                    {money && <th>Valor</th>}
                                  </tr>
                                </thead>
                                <tbody>
                                  {p.detail.bookings.map(b => (
                                    <tr key={b.externalId}>
                                      <td>
                                        <button
                                          onClick={() => p.onBooking(b)}
                                          className="crm-link"
                                        >
                                          {b.number ?? b.externalId}
                                        </button>
                                        <small>{crmDate(b.checkIn)}</small>
                                      </td>
                                      <td>
                                        {b.park ?? "—"}
                                        <small>
                                          {b.city} ·{" "}
                                          {b.plate ?? "Sem matrícula"}
                                        </small>
                                      </td>
                                      <td>
                                        <span
                                          className={`crm-status ${b.status === "CHECKED_OUT" ? "done" : b.status?.startsWith("CANCEL") ? "cancelled" : ""}`}
                                        >
                                          {statusName(b.status)}
                                        </span>
                                      </td>
                                      {money && (
                                        <td>{amount(b.value, b.currency)}</td>
                                      )}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="crm-pagination">
                              <button
                                aria-label="Página anterior de reservas"
                                disabled={p.detail.bookingPage <= 1}
                                onClick={() =>
                                  p.onBookingPage(p.detail!.bookingPage - 1)
                                }
                              >
                                <ArrowLeft size={16} />
                              </button>
                              <span>
                                {p.detail.bookingPage} /{" "}
                                {Math.max(
                                  1,
                                  Math.ceil(
                                    p.detail.bookingTotal / CRM_PAGE_SIZE
                                  )
                                )}
                              </span>
                              <button
                                aria-label="Página seguinte de reservas"
                                disabled={
                                  p.detail.bookingPage * CRM_PAGE_SIZE >=
                                  p.detail.bookingTotal
                                }
                                onClick={() =>
                                  p.onBookingPage(p.detail!.bookingPage + 1)
                                }
                              >
                                <ArrowRight size={16} />
                              </button>
                            </div>
                          </>
                        )}
                        {tab === "contactos" && (
                          <div className="crm-contact-panel">
                            <h3>Contactos presentes nas reservas</h3>
                            {p.detail.contacts.map((v, i) => (
                              <p key={i}>
                                <strong>{v.name || "Nome em falta"}</strong>
                                <span>{v.phone ?? "Telefone em falta"}</span>
                              </p>
                            ))}
                            <h3>Viaturas utilizadas em reservas</h3>
                            {p.detail.vehicles.length === 0 && (
                              <p>Sem viaturas identificadas.</p>
                            )}
                            {p.detail.vehicles.map(v => (
                              <p key={v.plate}>
                                <Car size={16} />
                                <strong>{v.plate}</strong>
                                <span>
                                  {[v.brand, v.model].filter(Boolean).join(" ")}{" "}
                                  · {v.bookings} reservas
                                </span>
                              </p>
                            ))}
                          </div>
                        )}
                        {tab === "interacoes" && (
                          <div className="crm-interactions">
                            {p.detail.interactions.length === 0 ? (
                              <p>
                                Sem interações associadas a este email no âmbito
                                autorizado.
                              </p>
                            ) : (
                              p.detail.interactions.map(event => (
                                <a key={event.id} href={event.href}>
                                  <span className="crm-event-dot" />
                                  <div>
                                    <small>
                                      {crmDate(event.date)} ·{" "}
                                      {event.kind === "complaint"
                                        ? "Reclamação"
                                        : event.kind === "lost"
                                          ? "Perdidos e achados"
                                          : "Avaliação"}
                                    </small>
                                    <strong>{event.title}</strong>
                                    <span>{event.status}</span>
                                  </div>
                                  <ChevronRight size={16} />
                                </a>
                              ))
                            )}
                            {p.detail.interactionsTruncated && (
                              <small>
                                Mostram-se as 50 interações mais recentes.
                                Consulta os módulos de origem para o restante
                                histórico.
                              </small>
                            )}
                          </div>
                        )}
                      </div>
                      <footer className="crm-footnote">
                        Histórico conhecido nas reservas sincronizadas. Os
                        valores das estadias não equivalem a pagamentos
                        recebidos. Canceladas e futuras não entram no valor das
                        estadias.
                      </footer>
                    </>
                  )
                )}
              </>
            )}
          </article>
        </div>
      )}
      <footer className="crm-source">
        <span>Fonte: reservas Multipark · agrupamento por email</span>
        <span>
          Última sincronização conhecida: {crmDate(p.list?.overview.latestSync)}
        </span>
      </footer>
    </section>
  );
}
