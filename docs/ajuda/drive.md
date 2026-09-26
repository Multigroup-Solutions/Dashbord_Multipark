---
modulo: drive
titulo: Google Drive, Docs e Sheets
rotas: /perfil
palavras: drive, google drive, docs, google docs, sheets, google sheets, folha, folha de cálculo, anexar do drive, guardar no drive, exportar para sheets, importar do sheets, modelo, modelos, gerar documento, marcadores, placeholders, shared drive, drive partilhado, pasta multipark, picker, escolher do drive, relatórios ao vivo, espelho, multipark direção, leitura de folhas, rh
---
# Google Drive, Docs e Sheets

Liga ficheiros do Google Drive aos registos, guarda anexos e documentos no teu Drive, gera documentos a partir de modelos Google Docs e exporta relatórios para o Google Sheets.

**Ativar o Drive** (cada pessoa, no **Perfil → Google Drive**)
1. Liga primeiro a tua conta Google (Perfil → Google).
2. Carrega em **Ativar Drive**. A app pede o acesso aos ficheiros que ela própria cria (pasta **"Multipark"** no teu Drive) ou que escolhes com ela e a **leitura de folhas Google** (só leitura, para importar de qualquer folha que consegues abrir) — nunca vê o resto do teu Drive nem os teus documentos. O que já autorizaste (email, calendário…) mantém-se.
3. Se ativaste o Drive antes de 26 set 2026, aparece **Autorizar leitura de folhas** no Perfil: carrega para poderes importar de qualquer link de folha.

**Anexar do Drive** (clientes, reclamações, conversas de email, fichas do RH, tarefas e parcerias)
1. Abre o registo e, em **Google Drive**, carrega em **Anexar do Drive**.
2. Carrega em **Escolher do Drive** (se estiver disponível) ou cola o link de partilha do ficheiro (Drive, Docs, Sheets ou Slides).
3. Fica guardada só a referência (nome, tipo, link e dono). Quem abre o link precisa de ter acesso ao ficheiro no próprio Google Drive.
4. Vês e ligas ficheiros só nos registos que já podes ver/editar na app (na tua cidade). No RH, só quem já vê os documentos da ficha.
5. **Remover** tira a ligação; o ficheiro continua no Drive.

**Guardar no Drive**
- Nos anexos dos emails e nas fotos/provas das reclamações há o botão **Guardar no meu Drive** (ícone do Drive). O ficheiro vai para a tua pasta "Multipark" e fica ligado ao registo.
- **Os documentos do RH nunca vão para o Google Drive** (nem o teu, nem o Shared Drive): ficam só nos documentos da ficha, na app.

**Gerar documento** (contrato de trabalho, declaração, resposta a reclamação, propostas)
1. Na ficha do colaborador (RH → Documentos), na reclamação (separador Comunicações), no cliente ou na parceria (ícone do Drive), carrega em **Gerar documento**.
2. Reclamação, cliente e parceria: escolhe o modelo e onde guardar — **Shared Drive da empresa** (pasta do registo: Clientes/nome, Reclamações/ano/n.º, Parcerias/nome) ou **O meu Drive**. Com **Criar também o PDF**, o PDF fica ao lado do documento e ligado ao registo.
3. **Colaborador (RH)**: escolhe só o modelo. A app cria o **PDF** e guarda-o nos **documentos da ficha** (contrato ou "outro"); a cópia de trabalho no Google é apagada logo a seguir — nada fica no Drive.
4. Os marcadores {{…}} do modelo são substituídos pelos dados do registo. O ordenado só é preenchido para quem vê os ordenados.

**Exportar para Sheets** (Faturação, Financeiro, Clientes, Avaliação individual, Métricas dos extras)
- O botão **Exportar para Sheets** cria uma folha nova na tua pasta "Multipark" com os mesmos números da página (e as mesmas permissões e cidades). Só aparece a quem pode exportar esse relatório.
- Relatórios muito grandes podem ficar incompletos (aviso "incompleta").

**Importar do Google Sheets** (Importar extras no RH; histórico financeiro no Anual)
1. Carrega em **Importar do Google Sheets** e escolhe a folha ou cola o link de **qualquer folha que consegues abrir** no Google (precisa da leitura de folhas autorizada — ver "Ativar o Drive"; sem ela, só folhas escolhidas com "Escolher do Drive").
2. O primeiro separador é lido e aparece no quadro da importação, com as mesmas regras de sempre — confirma antes de importar.

**Configuração** (Definições → Comunicação → Google Drive)
- Super admin: Shared Drive da empresa (conta do Workspace membro do Shared Drive e nome) e cópia automática das provas das reclamações. Os documentos do RH nunca são copiados.
- Só super admin: **Relatórios ao vivo** (folha atualizada 1×/dia com as permissões do super admin que gravou). Vão para um **Shared Drive restrito próprio** (ex.: **"Multipark Direção"**) — cria-o no Google, junta a conta do Workspace acima como Gestor de conteúdo e escolhe tu os membros. Sem esse Shared Drive (ou com o mesmo nome do geral) ficam desligados. Os admins não veem a configuração nem o link da folha.
- Admin e super admin: **Modelos de documentos** — regista um Google Doc (guardado no Shared Drive) com o tipo; **Ler marcadores** mostra os {{marcadores}} encontrados (verde = a app preenche; laranja = fica como está).
- Âmbitos pedidos: cada pessoa `drive.file` e `https://www.googleapis.com/auth/spreadsheets.readonly` (importar de qualquer folha); a conta de serviço (delegação) `drive` e `documents`.
- **Ecrã de consentimento OAuth** (Google Cloud → APIs e serviços → Ecrã de consentimento → Âmbitos): acrescenta `https://www.googleapis.com/auth/spreadsheets.readonly` aos âmbitos da app (a par de `drive.file`), e ativa a **Google Sheets API** no projeto.
