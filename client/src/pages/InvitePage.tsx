import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, Mail, ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function InvitePage() {
  const [, params] = useRoute("/convite/:token");
  const token = params?.token ?? "";
  const { user, loading: authLoading } = useAuth();
  const [completed, setCompleted] = useState(false);

  const { data: inviteInfo, isLoading } = trpc.users.acceptInvite.useQuery(
    { token },
    { enabled: !!token }
  );

  const completeMutation = trpc.users.completeInvite.useMutation({
    onSuccess: () => {
      setCompleted(true);
      toast.success("Conta ativada com sucesso!");
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
            <p className="text-muted-foreground">A verificar convite...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!inviteInfo?.valid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12">
            <XCircle className="h-12 w-12 text-destructive mb-4" />
            <h2 className="text-lg font-semibold mb-2">Convite Inválido</h2>
            <p className="text-muted-foreground text-center">
              {inviteInfo?.reason ?? "Este link de convite não é válido."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12">
            <CheckCircle2 className="h-12 w-12 text-green-600 mb-4" />
            <h2 className="text-lg font-semibold mb-2">Conta Ativada!</h2>
            <p className="text-muted-foreground text-center mb-6">
              A tua conta foi ativada com sucesso. Já podes aceder à plataforma.
            </p>
            <Button onClick={() => window.location.href = "/"}>
              Ir para o Dashboard
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // User is not logged in — show login prompt
  if (!user) {
    const loginUrl = getLoginUrl();
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>Convite para Dashboard Multipark</CardTitle>
            <CardDescription>
              Foste convidado para a plataforma Dashboard Multipark com o email <strong className="break-all">{inviteInfo.email}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground text-center">
              Para ativar a tua conta, faz login ou cria uma conta primeiro.
            </p>
            <Button asChild className="w-full">
              <a href={loginUrl}>
                Fazer Login / Criar Conta
                <ArrowRight className="h-4 w-4 ml-2" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // User is logged in — show activate button
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-green-500/10 flex items-center justify-center">
            <CheckCircle2 className="h-6 w-6 text-green-500" />
          </div>
          <CardTitle>Ativar Conta</CardTitle>
          <CardDescription>
            Estás autenticado como <strong className="break-words">{user.name ?? user.email}</strong>. Clica abaixo para ativar a tua conta na plataforma.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <Button
            className="w-full"
            onClick={() => completeMutation.mutate({ token })}
            disabled={completeMutation.isPending}
          >
            {completeMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Ativar Minha Conta
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
