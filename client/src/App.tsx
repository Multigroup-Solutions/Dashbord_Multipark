import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import DashboardLayout from "./components/DashboardLayout";
import ExpensesPage from "./pages/ExpensesPage";
import UsersPage from "./pages/UsersPage";
import LogsPage from "./pages/LogsPage";
import HRPage from "./pages/HRPage";
import ProjectsPage from "./pages/ProjectsPage";
import TasksPage from "./pages/TasksPage";
import MarketingPage from "./pages/MarketingPage";
import ShiftHandoverPage from "./pages/ShiftHandoverPage";
import OperationalPage from "./pages/OperationalPage";
import PdaRegisterPage from "./pages/PdaRegisterPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import IntegrationsGoogleAdsPage from "./pages/IntegrationsGoogleAdsPage";
import IntegrationsHubPage from "./pages/IntegrationsHubPage";
import PermissionsPage from "./pages/PermissionsPage";
import ModulesPage from "./pages/ModulesPage";
import ProfilePage from "./pages/ProfilePage";
import DefinicoesPage from "./pages/DefinicoesPage";
import ComplaintsPage from "./pages/ComplaintsPage";
import GoogleReviewsPage from "./pages/GoogleReviewsPage";
import CondutoresAgentesPage from "./pages/CondutoresAgentesPage";
import TrainingPage from "./pages/TrainingPage";
import KnowledgeBasePage from "./pages/KnowledgeBasePage";
import LostFoundPage from "./pages/LostFoundPage";
import CrmClientsPage from "./pages/CrmClientsPage";
import CrmClientPage from "./pages/CrmClientPage";
import CrmReviewPage from "./pages/CrmReviewPage";
import CrmPartnerPage from "./pages/CrmPartnerPage";
import CrmParkPage from "./pages/CrmParkPage";
import ContactsPage from "./pages/ContactsPage";
import ServicesPage from "./pages/ServicesPage";
import IncidentsPage from "./pages/IncidentsPage";
import AvaliacaoPage from "./pages/AvaliacaoPage";
import InvoicesPage from "./pages/InvoicesPage";
import CaixaPage from "./pages/CaixaPage";
import PartnershipsPage from "./pages/PartnershipsPage";
import PartnerTypePage from "./pages/PartnerTypePage";
import BillingDiagnosePage from "./pages/BillingDiagnosePage";
import AnnualPage from "./pages/AnnualPage";
import OperacoesPage from "./pages/OperacoesPage";
import ExtrasDiaPage from "./pages/ExtrasDiaPage";
import BookingFilePage from "./pages/BookingFilePage";
import InvitePage from "./pages/InvitePage";
import DisponibilidadePage from "./pages/DisponibilidadePage";
import WhatsAppInboxPage from "./pages/WhatsAppInboxPage";
import ComunicacaoPage from "./pages/ComunicacaoPage";
import CalendarioPage from "./pages/CalendarioPage";
import ExtraLeadsPage from "./pages/ExtraLeadsPage";
import ProjectCostsDashboard from "./pages/ProjectCostsDashboard";
import DashboardPage from "./pages/DashboardPage";
import DashboardsPage from "./pages/DashboardsPage";
import FinanceiroDashboard from "./pages/FinanceiroDashboard";
import OperacoesDashboard from "./pages/OperacoesDashboard";
import PessoasDashboard from "./pages/PessoasDashboard";
import RhDashboardPage from "./pages/RhDashboardPage";
import SuporteDashboard from "./pages/SuporteDashboard";
import { GlobalFiltersProvider } from "./contexts/GlobalFiltersContext";

