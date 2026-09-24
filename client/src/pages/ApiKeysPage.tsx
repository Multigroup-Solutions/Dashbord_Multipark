import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Key, Plus, Trash2, Copy, BookOpen, Shield, Zap, Radio, Truck, Users, AlertTriangle } from "lucide-react";
import { useState } from "react";

// Scopes disponíveis ao criar uma chave. O campo permissions é lido pela API /api/v1.
const SCOPES = [
  { value: "admin", label: "Controlo total (admin)", desc: "Tudo, incluindo apagar. Para o MCP do Claude.", perms: ["admin"] },
  { value: "write", label: "Leitura + escrita", desc: "Criar/editar reclamações e reviews, disparar syncs. Não apaga.", perms: ["read", "write"] },
  { value: "read", label: "Só leitura", desc: "Apenas consultar dados (reservas, reclamações, stats…).", perms: ["read"] },
  { value: "device", label: "Dispositivos (GPS / rádio)", desc: "Para /api/external (Zello, rádios). Sem acesso à /api/v1.", perms: ["device"] },
] as const;

// Validade opcional (dias). "0" = sem expiração.
const EXPIRY_OPTIONS = [
  { value: "0", label: "Sem expiração" },
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "365", label: "1 ano" },
];

function scopeLabel(permissions: string | null | undefined): string {
  let list: string[] = [];
  try { const p = JSON.parse(permissions ?? "[]"); list = Array.isArray(p) ? p.map(String) : [String(p)]; }
  catch { list = String(permissions ?? "").split(/[,\s]+/).filter(Boolean); }
  if (list.length === 0 || list.includes("device")) return "Dispositivos";
  if (list.includes("admin") || list.includes("*")) return "Admin";
  if (list.includes("write")) return "Leitura + escrita";
  if (list.includes("read")) return "Só leitura";
  return list.join(", ");
}

