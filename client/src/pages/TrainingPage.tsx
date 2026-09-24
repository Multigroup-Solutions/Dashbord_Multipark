import { useAuth } from "@/_core/hooks/useAuth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useCallback, useMemo, useState } from "react";
import { BarChart3, BookOpen, ClipboardList, Gamepad2, GraduationCap, HelpCircle, ListChecks, Play } from "lucide-react";
import { can, seesBeyondOwn } from "@shared/access";
import { FAQsTab, ManualsTab, VideoPlayerDialog, VideosTab, useDoneSet } from "./training/ContentTabs";
import { CareerTab, QuizTab } from "./training/Assessments";
import { DashboardTab, MyTrainingTab, PathsAdminTab } from "./training/Management";

export default function TrainingPage() {
  const { user } = useAuth();
  const role = user?.role;
  const isAdmin = can(user, "formacao", "manage");
  const isSuperAdmin = role === "super_admin";
  // Percursos (atribuir): supervisor+. Acompanhamento: também o team leader (a equipa).
  const isSupervisor = seesBeyondOwn(user, "formacao") && can(user, "formacao", "edit");
  const seesProgress = seesBeyondOwn(user, "formacao");
  const [tab, setTab] = usePersistedState("training.tab", "mine");
  const [openManualId, setOpenManualId] = useState<number | null>(null);
  const [playVideo, setPlayVideo] = useState<any>(null);

  const { data: mine } = trpc.training.myTraining.useQuery();
  const done = useDoneSet(mine?.progress);
  const pending = useMemo(() => (mine?.assignments ?? []).filter((a: any) => a.status !== "completed").length, [mine]);
  const { data: allVideos = [] } = trpc.training.videos.useQuery({});

  const openItem = useCallback((it: { itemType: string; itemId: number }) => {
    if (it.itemType === "video") {
      const v = (allVideos as any[]).find((x) => x.id === it.itemId);
      if (v) setPlayVideo(v);
    } else if (it.itemType === "manual") { setOpenManualId(it.itemId); setTab("manuals"); }
    else if (it.itemType === "exam") setTab("career");
    else if (it.itemType === "quiz") setTab("quiz");
  }, [allVideos, setTab]);
  const clearOpenManual = useCallback(() => setOpenManualId(null), []);

  const cols = 6 + (isAdmin ? 1 : 0) + (isSupervisor ? 1 : 0) + (seesProgress && !isSupervisor ? 1 : 0);
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">Formação obrigatória, vídeos, manuais, FAQs, quiz e exames de carreira</p>
      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className={`grid grid-cols-2 sm:grid-cols-4 ${cols > 6 ? "lg:grid-cols-8" : "lg:grid-cols-6"} w-full h-auto`}>
          <TabsTrigger value="mine"><ListChecks className="w-4 h-4 mr-1" />A minha formação{pending > 0 && <Badge className="ml-1 h-5 px-1.5 bg-red-500 text-white">{pending}</Badge>}</TabsTrigger>
          <TabsTrigger value="videos"><Play className="w-4 h-4 mr-1" />Vídeos</TabsTrigger>
          <TabsTrigger value="manuals"><BookOpen className="w-4 h-4 mr-1" />Manuais</TabsTrigger>
          <TabsTrigger value="faqs"><HelpCircle className="w-4 h-4 mr-1" />FAQs</TabsTrigger>
          <TabsTrigger value="quiz"><Gamepad2 className="w-4 h-4 mr-1" />Quiz</TabsTrigger>
          <TabsTrigger value="career"><GraduationCap className="w-4 h-4 mr-1" />Carreira</TabsTrigger>
          {isSupervisor && <TabsTrigger value="paths"><ClipboardList className="w-4 h-4 mr-1" />Percursos</TabsTrigger>}
          {seesProgress && <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Acompanhamento</TabsTrigger>}
        </TabsList>

        <TabsContent value="mine"><MyTrainingTab data={mine} onOpenItem={openItem} /></TabsContent>
        <TabsContent value="videos"><VideosTab isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} done={done} /></TabsContent>
        <TabsContent value="manuals"><ManualsTab isAdmin={isAdmin} done={done} openId={openManualId} onOpened={clearOpenManual} /></TabsContent>
        <TabsContent value="faqs"><FAQsTab isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="quiz"><QuizTab isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="career"><CareerTab isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} certificates={mine?.certificates ?? []} /></TabsContent>
        {isSupervisor && <TabsContent value="paths"><PathsAdminTab isAdmin={isAdmin} /></TabsContent>}
        {seesProgress && <TabsContent value="dashboard"><DashboardTab /></TabsContent>}
      </Tabs>
      <VideoPlayerDialog video={playVideo} done={playVideo ? done.has(`video:${playVideo.id}`) : false} onClose={() => setPlayVideo(null)} />
    </div>
  );
}
