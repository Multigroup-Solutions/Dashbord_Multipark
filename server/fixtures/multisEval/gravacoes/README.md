# Respostas gravadas partilhadas

Ficheiros `*.json` com uma lista de gravações (ou `{ "gravacoes": [...] }`), usadas por qualquer pergunta que chame a ferramenta com esses argumentos:

```json
[
  { "ferramenta": "extras_dia_situacao", "args": [{ "cidade": "Lisboa" }, { "cidade": "Lisboa", "data": "2026-10-22" }], "papel": "team_leader", "resposta": { "data": "2026-10-22", "cidade": "Lisboa" } }
]
```

A gravação da própria pergunta passa à frente destas; uma gravação com `papel` passa à frente das que não têm. O `README.md` da pasta de cima tem as regras.
