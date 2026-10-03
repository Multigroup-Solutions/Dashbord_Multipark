import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { fmtPTDate, fmtPTDateTime } from "@/lib/lisbonTime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { toast } from "sonner";
import { Key, Plus, Ban, Copy, BookOpen, Shield, Zap, Radio, Truck, Users, AlertTriangle, Pencil, Mail } from "lucide-react";
import { useState } from "react";
import { can } from "@shared/access";
import {
  API_KEY_CAPABILITIES, API_KEY_CAPABILITY_INFO, normalizeCapabilities, type ApiKeyCapability,
} from "@shared/apiKeyCapabilities";

// Validade opcional (dias). "0" = sem expiração. Acaba no fim do dia (Lisboa).
const EXPIRY_OPTIONS = [
  { value: "0", label: "Sem expiração" },
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "365", label: "1 ano" },
];

const isExpired = (expiresAt: string | null | undefined) =>
  !!expiresAt && new Date(`${String(expiresAt).replace(" ", "T")}Z`).getTime() <= Date.now();

/** Caixas das capacidades. "Administração" marca tudo (as outras ficam incluídas). */
function CapabilityPicker({ value, onChange, idPrefix }: {
  value: ApiKeyCapability[];
  onChange: (next: ApiKeyCapability[]) => void;
  idPrefix: string;
}) {
  const admin = value.includes("admin");
  const toggle = (c: ApiKeyCapability, on: boolean) => {
    const set = new Set(value);
    if (on) set.add(c); else set.delete(c);
    onChange(normalizeCapabilities(Array.from(set)));
  };
  return (
    <div className="grid gap-2 mt-1">
      {API_KEY_CAPABILITIES.map((c) => {
        const info = API_KEY_CAPABILITY_INFO[c];
        const checked = admin || value.includes(c);
        const disabled = admin && c !== "admin";
        return (
          <label
            key={c}
            htmlFor={`${idPrefix}-${c}`}
            className={`flex items-start gap-3 rounded-lg border p-3 ${checked ? "border-primary/60 bg-primary/5" : "border-input"} ${disabled ? "opacity-70" : "cursor-pointer hover:bg-accent"}`}
          >
            <Checkbox id={`${idPrefix}-${c}`} checked={checked} disabled={disabled} onCheckedChange={(v) => toggle(c, v === true)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="text-sm font-medium flex items-center gap-1.5">
                {c === "admin" && <Shield className="h-4 w-4 text-amber-500" aria-hidden />}
                {info.label}
              </span>
              <span className="block text-xs text-muted-foreground">{info.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function CapabilityBadges({ caps }: { caps: ApiKeyCapability[] }) {
  if (caps.includes("admin")) return <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-300">{API_KEY_CAPABILITY_INFO.admin.label}</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {caps.map((c) => <Badge key={c} variant="outline" className="font-normal">{API_KEY_CAPABILITY_INFO[c].label}</Badge>)}
    </span>
  );
}

export default function ApiKeysPage() {
  const { user } = useAuth();
  const allowed = can(user as any, "api_keys", "manage");
  const [newKeyName, setNewKeyName] = useState("");
  const [newCaps, setNewCaps] = useState<ApiKeyCapability[]>([]);
  const [expiry, setExpiry] = useState("0");
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string; caps: ApiKeyCapability[]; legacy: boolean } | null>(null);
  const [revoking, setRevoking] = useState<{ id: number; name: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const keysQuery = trpc.apiKeys.list.useQuery({ includeRevoked: showRevoked }, { enabled: allowed });
  const onErr = (what: string) => (e: { message: string }) => toast.error(`${what}: ${e.message}`);
  const createMut = trpc.apiKeys.create.useMutation({
    onSuccess: (data) => {
      setNewKey(data.key);
      setNewKeyName("");
      setNewCaps([]);
      keysQuery.refetch();
      toast.success("API key criada!");
    },
    onError: onErr("Não foi possível criar a chave"),
  });
  const toggleMut = trpc.apiKeys.toggle.useMutation({
    onSuccess: () => { keysQuery.refetch(); toast.success("Estado atualizado"); },
    onError: (e) => { keysQuery.refetch(); onErr("Não foi possível mudar o estado")(e); },
  });
  const capsMut = trpc.apiKeys.setCapabilities.useMutation({
    onSuccess: () => { keysQuery.refetch(); setEditing(null); toast.success("Capacidades gravadas"); },
    onError: onErr("Não foi possível gravar"),
  });
  const revokeMut = trpc.apiKeys.revoke.useMutation({
    onSuccess: (r) => {
      keysQuery.refetch();
      setRevoking(null);
      setRevokeReason("");
      toast.success(r.alreadyRevoked ? "Já estava revogada" : "API key revogada — deixa de funcionar já");
    },
    onError: onErr("Não foi possível revogar"),
  });

  if (!allowed) {
    return (
      <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Acesso restrito ao Super Admin.</p>
        </div>
    );
  }

  const baseUrl = window.location.origin;
  const keys = keysQuery.data ?? [];

  return (
    <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-muted-foreground">Chaves para o site, o MCP do Claude, relatórios e dispositivos (GPS, rádios). Cada chave só faz o que marcares.</p>
          </div>
        </div>

        <Tabs defaultValue="keys">
          <TabsList>
            <TabsTrigger value="keys"><Key className="h-4 w-4 mr-1" /> Chaves</TabsTrigger>
            <TabsTrigger value="docs"><BookOpen className="h-4 w-4 mr-1" /> Documentação API</TabsTrigger>
          </TabsList>

          {/* ─── KEYS TAB ─── */}
          <TabsContent value="keys" className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Dialog open={showCreate} onOpenChange={(o) => { setShowCreate(o); if (!o) setNewKey(null); }}>
                <DialogTrigger asChild>
                  <Button><Plus className="h-4 w-4 mr-1" /> Nova API Key</Button>
                </DialogTrigger>
                <DialogContent className="max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Criar API Key</DialogTitle>
                  </DialogHeader>
                  {newKey ? (
                    <div className="space-y-4">
                      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
                        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300 mb-2">Chave criada! Copia-a agora — não volta a aparecer (só guardamos o hash).</p>
                        <div className="flex gap-2">
                          <code className="flex-1 min-w-0 bg-background p-2 rounded text-xs break-all border">{newKey}</code>
                          <Button size="sm" variant="outline" aria-label="Copiar a chave" onClick={() => { navigator.clipboard.writeText(newKey).then(() => toast.success("Copiado!"), () => toast.error("Não foi possível copiar — seleciona e copia à mão.")); }}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <Button className="w-full" onClick={() => { setShowCreate(false); setNewKey(null); }}>Fechar</Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="new-key-name">Nome da chave</Label>
                        <Input id="new-key-name" placeholder="Ex: Site multidriver" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
                      </div>
                      <div>
                        <Label>O que esta chave pode fazer</Label>
                        <p className="text-xs text-muted-foreground">Marca só o necessário. Para o MCP de relatórios chega "Relatórios", "Caixa" e "Marketing".</p>
                        <CapabilityPicker value={newCaps} onChange={setNewCaps} idPrefix="new" />
                      </div>
                      <div>
                        <Label>Validade</Label>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {EXPIRY_OPTIONS.map((o) => (
                            <Button key={o.value} type="button" size="sm" variant={expiry === o.value ? "selected" : "outline"} onClick={() => setExpiry(o.value)}>
                              {o.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <Button
                        className="w-full"
                        disabled={!newKeyName.trim() || newCaps.length === 0 || createMut.isPending}
                        onClick={() => {
                          const days = Number(expiry);
                          createMut.mutate({ name: newKeyName, capabilities: newCaps, expiresInDays: days > 0 ? days : undefined });
                        }}
                      >
                        {createMut.isPending ? "A criar..." : newCaps.length === 0 ? "Escolhe pelo menos uma capacidade" : "Criar API Key"}
                      </Button>
                    </div>
                  )}
                </DialogContent>
              </Dialog>
              <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <Switch checked={showRevoked} onCheckedChange={setShowRevoked} aria-label="Mostrar revogadas" />
                Mostrar revogadas
              </label>
            </div>

            {keysQuery.error && (
              <QueryErrorNote error={keysQuery.error} onRetry={() => keysQuery.refetch()} retrying={keysQuery.isFetching} what="as API keys" />
            )}

            {!keysQuery.error && keysQuery.data && keys.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground text-center">
                  <Key className="h-12 w-12 mb-4 opacity-30" />
                  <p>Ainda não há API keys{showRevoked ? "" : " ativas"}. Cria uma para o site, o MCP ou um dispositivo.</p>
                </CardContent>
              </Card>
            )}

            <div className="grid gap-3">
              {keys.map((k) => {
                const expired = isExpired(k.expiresAt);
                const revoked = !!k.revokedAt;
                const working = !!k.active && !expired && !revoked;
                return (
                <Card key={k.id} className={revoked ? "opacity-70" : undefined}>
                  <CardContent className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-3 py-4">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className={`p-2 rounded-lg shrink-0 ${working ? "bg-emerald-500/15" : "bg-muted"}`}>
                        <Key className={`h-5 w-5 ${working ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`} />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium break-words">{k.name}</p>
                        <CapabilityBadges caps={k.capabilities} />
                        {k.legacy && !revoked && (
                          <p className="text-xs text-amber-700 dark:text-amber-300">Chave antiga: continua a fazer o que fazia. Em "Capacidades" podes reduzi-la ao que precisa.</p>
                        )}
                        <p className="text-xs text-muted-foreground break-words">
                          Criada: {fmtPTDate(k.createdAt)}
                          {" · "}Último uso: {k.lastUsedAt ? fmtPTDateTime(k.lastUsedAt) : "nunca"}
                          {" · "}{k.expiresAt ? `${expired ? "Expirou" : "Válida até"}: ${fmtPTDate(k.expiresAt)}` : "Sem expiração"}
                        </p>
                        {revoked && (
                          <p className="text-xs text-red-700 dark:text-red-300 break-words">Revogada em {fmtPTDateTime(k.revokedAt)}{k.revokeReason ? `: ${k.revokeReason}` : ""}</p>
                        )}
                        <code className="text-xs text-muted-foreground break-all">{k.keyPrefix ? `${k.keyPrefix}••••••••` : "••••••••"}</code>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:shrink-0 sm:ml-auto">
                      {revoked ? (
                        <Badge variant="destructive">Revogada</Badge>
                      ) : (
                        <>
                          {expired && <Badge variant="destructive">Expirada</Badge>}
                          <Badge variant={k.active ? "default" : "secondary"}>{k.active ? "Ativa" : "Inativa"}</Badge>
                          <Switch checked={!!k.active} disabled={toggleMut.isPending} onCheckedChange={(v) => toggleMut.mutate({ id: k.id, active: v })} aria-label={k.active ? `Desativar ${k.name}` : `Ativar ${k.name}`} />
                          <Button variant="outline" size="sm" onClick={() => setEditing({ id: k.id, name: k.name, caps: k.capabilities, legacy: k.legacy })}>
                            <Pencil className="h-3.5 w-3.5 mr-1" /> Capacidades
                          </Button>
                          <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" aria-label={`Revogar ${k.name}`} onClick={() => { setRevoking({ id: k.id, name: k.name }); setRevokeReason(""); }}>
                            <Ban className="h-4 w-4 mr-1" /> Revogar
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
                );
              })}
            </div>

            <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
              <DialogContent className="max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Capacidades de «{editing?.name}»</DialogTitle>
                  <DialogDescription>
                    {editing?.legacy
                      ? "Chave antiga: estão marcadas as capacidades que ela tem hoje. Desmarca o que não precisa — muda já, para quem a usa."
                      : "Muda já, para quem usa esta chave. Fica no registo (antes → depois)."}
                  </DialogDescription>
                </DialogHeader>
                {editing && (
                  <div className="space-y-4">
                    <CapabilityPicker value={editing.caps} onChange={(caps) => setEditing({ ...editing, caps })} idPrefix={`edit-${editing.id}`} />
                    <Button
                      className="w-full"
                      disabled={editing.caps.length === 0 || capsMut.isPending}
                      onClick={() => capsMut.mutate({ id: editing.id, capabilities: editing.caps })}
                    >
                      {capsMut.isPending ? "A gravar..." : editing.caps.length === 0 ? "Escolhe pelo menos uma capacidade" : "Gravar"}
                    </Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>

            <Dialog open={!!revoking} onOpenChange={(o) => { if (!o) setRevoking(null); }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Revogar «{revoking?.name}»?</DialogTitle>
                  <DialogDescription>A chave deixa de funcionar já e não se volta a ativar. Fica no registo quem revogou, quando e porquê.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="revoke-reason">Porquê?</Label>
                    <Input id="revoke-reason" placeholder="Ex: substituída por uma chave nova" value={revokeReason} maxLength={255} onChange={(e) => setRevokeReason(e.target.value)} />
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" onClick={() => setRevoking(null)}>Cancelar</Button>
                    <Button
                      variant="destructive"
                      disabled={revokeReason.trim().length < 3 || revokeMut.isPending}
                      onClick={() => revoking && revokeMut.mutate({ id: revoking.id, reason: revokeReason.trim() })}
                    >
                      {revokeMut.isPending ? "A revogar..." : "Revogar"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </TabsContent>

          {/* ─── DOCS TAB ─── */}
          <TabsContent value="docs" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5 text-amber-500" /> Autenticação</CardTitle>
                <CardDescription>Todas as chamadas levam o header X-API-Key. Cada rota pede uma capacidade da chave; sem ela a resposta é 403.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">{`curl -H "X-API-Key: mp_xxxxxxxxxx" \\
  ${baseUrl}/api/external/vehicles`}</pre>
                <p>Limite: 240 pedidos por minuto por chave (acima disso: 429 com Retry-After). Chave errada, desativada, revogada ou expirada: 403, sempre com a mesma mensagem.</p>
              </CardContent>
            </Card>

            {/* Speed Alert */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-red-500" /> POST /api/external/speed-alert</CardTitle>
                <CardDescription>Registar alerta de velocidade (ex: GPS Zilo). Avisa as chefias da cidade do condutor. Capacidade: Dispositivo.</CardDescription>
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
                <CardDescription>Registar recolha ou devolução de viatura. Capacidade: Dispositivo.</CardDescription>
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
                <CardDescription>Enviar áudio de rádio para transcrição e resumo com IA. O endereço tem de ser http(s) público. Capacidade: Dispositivo.</CardDescription>
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
                <CardDescription>Listar viaturas (Relatórios de operação ou Dispositivo) e colaboradores (Dados pessoais ou Dispositivo).</CardDescription>
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
                <p>2. Adiciona um novo webhook com o URL: <code className="bg-muted px-1 rounded break-all">{baseUrl}/api/external/speed-alert</code></p>
                <p>3. Configura o header: <code className="bg-muted px-1 rounded break-all">X-API-Key: [a tua chave]</code> (chave só com "Dispositivo")</p>
                <p>4. Mapeia os campos: <code>plate</code>, <code>speed</code>, <code>speedLimit</code>, <code>latitude</code>, <code>longitude</code></p>
                <p>5. Ativa o webhook e testa com um envio manual.</p>
              </CardContent>
            </Card>

            {/* Gmail import: descontinuado (23a, D18) — as críticas chegam pela sincronização do Gmail. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5 text-muted-foreground" /> POST /api/external/gmail-import <span className="text-xs font-normal text-muted-foreground">(descontinuado)</span></CardTitle>
                <CardDescription>Já não grava nada (responde 410): as críticas chegam pela sincronização do Gmail e as ocorrências vêm da app Multipark.</CardDescription>
              </CardHeader>
            </Card>

            {/* MCP / API de controlo */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5 text-indigo-500" /> API /api/v1 (site, MCP, relatórios)</CardTitle>
                <CardDescription>Cada rota pede uma capacidade: formulários do site, relatórios de operação, caixa, marketing, dados pessoais, reclamações (escrever) ou administração.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>1. Cria uma chave só com o que o MCP precisa (para relatórios: Relatórios de operação, Caixa e parceiros, Marketing). Não uses "Administração" num MCP.</p>
                <p>2. O servidor MCP é o ficheiro <code className="bg-muted px-1 rounded break-all">mcp-server/index.mjs</code> do repositório — precisa só do Node 18+, sem instalar nada.</p>
                <p>3. Regista o MCP no Claude com as variáveis:</p>
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-xs overflow-x-auto">{`MULTIPARK_API_URL=${baseUrl}/api/v1
MULTIPARK_API_KEY=a-tua-chave`}</pre>
                <p>Instruções completas em <code className="bg-muted px-1 rounded break-all">mcp-server/README.md</code>. Testar a chave (devolve as capacidades dela):</p>
                <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-xs overflow-x-auto">{`curl -H "X-API-Key: a-tua-chave" ${baseUrl}/api/v1/`}</pre>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
  );
}
