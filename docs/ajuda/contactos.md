---
modulo: contactos
titulo: Contactos (pesquisa, diretório e Google Contactos)
rotas: /contactos, /perfil
palavras: importar contactos, importar csv, vcard, vcf, ordenar, nome a-z, com email, com telefone, filtrar contactos, palavras soltas, nome e apelido, crm vazio, diretório vazio, não foi possível ler, cartões, lista, ver em cartões, ver em lista, foto, contactos, contacto, pesquisa, procurar, cliente, lead, parceiro, fornecedor, colaborador, diretório, directorio, telefone, telemóvel, quem liga, identificação de chamadas, google contactos, people, grupo multipark, serviço, sugestões, criar cliente, criar lead
---
# Contactos

**Cartões ou Lista** (botão no topo da lista): vês as pessoas em **cartões com foto** ou numa **lista** compacta — no telemóvel e no PC. A escolha fica guardada neste aparelho, para esta página.

**Filtrar e ordenar por cima** (em todos os tipos, como nos Clientes)
- **Ordenar**: Mais recentes (a ordem normal de cada tipo), **Nome A–Z** ou **Nome Z–A**. Na **lista**, carregar no cabeçalho **Nome** faz o mesmo (A–Z → Z–A → ordem normal).
- **Com email** / **Com telefone**: só os contactos que o têm.
- Filtros e ordem valem para a lista **toda** (não só para o que já carregou).
- Na lista, cada contacto mostra numa linha o nome, o tipo, o detalhe (empresa, cargo, reservas…), o email e o telefone.

**Importar contactos** (quem pode editar os Clientes)
1. **Pesquisa → Importar contactos** e escolhe o ficheiro: CSV exportado do **Google Contactos** ou do **Outlook**, um CSV/Excel com as colunas **nome, email, telefone, empresa** (vírgula ou ponto e vírgula), ou um **vCard (.vcf)**. Até 2000 de cada vez.
2. Vês quantos contactos tem e os primeiros. Escolhe se entram como **Cliente (CRM)** ou **Lead comercial** e carrega em **Importar**.
3. Ficam nos **Contactos do CRM**, na tua cidade. Um contacto com o mesmo **email ou telefone** de outro que já existe **não entra e não mexe no que existe**. As linhas sem email e sem telefone ficam de fora. No fim dizes quantos entraram, quantos já existiam e quantos ficaram de fora. A importação fica nos Logs.

Uma só pesquisa para clientes, contactos do CRM, leads de extras, parceiros, fornecedores, colaboradores, o diretório da empresa e os teus contactos Google.

**Pesquisa** (menu **Suporte → Contactos**)
1. Escreve pelo menos 2 letras (nome, email, telefone ou matrícula). Aparecem os primeiros resultados de cada tipo.
   - As palavras procuram-se **soltas e por qualquer ordem**: "joao silva" encontra "João Pedro Silva" e "Silva, João".
2. Carrega num tipo (ex.: **Cliente**, **Parceiro**) ou em **Ver todos** para percorrer só esse tipo — a lista vai carregando à medida que desces.
3. Só aparecem os tipos dos módulos que vês (ex.: fornecedores só com as Despesas da cidade) e só na tua cidade. O telefone encontra-se escrito de qualquer forma (+351, 00351, com espaços).
4. Abre um contacto para ver as **reservas**, **reclamações**, **WhatsApp** e **emails** ligados (pelo email ou pelo telefone) e as comunicações do cliente.
5. **Quando um tipo vem vazio**, a página diz porquê:
   - **"Não foi possível ler esta lista agora"** (a vermelho): a leitura falhou. Não quer dizer que não haja ninguém; tenta de novo daqui a pouco. Os outros tipos estão completos.
   - **Contacto CRM** vazio: ainda não há contactos comerciais (leads B2B). Os clientes das reservas estão no tipo **Cliente**.
   - **Diretório** vazio: o diretório da empresa não está ligado (Definições → Comunicação → Contactos Google) ou ainda não foi lido do Google (**Atualizar agora**).
6. **Clientes** são as fichas do CRM (com o n.º de cliente): quem vê os Contactos vê o nome, o email e o telefone para poder ligar ao cliente. As reservas da ficha só aparecem a quem vê Clientes ou as Reservas, e só as das tuas cidades. Procura também pelo n.º de cliente ou pela matrícula.

**Diretório**
- Pessoas do Google Workspace da empresa: foto, cargo, departamento, telefone e email. É atualizado uma vez por dia.
- A foto e o cargo aparecem também nas listas de **Utilizadores** e de **RH**.
- Admins: **Atualizar agora** lê o diretório sem esperar.

**Os meus contactos Google** (separador **Meus Google**)
1. No **Perfil → Google Contactos** carrega em **Ativar Contactos** (autoriza só os Contactos; o resto que já autorizaste mantém-se).
2. Com **Sugestões** ligado, os teus contactos Google (os teus e os "Outros contactos") são comparados com clientes, leads, parceiros e colaboradores. Só tu os vês.
3. Um contacto sem correspondência pode virar **Cliente**, **Lead comercial** ou **Lead de extra** num clique (se tiveres permissão para editar esse módulo).
4. Desligar as sugestões apaga o que a app tinha lido.

**Grupo "Multipark — Serviço" no telemóvel** (só supervisor ou acima: supervisor, admin e super admin por omissão)
- Com os Contactos ativos, a app mantém no teu Google Contactos um grupo com os clientes das recolhas e entregas de **hoje e amanhã** (nome e matrícula), para veres quem te liga.
- Os serviços do teu turno confirmado (uma hora antes e depois) e os da(s) tua(s) cidade(s) de base, o dia inteiro.
- **O condutor nunca recebe este grupo** (nem o team leader): os dados dos clientes só vão para o telemóvel de supervisor ou acima. O servidor bloqueia-o mesmo que alguém tente escolher esses papéis.
- Os contactos são apagados automaticamente alguns dias depois do serviço (2 por omissão). A app só apaga contactos que ela própria criou — os teus nunca são tocados, mesmo com o mesmo número.
- Podes desligar o grupo no Perfil; ao desligar, os contactos criados pela app são apagados.
- Opcional (backoffice/admin): grupo **"Multipark — Parceiros e fornecedores"** com os parceiros ativos.

**Configuração** (super admin, **Definições → Comunicação → Contactos Google**)
- Diretório: ligar e indicar a conta do Workspace a usar (ex.: um administrador).
- Grupo "Serviço": papéis (só supervisor ou acima — condutor e team leader aparecem desativados), dias de retenção e máximo de contactos por pessoa.
- Grupo de parceiros: ligar e escolher os papéis.