function Router() {
  return (
    <Switch>
      <Route path="/convite/:token" component={InvitePage} />
      <Route path="/pda/registar" component={PdaRegisterPage} />
      <Route path="/" component={Home} />
      <Route path="/dashboards">
        {() => (
          <DashboardLayout>
            <DashboardsPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/dashboard">
        {() => (
          <DashboardLayout>
            <DashboardPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/despesas">
        {() => (
          <DashboardLayout>
            <ExpensesPage />
          </DashboardLayout>
        )}
      </Route>
      {/* O painel passou a separador "Resumo" de /despesas */}
      <Route path="/despesas/dashboard">
        {() => <Redirect to="/despesas?tab=resumo" />}
      </Route>
      <Route path="/utilizadores">
        {() => (
          <DashboardLayout>
            <UsersPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/rh/utilizadores">
        {() => (
          <DashboardLayout>
            <UsersPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/rh/dashboard">
        {() => (
          <DashboardLayout>
            <RhDashboardPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/logs">
        {() => (
          <DashboardLayout>
            <LogsPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/rh">
        {() => (
          <DashboardLayout>
            <HRPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/projetos">
        {() => (
          <DashboardLayout>
            <ProjectsPage />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/tarefas">
        {() => (
          <DashboardLayout>
            <TasksPage />
          </DashboardLayout>
        )}
      </Route>
      {/* 45e: o calendário da própria pessoa (Google Calendar, lido ao vivo) */}
      <Route path="/calendario">
        {() => (<DashboardLayout><CalendarioPage /></DashboardLayout>)}
      </Route>
      <Route path="/projetos/custos">
        {() => (
          <DashboardLayout>
            <ProjectCostsDashboard />
          </DashboardLayout>
        )}
      </Route>
      <Route path="/marketing">
        {() => (<DashboardLayout><MarketingPage /></DashboardLayout>)}
      </Route>
      {/* Google Ads é um separador da página de Marketing (deep link) */}
      <Route path="/marketing/google-ads">
        {() => (<DashboardLayout><MarketingPage /></DashboardLayout>)}
      </Route>
      <Route path="/marketing/canais">
        {() => (<DashboardLayout><MarketingPage /></DashboardLayout>)}
      </Route>
      <Route path="/marketing/orcamentos">
        {() => (<DashboardLayout><MarketingPage /></DashboardLayout>)}
      </Route>
      <Route path="/marketing/web">
        {() => (<DashboardLayout><MarketingPage /></DashboardLayout>)}
      </Route>
      <Route path="/operacional">
        {() => (<DashboardLayout><OperationalPage /></DashboardLayout>)}
      </Route>
      {/* 43b: o Rádio passou para dentro da Atividade diária */}
      <Route path="/radio">
        {() => <Redirect to="/operacional?tab=radio" replace />}
      </Route>
      <Route path="/reclamacoes">
        {() => (<DashboardLayout><ComplaintsPage /></DashboardLayout>)}
      </Route>
      <Route path="/criticas">
        {() => (<DashboardLayout><GoogleReviewsPage /></DashboardLayout>)}
      </Route>
      <Route path="/clientes/parceiros/:id">
        {() => (<DashboardLayout><CrmPartnerPage /></DashboardLayout>)}
      </Route>
      <Route path="/clientes/parques/:id">
        {() => (<DashboardLayout><CrmParkPage /></DashboardLayout>)}
      </Route>
      <Route path="/clientes/rever">
        {() => (<DashboardLayout><CrmReviewPage /></DashboardLayout>)}
      </Route>
      <Route path="/clientes/:id">
        {() => (<DashboardLayout><CrmClientPage /></DashboardLayout>)}
      </Route>
      <Route path="/clientes">
        {() => (<DashboardLayout><CrmClientsPage /></DashboardLayout>)}
      </Route>
      <Route path="/contactos">
        {() => (<DashboardLayout><ContactsPage /></DashboardLayout>)}
      </Route>
      <Route path="/extras-leads">
        {() => (<DashboardLayout><ExtraLeadsPage /></DashboardLayout>)}
      </Route>
      <Route path="/formacao/conhecimento">
        {() => (<DashboardLayout><KnowledgeBasePage /></DashboardLayout>)}
      </Route>
      <Route path="/formacao">
        {() => (<DashboardLayout><TrainingPage /></DashboardLayout>)}
      </Route>
      <Route path="/perdidos-achados/:section/:sub?">
        {() => (<DashboardLayout><LostFoundPage /></DashboardLayout>)}
      </Route>
      <Route path="/perdidos-achados">
        {() => (<DashboardLayout><LostFoundPage /></DashboardLayout>)}
      </Route>
      <Route path="/ocorrencias">
        {() => (<DashboardLayout><IncidentsPage /></DashboardLayout>)}
      </Route>
      <Route path="/avaliacao">
        {() => (<DashboardLayout><AvaliacaoPage /></DashboardLayout>)}
      </Route>
      <Route path="/pessoas/condutores-agentes">
        {() => (<DashboardLayout><CondutoresAgentesPage /></DashboardLayout>)}
      </Route>
      <Route path="/faturacao">
        {() => (<DashboardLayout><InvoicesPage /></DashboardLayout>)}
      </Route>
      <Route path="/caixa">
        {() => (<DashboardLayout><CaixaPage /></DashboardLayout>)}
      </Route>
      <Route path="/faturacao/diagnose">
        {() => (<DashboardLayout><BillingDiagnosePage /></DashboardLayout>)}
      </Route>
      <Route path="/parcerias">
        {() => (<DashboardLayout><PartnershipsPage /></DashboardLayout>)}
      </Route>
      {/* A inferência de parceiros saiu: os parceiros vêm ao vivo da BD da Multipark */}
      <Route path="/parcerias/inferir">
        {() => <Redirect to="/parcerias" replace />}
      </Route>
      <Route path="/parcerias/tipo/:typeId">
        {() => (<DashboardLayout><PartnerTypePage /></DashboardLayout>)}
      </Route>
      <Route path="/anual">
        {() => (<DashboardLayout><AnnualPage /></DashboardLayout>)}
      </Route>
      <Route path="/operacoes">
        {() => (<DashboardLayout><OperacoesPage /></DashboardLayout>)}
      </Route>
      {/* Rotas exatas ANTES de /multipark/:section? — o Switch do wouter é
          first-match-wins e o param opcional engoliria /multipark/inspect.
          O antigo "Inspecionar reserva" passou a ser a ficha da reserva. */}
      <Route path="/multipark/inspect">
        {() => {
          const ref = new URLSearchParams(window.location.search).get("id") ?? new URLSearchParams(window.location.search).get("externalId");
          return <Redirect to={ref ? `/reserva/${encodeURIComponent(ref)}` : "/reserva"} replace />;
        }}
      </Route>
      {/* Ficha da reserva: tudo sobre uma reserva, lido ao vivo da BD Multipark. */}
      <Route path="/reserva/:ref?">
        {() => (<DashboardLayout><BookingFilePage /></DashboardLayout>)}
      </Route>
      <Route path="/multipark/sync">
        {() => <Redirect to="/definicoes?tab=estado" />}
      </Route>
      {/* As listas antigas (/multipark/reservas, entradas, saidas, cancelados)
          abrem as abas com o mesmo nome nas Operações; o resto, as "Reservas do
          dia". A Sincronização (estado) vive em Definições → Estado do sistema. */}
      <Route path="/multipark/:section?">
        {(params) => <Redirect to={`/operacoes?tab=${["reservas", "entradas", "saidas", "cancelados"].includes(params.section ?? "") ? params.section : "dia"}`} />}
      </Route>
      <Route path="/servicos">
        {() => (<DashboardLayout><ServicesPage /></DashboardLayout>)}
      </Route>
      <Route path="/extras-dia">
        {() => (<DashboardLayout><ExtrasDiaPage /></DashboardLayout>)}
      </Route>
      <Route path="/disponibilidade">
        {() => (<DashboardLayout><DisponibilidadePage /></DashboardLayout>)}
      </Route>
      <Route path="/whatsapp">
        {() => (<DashboardLayout><WhatsAppInboxPage /></DashboardLayout>)}
      </Route>
      <Route path="/comunicacao/meu-email">
        {() => (<DashboardLayout><ComunicacaoPage key="pessoal" personal /></DashboardLayout>)}
      </Route>
      <Route path="/comunicacao">
        {() => (<DashboardLayout><ComunicacaoPage key="partilhadas" /></DashboardLayout>)}
      </Route>
      <Route path="/passagem-turno">
        {() => (<DashboardLayout><ShiftHandoverPage /></DashboardLayout>)}
      </Route>
      <Route path="/avaliacao-operacional">
        {() => <Redirect to="/avaliacao?tab=dia" replace />}
      </Route>
      <Route path="/api-keys">
        {() => (<DashboardLayout><ApiKeysPage /></DashboardLayout>)}
      </Route>
      <Route path="/permissoes">
        {() => (<DashboardLayout><PermissionsPage /></DashboardLayout>)}
      </Route>
      <Route path="/modulos">
        {() => (<DashboardLayout><ModulesPage /></DashboardLayout>)}
      </Route>
      <Route path="/perfil">
        {() => (<DashboardLayout><ProfilePage /></DashboardLayout>)}
      </Route>
      <Route path="/definicoes">
        {() => (<DashboardLayout><DefinicoesPage /></DashboardLayout>)}
      </Route>
      <Route path="/financeiro">
        {() => (<DashboardLayout><FinanceiroDashboard /></DashboardLayout>)}
      </Route>
      <Route path="/operacoes-dashboard">
        {() => (<DashboardLayout><OperacoesDashboard /></DashboardLayout>)}
      </Route>
      <Route path="/pessoas-dashboard">
        {() => (<DashboardLayout><PessoasDashboard /></DashboardLayout>)}
      </Route>
      <Route path="/suporte-dashboard">
        {() => (<DashboardLayout><SuporteDashboard /></DashboardLayout>)}
      </Route>
      {/* Rota antiga duplicada: o dashboard de marketing é /marketing */}
      <Route path="/marketing-dashboard">
        {() => <Redirect to="/marketing" />}
      </Route>
      <Route path="/integracoes/google-ads">
        {() => (<DashboardLayout><IntegrationsGoogleAdsPage /></DashboardLayout>)}
      </Route>
      <Route path="/integracoes">
        {() => (<DashboardLayout><IntegrationsHubPage /></DashboardLayout>)}
      </Route>
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <GlobalFiltersProvider>
          <TooltipProvider>
            <Toaster richColors position="top-right" />
            <Router />
          </TooltipProvider>
        </GlobalFiltersProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
