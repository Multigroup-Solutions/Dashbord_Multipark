import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Home, MapPinOff } from "lucide-react";
import { useLocation } from "wouter";

// Página 404 no design system Multipark (fundo --background, cartão branco,
// azul primário, Poppins nos títulos) — antes usava um gradiente cinzento,
// vermelho e texto em inglês, fora do resto da app.
export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardContent className="p-6 sm:p-8 text-center space-y-4">
          <div className="mx-auto h-14 w-14 rounded-2xl bg-secondary flex items-center justify-center">
            <MapPinOff className="h-7 w-7 text-primary" aria-hidden />
          </div>
          <div className="space-y-1">
            <p className="font-display text-4xl font-bold text-foreground tabular-nums">404</p>
            <h1 className="text-xl font-semibold text-foreground">Página não encontrada</h1>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            O endereço que procuras não existe ou foi mudado de sítio.
          </p>
          <Button className="w-full sm:w-auto" onClick={() => setLocation("/")}>
            <Home className="w-4 h-4 mr-2" aria-hidden />
            Voltar ao início
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
