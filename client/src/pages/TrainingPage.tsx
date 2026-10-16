import { useAuth } from "@/_core/hooks/useAuth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { TUTOR_ENTITY_TYPES, trainingDeepLink, type TutorContext } from "@shared/trainingTutor";
import { TutorModuleContext } from "./training/TutorPanel";
import { BarChart3, BookOpen, ClipboardList, Gamepad2, GraduationCap, HelpCircle, ListChecks, Play } from "lucide-react";
import { can, seesBeyondOwn } from "@shared/access";
import { FAQsTab, ManualsTab, VideoPlayerDialog, VideosTab, useDoneSet } from "./training/ContentTabs";
import { CareerTab, QuizTab, type QuizPreset } from "./training/Assessments";
import { DashboardTab, MyTrainingTab, PathsAdminTab } from "./training/Management";
import { useMultisPage } from "@/components/assistant/useMultisPage";

export default function TrainingPage() {
  const { user } = useAuth();
  const role = user?.role;
  const isAdmin = can(user, "formacao", "manage");
  const isSuperAdmin = role === "super_admin";
  // Percursos (atribuir): supervisor+. Acompanhamento: também o team leader (a equipa).
  const isSupervisor = seesBeyondOwn(user, "formacao") && can(user, "formacao", "edit");
  const seesProgress = seesBeyondOwn(user, "formacao");
  const [tab, setTab] = usePersistedState("training.tab", "mine");
  // D7: o módulo do tutor aberto (manual, vídeo, percurso) — o Multis, como tutor, sabe qual é.
  const [tutorModule, setTutorModule] = useState<TutorContext | null>(null);
  const tutorCtx = useMemo(() => ({
    register: (c: TutorContext) => {
      setTutorModule(c);
      return () => setTutorModule((cur) => (cur && cur.type === c.type && cur.id === c.id ? null : cur));
    },
  }), []);
  const tutorEntityType = tutorModule && tutorModule.type !== "quiz" ? TUTOR_ENTITY_TYPES[tutorModule.type] : null;
  // Plano MPV §3.1: o Multis sabe o separador aberto (e, D7, o módulo do tutor aberto).
  useMultisPage({ tab, entity: tutorEntityType ? { type: tutorEntityType, id: tutorModule!.id } : null });
  const [openManualId, setOpenManualId] = useState<number | null>(null);
  const [playVideo, setPlayVideo] = useState<any>(null);
  // Tema do próximo quiz: o da formação (categoria do percurso) ou o procurado em "A minha formação".
  const [quizPreset, setQuizPreset] = useState<QuizPreset | null>(null);

  const mineQ = trpc.training.myTraining.useQuery();
  const mine = mineQ.data;
  const done = useDoneSet(mine?.progress);
  const pending = useMemo(() => (mine?.assignments ?? []).filter((a: any) => a.status !== "completed").length, [mine]);
  const allVideosQ = trpc.training.videos.useQuery({});
  const allVideos = allVideosQ.data ?? [];

  const openItem = useCallback((it: { itemType: string; itemId: number; title?: string }) => {
    if (it.itemType === "video") {
      const v = (allVideos as any[]).find((x) => x.id === it.itemId);
      if (v) setPlayVideo(v);
      // 18c: antes o "Abrir" não fazia nada quando a lista de vídeos falhava.
      else { setTab("videos"); if (allVideosQ.error) void allVideosQ.refetch(); }
    } else if (it.itemType === "manual") { setOpenManualId(it.itemId); setTab("manuals"); }
    else if (it.itemType === "exam") setTab("career");
    else if (it.itemType === "quiz") {
      // Quiz de um percurso: o tema é a categoria do item (0 = qualquer).
      setQuizPreset(it.itemId > 0 ? { categoryId: it.itemId, label: it.title ?? null } : null);
      setTab("quiz");
    }
  }, [allVideos, allVideosQ, setTab]);
  const quizTopic = useCallback((topic: string) => { setQuizPreset({ topic, label: topic }); setTab("quiz"); }, [setTab]);
  const clearOpenManual = useCallback(() => setOpenManualId(null), []);

  // D7: as "Fontes" do Multis abrem o manual ou o vídeo (/formacao?manual=12, /formacao?video=5).
  const search = useSearch();
  const [, navigate] = useLocation();
  const deepLink = useMemo(() => trainingDeepLink(search), [search]);
  useEffect(() => {
    if (!deepLink) return;
    if (deepLink.type === "manual") {
      openItem({ itemType: "manual", itemId: deepLink.id });
      navigate("/formacao", { replace: true });
    } else if (allVideosQ.data || allVideosQ.error) {
      openItem({ itemType: "video", itemId: deepLink.id });
      navigate("/formacao", { replace: true });
    }
  }, [deepLink, allVideosQ.data, allVideosQ.error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TutorModuleContext.Provider value={tutorCtx}>
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">Formação obrigatória, vídeos, manuais, FAQs, quiz e exames de carreira</p>
        {isAdmin && (
          <Link href="/formacao/conhecimento" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <BookOpen className="h-4 w-4" /> Base de conhecimento (Drive e documentos)
          </Link>
        )}
      </div>
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="flex flex-wrap justify-start w-full h-auto gap-1">
          <TabsTrigger value="mine"><ListChecks className="w-4 h-4 mr-1" />A minha formação{pending > 0 && <Badge className="ml-1 h-5 px-1.5 bg-red-500 text-white">{pending}</Badge>}</TabsTrigger>
          <TabsTrigger value="videos"><Play className="w-4 h-4 mr-1" />Vídeos</TabsTrigger>
          <TabsTrigger value="manuals"><BookOpen className="w-4 h-4 mr-1" />Manuais</TabsTrigger>
          <TabsTrigger value="faqs"><HelpCircle className="w-4 h-4 mr-1" />FAQs</TabsTrigger>
          <TabsTrigger value="quiz"><Gamepad2 className="w-4 h-4 mr-1" />Quiz</TabsTrigger>
          <TabsTrigger value="career"><GraduationCap className="w-4 h-4 mr-1" />Carreira</TabsTrigger>
          {isSupervisor && <TabsTrigger value="paths"><ClipboardList className="w-4 h-4 mr-1" />Percursos</TabsTrigger>}
          {seesProgress && <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Acompanhamento</TabsTrigger>}
        </TabsList>

        <TabsContent value="mine"><MyTrainingTab data={mine} loading={mineQ.isLoading} error={mineQ.error} onRetry={() => mineQ.refetch()} retrying={mineQ.isFetching} onOpenItem={openItem} done={done} onQuizTopic={quizTopic} /></TabsContent>
        <TabsContent value="videos"><VideosTab isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} done={done} /></TabsContent>
        <TabsContent value="manuals"><ManualsTab isAdmin={isAdmin} done={done} openId={openManualId} onOpened={clearOpenManual} /></TabsContent>
        <TabsContent value="faqs"><FAQsTab isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="quiz"><QuizTab isAdmin={isAdmin} preset={quizPreset} onClearPreset={() => setQuizPreset(null)} /></TabsContent>
        <TabsContent value="career"><CareerTab isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} certificates={mine?.certificates ?? []} /></TabsContent>
        {isSupervisor && <TabsContent value="paths"><PathsAdminTab isAdmin={isAdmin} /></TabsContent>}
        {seesProgress && <TabsContent value="dashboard"><DashboardTab /></TabsContent>}
      </Tabs>
      <VideoPlayerDialog video={playVideo} done={playVideo ? done.has(`video:${playVideo.id}`) : false} onClose={() => setPlayVideo(null)} />
    </div>
    </TutorModuleContext.Provider>
  );
}