export default function ApiKeysPage() {
  const { user } = useAuth();
  const [newKeyName, setNewKeyName] = useState("");
  const [scope, setScope] = useState<string>("read");
  const [expiry, setExpiry] = useState("0");
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const keysQuery = trpc.apiKeys.list.useQuery(undefined, {
    enabled: user?.role === "super_admin",
  });
  const createMut = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      setNewKey(data.key);
      setNewKeyName("");
      keysQuery.refetch();
      toast.success("API Key criada!");
    },
  });
  const toggleMut = trpc.apiKeys.toggle.useMutation({
    onSuccess: () => { keysQuery.refetch(); toast.success("Estado atualizado"); },
  });
  const deleteMut = trpc.apiKeys.delete.useMutation({
    onSuccess: () => { keysQuery.refetch(); toast.success("API Key eliminada"); },
  });

  if (user?.role !== "super_admin") {
    return (
      <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Acesso restrito ao Super Admin.</p>
        </div>
    );
  }

  const baseUrl = window.location.origin;

  return (
    <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-muted-foreground">Gere as chaves de API para integração com dispositivos externos (GPS Zilo, rádios, etc.)</p>
          </div>
        </div>

        <Tabs defaultValue="keys">
          <TabsList>
            <TabsTrigger value="keys"><Key className="h-4 w-4 mr-1" /> Chaves</TabsTrigger>
            <TabsTrigger value="docs"><BookOpen className="h-4 w-4 mr-1" /> Documentação API</TabsTrigger>
          </TabsList>

          {/* ─── KEYS TAB ─── */}
          <TabsContent value="keys" className="space-y-4">
            <div className="flex gap-2">
              <Dialog open={showCreate} onOpenChange={(o) => { setShowCreate(o); if (!o) setNewKey(null); }}>
                <DialogTrigger asChild>
                  <Button><Plus className="h-4 w-4 mr-1" /> Nova API Key</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Criar API Key</DialogTitle>
                  </DialogHeader>
                  {newKey ? (
                    <div className="space-y-4">
                      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
                        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-2">Chave criada com sucesso! Copia-a agora — não será mostrada novamente (só guardamos o hash).</p>
                        <div className="flex gap-2">
                          <code className="flex-1 bg-background p-2 rounded text-xs break-all border">{newKey}</code>
                          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(newKey); toast.success("Copiado!"); }}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <Button className="w-full" onClick={() => { setShowCreate(false); setNewKey(null); }}>Fechar</Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <Label>Nome da chave</Label>
                        <Input placeholder="Ex: Claude MCP" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
                      </div>
                      <div>
                        <Label>Permissões (scope)</Label>
                        <div className="grid gap-2 mt-1">
                          {SCOPES.map((s) => (
                            <button
                              key={s.value}
                              type="button"
                              onClick={() => setScope(s.value)}
                              className={`text-left rounded-lg border p-3 transition ${scope === s.value ? "border-primary ring-1 ring-primary bg-primary/5" : "border-input hover:bg-accent"}`}
                            >
                              <p className="text-sm font-medium flex items-center gap-2">
                                {s.value === "admin" && <Shield className="h-4 w-4 text-amber-500" />}
                                {s.label}
                              </p>
                              <p className="text-xs text-muted-foreground">{s.desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label>Validade</Label>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {EXPIRY_OPTIONS.map((o) => (
                            <Button key={o.value} type="button" size="sm" variant={expiry === o.value ? "default" : "outline"} onClick={() => setExpiry(o.value)}>
                              {o.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <Button
                        className="w-full"
                        disabled={!newKeyName.trim() || createMut.isPending}
                        onClick={() => {
                          const perms = [...(SCOPES.find((s) => s.value === scope)?.perms ?? ["read"])];
                          const days = Number(expiry);
                          createMut.mutate({ name: newKeyName, permissions: perms, expiresInDays: days > 0 ? days : undefined });
                        }}
                      >
                        {createMut.isPending ? "A criar..." : "Criar API Key"}
                      </Button>
                    </div>
                  )}
                </DialogContent>
              </Dialog>
            </div>

            {keysQuery.data?.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Key className="h-12 w-12 mb-4 opacity-30" />
                  <p>Ainda não tens API keys. Cria uma para integrar dispositivos externos.</p>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-3">
              {keysQuery.data?.map((k: any) => {
                const expired = !!k.expiresAt && new Date(`${String(k.expiresAt).replace(" ", "T")}Z`).getTime() <= Date.now();
                return (
                <Card key={k.id}>
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${k.active && !expired ? "bg-emerald-500/15" : "bg-muted"}`}>
                        <Key className={`h-5 w-5 ${k.active && !expired ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`} />
                      </div>
                      <div>
                        <p className="font-medium">{k.name} <span className="text-xs font-normal text-muted-foreground">· {scopeLabel(k.permissions)}</span></p>
                        <p className="text-xs text-muted-foreground">
                          Criada: {fmtPTDate(k.createdAt)}
                          {" · "}Último uso: {k.lastUsedAt ? fmtPTDateTime(k.lastUsedAt) : "nunca"}
                          {" · "}{k.expiresAt ? `${expired ? "Expirou" : "Expira"}: ${fmtPTDate(k.expiresAt)}` : "Sem expiração"}
                        </p>
                        <code className="text-xs text-muted-foreground">{k.keyPrefix ? `${k.keyPrefix}••••••••` : "••••••••"}</code>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {expired && <Badge variant="destructive">Expirada</Badge>}
                      <Badge variant={k.active ? "default" : "secondary"}>{k.active ? "Ativa" : "Inativa"}</Badge>
                      <Switch checked={k.active} onCheckedChange={(v) => toggleMut.mutate({ id: k.id, active: v })} />
                      <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-700" onClick={() => { if (confirm("Eliminar esta API key?")) deleteMut.mutate({ id: k.id }); }}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                );
              })}
            </div>
          </TabsContent>

          {/* ─── DOCS TAB ─── */}
          <TabsContent value="docs" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5 text-amber-500" /> Autenticação</CardTitle>
                <CardDescription>Todas as chamadas requerem o header X-API-Key</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`curl -H "X-API-Key: mp_xxxxxxxxxx" \\
  ${baseUrl}/api/external/vehicles`}</pre>
              </CardContent>
            </Card>

            {/* Speed Alert */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-red-500" /> POST /api/external/speed-alert</CardTitle>
                <CardDescription>Registar alerta de velocidade (ex: GPS Zilo). Notifica automaticamente o Super Admin.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm font-medium mb-1">Body (JSON):</p>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`{
  "plate": "AA-00-BB",        // ou "vehicleId": 1
  "speed": 85,                // km/h registados
  "speedLimit": 50,           // limite da via
  "latitude": "38.7223",      // opcional
  "longitude": "-9.1393",     // opcional
  "roadName": "Av. da Liberdade",  // opcional
  "employeeId": 3             // opcional
}`}</pre>
                </div>
                <div>
                  <p className="text-sm font-medium mb-1">Exemplo cURL:</p>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`curl -X POST ${baseUrl}/api/external/speed-alert \\
  -H "X-API-Key: mp_xxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"plate":"AA-00-BB","speed":85,"speedLimit":50,"roadName":"IC19"}'`}</pre>
                </div>
              </CardContent>
            </Card>

            {/* Vehicle Movement */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Truck className="h-5 w-5 text-blue-500" /> POST /api/external/vehicle-movement</CardTitle>
                <CardDescription>Registar recolha ou devolução de viatura.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm font-medium mb-1">Body (JSON):</p>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`{
  "plate": "AA-00-BB",        // ou "vehicleId": 1
  "employeeId": 3,            // obrigatório
  "type": "pickup",           // "pickup" ou "return"
  "kmReading": 45230,         // opcional
  "latitude": "38.7223",      // opcional
  "longitude": "-9.1393",     // opcional
  "notes": "Pneu traseiro baixo"  // opcional
}`}</pre>
                </div>
                <div>
                  <p className="text-sm font-medium mb-1">Exemplo cURL:</p>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`curl -X POST ${baseUrl}/api/external/vehicle-movement \\
  -H "X-API-Key: mp_xxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"plate":"AA-00-BB","employeeId":3,"type":"pickup","kmReading":45230}'`}</pre>
                </div>
              </CardContent>
            </Card>

            {/* Radio Upload */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Radio className="h-5 w-5 text-purple-500" /> POST /api/external/radio-upload</CardTitle>
                <CardDescription>Enviar áudio de rádio para transcrição automática via Whisper + resumo IA.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm font-medium mb-1">Body (JSON):</p>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`{
  "audioUrl": "https://storage.example.com/radio/clip.mp3",  // obrigatório
  "employeeId": 3,    // opcional
  "vehicleId": 1,     // opcional
  "duration": 45      // segundos, opcional
}`}</pre>
                </div>
                <div>
                  <p className="text-sm font-medium mb-1">Resposta:</p>
                  <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`{
  "success": true,
  "id": 1,
  "transcription": "Texto completo da transcrição...",
  "summary": "Resumo gerado pela IA..."
}`}</pre>
                </div>
              </CardContent>
            </Card>

            {/* List endpoints */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5 text-green-500" /> GET /api/external/vehicles & /employees</CardTitle>
                <CardDescription>Listar viaturas e colaboradores para integração.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`# Listar viaturas
curl -H "X-API-Key: mp_xxxxxxxxxx" ${baseUrl}/api/external/vehicles

# Listar colaboradores
curl -H "X-API-Key: mp_xxxxxxxxxx" ${baseUrl}/api/external/employees

# Documentação completa (JSON)
curl -H "X-API-Key: mp_xxxxxxxxxx" ${baseUrl}/api/external/docs`}</pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-amber-500" /> Integração Zilo GPS</CardTitle>
                <CardDescription>Como configurar o GPS Zilo para enviar dados automaticamente.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>1. No painel Zilo, vai a <strong>Configurações → Webhooks</strong></p>
                <p>2. Adiciona um novo webhook com o URL: <code className="bg-slate-100 px-1 rounded">{baseUrl}/api/external/speed-alert</code></p>
                <p>3. Configura o header: <code className="bg-slate-100 px-1 rounded">X-API-Key: [a tua chave]</code></p>
                <p>4. Mapeia os campos: <code>plate</code>, <code>speed</code>, <code>speedLimit</code>, <code>latitude</code>, <code>longitude</code></p>
                <p>5. Ativa o webhook e testa com um envio manual.</p>
              </CardContent>
            </Card>

            {/* MCP / API de controlo */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5 text-indigo-500" /> API de controlo /api/v1 (MCP)</CardTitle>
                <CardDescription>Controlar a dashboard a partir do Claude (todos os parques/cidades). O que a chave pode fazer depende do scope escolhido na criação.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>1. Cria uma chave acima com o scope <strong>Controlo total (admin)</strong> e copia-a.</p>
                <p>2. Na pasta <code className="bg-slate-100 px-1 rounded">mcp-server/</code> do repositório: <code className="bg-slate-100 px-1 rounded">npm install</code></p>
                <p>3. Regista o MCP no Claude com as variáveis:</p>
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-xs overflow-x-auto">{`MULTIPARK_API_URL=${baseUrl}/api/v1
MULTIPARK_API_KEY=a-tua-chave`}</pre>
                <p>Ver instruções completas em <code className="bg-slate-100 px-1 rounded">mcp-server/README.md</code>. Testar a chave:</p>
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-xs overflow-x-auto">{`curl -H "X-API-Key: a-tua-chave" ${baseUrl}/api/v1/`}</pre>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
  );
}
