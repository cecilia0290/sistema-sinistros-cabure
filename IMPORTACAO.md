# Importar a planilha mãe / trocar a base de teste pela base real

## 1. Pré-requisitos (uma vez)

```bash
npm install                       # instala as dependências (não há node_modules no repo)
cp .env.example .env              # e preencha DB_* / SESSION_SECRET / ANTHROPIC_API_KEY
mysql -u root -p < schema.sql     # cria o banco sinistros_cabure e todas as tabelas
node criar_usuario.js             # cria o primeiro login
```

## 2. Conferir a planilha antes de importar (não grava nada)

```bash
node importar-planilha.js "C:\caminho\planilha-mae.xlsx" --dry-run
```

O relatório mostra:

- **Cabeçalhos reconhecidos** — quais colunas o importador achou e em que letra de coluna.
  Se alguma essencial (`segurado`, `cpf_ccb`, `parceiro`, `casos_a_pagar`) aparecer em
  "NÃO encontradas", me mande a saída: é só adicionar o apelido do cabeçalho em
  `planilha-parse.js` (`ALIASES`).
- **Resumo** — linhas lidas, linhas ignoradas (sem CPF/CCB nem nome), pessoas após a
  deduplicação, quantos casos ficaram marcados como *A PAGAR* e o **total a pagar**.
- **Avisos** — CCB composto separado (`123/456`), pessoa em várias linhas unificada,
  parceiro divergente entre linhas, valor de `CASOS A PAGAR` não reconhecido.

Aba diferente de `planilha geral`: `--aba "nome exato da aba"`.

## 3. Importar de verdade (apaga os dados de teste)

```bash
node importar-planilha.js "C:\caminho\planilha-mae.xlsx"
# digite  IMPORTAR  para confirmar   (ou use --sim para pular a confirmação)
```

Isso **TRUNCA** `casos`, `documentos`, `extracoes_ia`, `historico`, `linhas_planilha`
e recarrega tudo a partir da planilha.

## Como as regras são aplicadas na importação

| Assunto | Regra |
|---|---|
| **CPF** | só dígitos, zero à esquerda reposto para **11 dígitos** (`1234567890` → `01234567890`). |
| **CCB composto** | `123/456`, `123-456`, `123 e 456` são **separados** antes de comparar. |
| **Duplicidade** | pessoas em várias linhas (mesmo CPF/CCB, ou CPF com/sem zero) viram **1 caso só**. As linhas cruas ficam em `linhas_planilha` para auditoria. |
| **Parceiro** | `Fintech Corban` e `Fintech do Corban` (e variações) → **um nome canônico**: `Fintech do Corban`. Idem SETHI, Granatech, POUPACRED, Invest All. **Nova** e **Resgata Ai** são parceiros SEPARADOS (contatos diferentes), não são unificados entre si — ambos usam o mesmo FUNDO por trás (`LA VIE`), que é preenchido automaticamente na coluna FUNDO quando vier vazia. |
| **Parcelas cobertas / teto** | vêm do catálogo em `regras.js` (`PARCEIROS`). **Fintech do Corban = 4 parcelas**. POUPACRED tem 2 produtos — escolhidos pela coluna **FUNDO**. |
| **Pagamento** | decidido **só** pela coluna **`CASOS A PAGAR`** (`casos_a_pagar`). A coluna **`STATUS`** é gravada em `status_planilha` apenas como etiqueta e **não** entra em nenhuma decisão nem soma. |
| **Elegibilidade / carência / franquia / CIA** | **inalteradas** — o motor de regras roda igual ao de antes. |

## Por que Dashboard, "Pagar agora" e os 4 gráficos agora batem

Tudo lê a **mesma coluna** (`valor_a_pagar_final`) com o **mesmo filtro**
(`casos_a_pagar = 1`), no servidor:

- `valor_a_pagar_final` = `Valor a Pagar` da planilha quando existe; senão o total
  calculado pelo motor (`valor por parcela × parcelas cobertas`, limitado ao teto total).
- Dashboard `GET /api/dashboard` → cartão "Total a pagar" e gráfico "Valor a pagar por
  parceiro" saem da mesma query.
- "Pagar agora" `GET /api/pagar-agora` → a soma da tabela é o mesmo número do cartão.

## Deduplicação (regra corrigida)

Só é o **mesmo caso** quando é **mesmo CPF + mesmo CCB** (mesmo empréstimo).

| Situação | Resultado |
|---|---|
| Mesmo CPF, **mesmo CCB** (reenvio, ou `123/456` partido em 2 linhas) | 1 caso, valor **não** somado (avisa se as linhas divergem) |
| Mesmo CPF, **CCB diferente** | **casos separados**, cada um com seu próprio valor a pagar |
| Só CPF (sem CCB) repetido | 1 caso |

## Leitura de documentos — 100% local, sem API paga

Removido qualquer uso da API da Anthropic/Claude. `ANTHROPIC_API_KEY` não é mais usada.

- **Dataprev (JSON/CSV)**: lida direto por código — motivo/data de desligamento, admissão, situação.
- **CCB / TRCT (PDF digital ou imagem)**: PDF digital → texto; imagem → **Tesseract OCR** local.
  Depois, **regex por parceiro** (`extracao.js` → `REGRAS_EXTRACAO`, com um `GENERICO` pt-BR de base).
- Cada campo sai com **confiança** (alta/média/baixa/ausente). Faltou campo obrigatório
  (`cpf_ccb`, `data_contratacao`, `data_evento`) ou OCR fraco → caso vira
  **`AGUARDANDO CONFERÊNCIA MANUAL`** com o motivo dizendo qual campo.
- **PDF escaneado** (sem texto) → conferência manual (não há rasterização pura-JS confiável).
- Tela **Conferência manual** (`/conferencia.html`): texto do OCR ao lado do formulário.
  Salvar → `conferencia_pendente = 0` e o motor de regras reprocessa.

> Para afinar a leitura por parceiro você precisa me mandar **1–2 exemplos reais** de
> cada tipo (CCB, TRCT, Dataprev) — aí eu preencho os regex e as chaves do Dataprev.

## Upload em lote (`/lote.html`)

Envie uma pasta inteira (uma subpasta por segurado) ou vários `.zip`. Cada documento
passa pelo pipeline local, um a um, com barra de progresso. No fim: *X processados,
Y adicionados, Z duplicados, W em conferência, erros*.

## Quem paga (`/por-cia.html`) e Exportação (`/exportar.html`)

- **Quem paga**: telas separadas "MetLife paga" / "Caburé paga" (coluna `cia` calculada).
  Atrás do login — informação interna, nunca some para o parceiro.
- **Exportar**: painel de filtros (parceiro, fundo, CIA, status, data de evento, data de
  adição). Checkbox **"Incluir coluna CIA"** desmarcado por padrão — quando desmarcado a
  coluna **não é gerada** (dados montados sem ela). Nome do arquivo reflete o filtro:
  `casos_a_pagar_METLIFE_08092026.xlsx`, `casos_TODOS_interno_08092026.xlsx`, `casos_sem_cia_08092026.xlsx`.
  A rota `/exportar` exige login.

## Testes (não precisam de banco)

```bash
npm test
```
