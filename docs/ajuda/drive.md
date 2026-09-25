---
modulo: drive
titulo: Google Drive, Docs e Sheets
rotas: /perfil
palavras: drive, google drive, docs, google docs, sheets, google sheets, folha, folha de cálculo, anexar do drive, guardar no drive, exportar para sheets, importar do sheets, modelo, modelos, gerar documento, marcadores, placeholders, shared drive, drive partilhado, pasta multipark, picker, escolher do drive, relatórios ao vivo, espelho
---
# Google Drive, Docs e Sheets

Liga ficheiros do Google Drive aos registos, guarda anexos e documentos no teu Drive, gera documentos a partir de modelos Google Docs e exporta relatórios para o Google Sheets.

**Ativar o Drive** (cada pessoa, no **Perfil → Google Drive**)
1. Liga primeiro a tua conta Google (Perfil → Google).
2. Carrega em **Ativar Drive**. A app pede só o acesso aos ficheiros que ela própria cria (pasta **"Multipark"** no teu Drive) ou que escolhes com ela — nunca vê o resto do teu Drive. O que já autorizaste (email, calendário…) mantém-se.

**Anexar do Drive** (clientes, reclamações, conversas de email, fichas do RH, tarefas e parcerias)
1. Abre o registo e, em **Google Drive**, carrega em **Anexar do Drive**.
2. Carrega em **Escolher do Drive** (se estiver disponível) ou cola o link de partilha do ficheiro (Drive, Docs, Sheets ou Slides).
3. Fica guardada só a referência (nome, tipo, link e dono). Quem abre o link precisa de ter acesso ao ficheiro no próprio Google Drive.
4. Vês e ligas ficheiros só nos registos que já podes ver/editar na app (na tua cidade). No RH, só quem já vê os documentos da ficha.
5. **Remover** tira a ligação; o ficheiro continua no Drive.

**Guardar no Drive**
- Nos anexos dos emails, nos documentos da ficha (RH) e nas fotos/provas das reclamações há o botão **Guardar no meu Drive** (ícone do Drive). O ficheiro vai para a tua pasta "Multipark" e fica ligado ao registo.

**Gerar documento** (contrato de trabalho, declaração, resposta a reclamação, propostas)
1. Na ficha do colaborador (RH → Documentos), na reclamação (separador Comunicações), no cliente ou na parceria (ícone do Drive), carrega em **Gerar documento**.
2. Escolhe o modelo e onde guardar: **Shared Drive da empresa** (pasta do registo: Clientes/nome, Reclamações/ano/n.º, RH/cidade/trabalhador, Parcerias/nome) ou **O meu Drive**.
3. Os marcadores {{…}} do modelo são substituídos pelos dados do registo. O ordenado só é preenchido para quem vê os ordenados.
4. Com **Criar também o PDF**, o PDF fica ao lado do documento e ligado ao registo; no RH entra também nos documentos da ficha (contrato ou "outro").

**Exportar para Sheets** (Faturação, Financeiro, Clientes, Avaliação individual, Métricas dos extras)
- O botão **Exportar para Sheets** cria uma folha nova na tua pasta "Multipark" com os mesmos números da página (e as mesmas permissões e cidades). Só aparece a quem pode exportar esse relatório.
- Relatórios muito grandes podem ficar incompletos (aviso "incompleta").

**Importar do Google Sheets** (Importar extras no RH; histórico financeiro no Anual)
1. Carrega em **Importar do Google Sheets** e escolhe a folha (ou cola o link de uma folha que a app já conheça).
2. O primeiro separador é lido e aparece no quadro da importação, com as mesmas regras de sempre — confirma antes de importar.

**Configuração** (Definições → Comunicação → Google Drive)
- Super admin: Shared Drive da empresa (conta do Workspace membro do Shared Drive e nome), Shared Drive só do RH (recomendado), cópia automática dos documentos do RH e das provas das reclamações, relatórios ao vivo (folha atualizada 1×/dia com as permissões de quem gravou; visível aos membros do Shared Drive).
- Admin e super admin: **Modelos de documentos** — regista um Google Doc (guardado no Shared Drive) com o tipo; **Ler marcadores** mostra os {{marcadores}} encontrados (verde = a app preenche; laranja = fica como está).
- Âmbitos pedidos: cada pessoa só `drive.file`; a conta de serviço (delegação) `drive` e `documents`.
