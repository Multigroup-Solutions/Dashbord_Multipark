// Página Sistema → Permissões.
//  - Por pessoa: acessos a CADA módulo da matriz (papel + overrides por
//    utilizador, pedido do dono 24 set 2026).
//  - Quem tem acesso: por módulo, quem o tem e porquê (papel ou override).
//  - Permissões especiais: o catálogo antigo (TL na escala, totais
//    financeiros, cidades extra), que continua a valer.
import { ShieldCheck } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ModuleAccessPanel from "./permissions/ModuleAccessPanel";
import WhoHasAccessPanel from "./permissions/WhoHasAccessPanel";
import LegacyPermissionsPanel from "./permissions/LegacyPermissionsPanel";

export default function PermissionsPage() {
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1200px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-primary" /> Permissões
        </h1>
        <p className="text-muted-foreground text-sm">
          O papel de cada conta dá um acesso por defeito a cada módulo. Aqui podes dar ou retirar acessos a uma pessoa em concreto, com validade opcional.
        </p>
      </div>
      <Tabs defaultValue="pessoa">
        <TabsList className="w-full sm:w-auto overflow-x-auto justify-start">
          <TabsTrigger value="pessoa">Por pessoa</TabsTrigger>
          <TabsTrigger value="modulo">Quem tem acesso</TabsTrigger>
          <TabsTrigger value="especiais">Permissões especiais</TabsTrigger>
        </TabsList>
        <TabsContent value="pessoa" className="mt-4"><ModuleAccessPanel /></TabsContent>
        <TabsContent value="modulo" className="mt-4"><WhoHasAccessPanel /></TabsContent>
        <TabsContent value="especiais" className="mt-4"><LegacyPermissionsPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
