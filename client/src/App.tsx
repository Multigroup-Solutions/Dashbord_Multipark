import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import DashboardLayout from "./components/DashboardLayout";
import ExpensesPage from "./pages/ExpensesPage";
import ExpenseDashboard from "./pages/ExpenseDashboard";
import UsersPage from "./pages/UsersPage";
import LogsPage from "./pages/LogsPage";
import HRPage from "./pages/HRPage";
import ProjectsPage from "./pages/ProjectsPage";
import TasksPage from "./pages/TasksPage";
import MarketingPage from "./pages/MarketingPage";
import ShiftHandoverPage from "./pages/ShiftHandoverPage";
import OperationalPage from "./pages/OperationalPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import ComplaintsPage from "./pages/ComplaintsPage";
import GoogleReviewsPage from "./pages/GoogleReviewsPage";
import TrainingPage from "./pages/TrainingPage";
import LostFoundPage from "./pages/LostFoundPage";
import ServicesPage from "./pages/ServicesPage";
import IncidentsPage from "./pages/IncidentsPage";
import PerformancePage from "./pages/PerformancePage";
import InvoicesPage from "./pages/InvoicesPage";
import PartnershipsPage from "./pages/PartnershipsPage";
import PartnerInferPage from "./pages/PartnerInferPage";
import PartnerTypePage from "./pages/PartnerTypePage";
import BillingDiagnosePage from "./pages/BillingDiagnosePage";
import AnnualPage from "./pages/AnnualPage";
import MultiparkPage from "./pages/MultiparkPage";
import OperacoesPage from "./pages/OperacoesPage";
import ExtrasDiaPage from "./pages/ExtrasDiaPage";
import AvaliacaoOperacionalPage from "./pages/AvaliacaoOperacionalPage";
import MultiparkInspectPage from "./pages/MultiparkInspectPage";
import InvitePage from "./pages/InvitePage";
import DisponibilidadePage from "./pages/DisponibilidadePage";
import WhatsAppInboxPage from "./pages/WhatsAppInboxPage";
import ProjectCostsDashboard from "./pages/ProjectCostsDashboard";
import DashboardPage from "./pages/DashboardPage";
import DashboardsPage from "./pages/DashboardsPage";
import FinanceiroDashboard from "./pages/FinanceiroDashboard";
import OperacoesDashboard from "./pages/OperacoesDashboard";
import PessoasDashboard from "./pages/PessoasDashboard";
import RhDashboardPage from "./pages/RhDashboardPage";
import SuporteDashboard from "./pages/SuporteDashboard";
import MarketingDashboard from "./pages/MarketingDashboard";
import { GlobalFiltersProvider } from "./contexts/GlobalFiltersContext";

function Router() {
  return (
    <Switch>
      <Route path="/convite/:token" component={InvitePage} />
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
      <Route path="/despesas/dashboard">
        {() => (
          <DashboardLayout>
            <ExpenseDashboard />
          </DashboardLayout>
        )}
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
      <Route path="/operacional">
        {() => (<DashboardLayout><OperationalPage /></DashboardLayout>)}
      </Route>
      <Route path="/reclamacoes">
        {() => (<DashboardLayout><ComplaintsPage /></DashboardLayout>)}
      </Route>
      <Route path="/criticas">
        {() => (<DashboardLayout><GoogleReviewsPage /></DashboardLayout>)}
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
        {() => (<DashboardLayout><PerformancePage /></DashboardLayout>)}
      </Route>
      <Route path="/faturacao">
        {() => (<DashboardLayout><InvoicesPage /></DashboardLayout>)}
      </Route>
      <Route path="/faturacao/diagnose">
        {() => (<DashboardLayout><BillingDiagnosePage /></DashboardLayout>)}
      </Route>
      <Route path="/parcerias">
        {() => (<DashboardLayout><PartnershipsPage /></DashboardLayout>)}
      </Route>
      <Route path="/parcerias/inferir">
        {() => (<DashboardLayout><PartnerInferPage /></DashboardLayout>)}
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
          first-match-wins e o param opcional engoliria /multipark/inspect. */}
      <Route path="/multipark/inspect">
        {() => (<DashboardLayout><MultiparkInspectPage /></DashboardLayout>)}
      </Route>
      <Route path="/multipark/:section?">
        {() => (<DashboardLayout><MultiparkPage /></DashboardLayout>)}
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
      <Route path="/passagem-turno">
        {() => (<DashboardLayout><ShiftHandoverPage /></DashboardLayout>)}
      </Route>
      <Route path="/avaliacao-operacional">
        {() => (<DashboardLayout><AvaliacaoOperacionalPage /></DashboardLayout>)}
      </Route>
      <Route path="/api-keys">
        {() => (<DashboardLayout><ApiKeysPage /></DashboardLayout>)}
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
      <Route path="/marketing-dashboard">
        {() => (<DashboardLayout><MarketingDashboard /></DashboardLayout>)}
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
