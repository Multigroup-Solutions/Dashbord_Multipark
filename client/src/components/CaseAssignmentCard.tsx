import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, Save, CheckCircle2 } from "lucide-react";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { lisbonDayOf } from "@shared/lisbonDay";

type SavePatch = { projectId: number | null; assigneeId: number | null; dueDate: string | null };

/**
 * Atribuição de um caso (reclamação ou perdido) a um GRUPO (projeto) e a uma
 * PESSOA (responsável), com PRAZO — como as Tasks. Mostra também a auditoria de
 * fecho (quando foi fechado). Reutilizável; cada página mapeia onSave para o seu
 * update (assignedToId vs assignedTo).
 */
export default function CaseAssignmentCard({
  projectId, assigneeId, dueDate, closedAt, closedByName,
  projects, people: eligible, onSave, saving, currentAssigneeName,
}: {
  projectId: number | null | undefined;
  assigneeId: number | null | undefined;
  dueDate: string | null | undefined;
  closedAt: string | null | undefined;
  closedByName?: string | null;
  projects: { id: number; name: string }[];
  people: { id: number; fullName: string }[];
  onSave: (patch: SavePatch) => void;
  saving?: boolean;
  /** Nome do responsável atual (para o mostrar se já não puder ser escolhido). */
  currentAssigneeName?: string | null;
}) {
  // Responsável só team leader ou acima (Jorge, 3 out 2026): `eligible` já vem
  // filtrado; um responsável antigo abaixo disso continua à vista, para se trocar.
  const people = assigneeId && !eligible.some((p) => p.id === assigneeId)
    ? [...eligible, { id: assigneeId, fullName: `${currentAssigneeName || `Ficha #${assigneeId}`} (abaixo de team leader — troca)` }]
    : eligible;
  const [proj, setProj] = useState<string>(projectId ? String(projectId) : "none");
  const [person, setPerson] = useState<string>(assigneeId ? String(assigneeId) : "none");
  const [due, setDue] = useState<string>(dueDate ? lisbonDayOf(String(dueDate)) : "");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-primary" /> Atribuição & prazo
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <Label className="text-xs">Grupo (centro de custos)</Label>
          <Select value={proj} onValueChange={setProj}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— Nenhum —</SelectItem>
              {projects.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Responsável (investiga) — team leader ou acima</Label>
          <Select value={person} onValueChange={setPerson}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— Ninguém —</SelectItem>
              {people.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.fullName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Prazo para resolver</Label>
          <Input type="date" value={due} onChange={e => setDue(e.target.value)} />
        </div>
        <Button size="sm" disabled={saving} onClick={() => onSave({
          projectId: proj === "none" ? null : parseInt(proj),
          assigneeId: person === "none" ? null : parseInt(person),
          // Fim do dia escolhido, em Lisboa (o servidor converte para UTC).
          dueDate: due ? due + "T23:59:59" : null,
        })}>
          <Save className="w-4 h-4 mr-1" /> Guardar
        </Button>

        {closedAt && (
          <p className="text-xs text-muted-foreground flex items-center gap-1 border-t pt-2">
            <CheckCircle2 className="w-3 h-3 text-green-500" />
            Fechado em {fmtPTDateTime(closedAt)}{closedByName ? ` por ${closedByName}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
