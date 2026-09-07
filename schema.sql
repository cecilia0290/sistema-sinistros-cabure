-- ============================================================================
-- Sistema de Sinistros — Grupo Caburé
-- Esquema completo do banco (MySQL 8 / utf8mb4)
-- ----------------------------------------------------------------------------
-- As tabelas são criadas no banco JÁ SELECIONADO pela conexão (DB_NAME do .env).
-- No Railway gerenciado esse banco é "railway" e não é possível criar outro,
-- por isso NÃO há "CREATE DATABASE" nem "USE" aqui.
--
-- Uso:
--   node setup-db.js                           (roda este arquivo na conexão do .env)
--   node criar_usuario.js                      (cria o primeiro login)
--   node importar-planilha.js <planilha.xlsx>  (carrega a base real)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Usuários / autenticação
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nome        VARCHAR(160) NOT NULL,
  usuario     VARCHAR(60)  NOT NULL UNIQUE,
  senha_hash  VARCHAR(255) NOT NULL,
  perfil      VARCHAR(30)  NOT NULL DEFAULT 'analista',
  criado_em   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Casos (um por SEGURADO — nunca mais de um por pessoa)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS casos (
  id            INT AUTO_INCREMENT PRIMARY KEY,

  -- Origem / rastreio
  origem        VARCHAR(20)  NOT NULL DEFAULT 'DOCUMENTO',   -- 'PLANILHA' | 'DOCUMENTO'
  nome_arquivo  VARCHAR(255) NULL,
  texto_extraido MEDIUMTEXT  NULL,
  data_upload   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Identificação do segurado
  segurado      VARCHAR(200) NULL,
  cpf_ccb       VARCHAR(255) NULL,                            -- texto exibível (partes juntas por " / ")
  identidade_chaves JSON     NULL,                            -- ["cpf:00000000000","ccb:123456", ...] p/ dedupe e vínculo de docs
  parceiro      VARCHAR(120) NULL,                            -- SEMPRE o nome canônico (ver regras.normalizarParceiro)
  fundo         VARCHAR(160) NULL,
  cobertura     VARCHAR(160) NULL,
  cia           VARCHAR(60)  NULL,

  -- Datas
  mes_ano_contratacao VARCHAR(7) NULL,                        -- 'AAAA-MM' quando dá pra normalizar
  data_contratacao DATE NULL,
  data_evento      DATE NULL,
  data_admissao    DATE NULL,

  -- Dados do contrato / parcela
  motivo_desligamento_codigo VARCHAR(10) NULL,
  valor_parcela              DECIMAL(12,2) NULL,
  limite_beneficio           DECIMAL(12,2) NULL,
  numero_parcelas_contratadas INT NULL,

  -- Produto do seguro. FONTE PRINCIPAL = catálogo (regras.js). As colunas *_planilha
  -- guardam o que veio na planilha (AP/AQ) só para comparação; divergencia_produto
  -- descreve a diferença quando existe (o motor NÃO decide, só sinaliza).
  teto_parcela_produto             DECIMAL(12,2) NULL,
  numero_parcelas_cobertas_produto INT NULL,
  teto_planilha                    DECIMAL(12,2) NULL,
  parcelas_planilha                INT NULL,
  divergencia_produto              VARCHAR(255) NULL,
  fonte_produto                    VARCHAR(200) NULL,

  -- Leitura automática do documento (100% local — sem IA/API paga)
  tipo_documento       VARCHAR(20) NULL,            -- DATAPREV | CCB | TRCT | DESCONHECIDO
  conferencia_pendente TINYINT(1) NOT NULL DEFAULT 0,
  motivo_conferencia   VARCHAR(500) NULL,           -- "Não foi possível ler automaticamente: <campo>"

  -- Motor de regras (calculado — lógica de elegibilidade/carência/franquia NÃO mudou)
  carencia_dias   INT NULL,
  franquia_data   DATE NULL,
  valor_a_pagar   DECIMAL(12,2) NULL,                         -- valor de UMA parcela paga pelo seguro
  valor_total_a_pagar DECIMAL(12,2) NULL,                     -- valor_a_pagar * parcelas cobertas (limitado ao teto total)
  status          VARCHAR(40) NULL,                           -- etiqueta analítica do motor
  motivo_negacao  VARCHAR(500) NULL,

  -- Vindos da PLANILHA MÃE (aba "planilha geral")
  franquia_planilha       DATE NULL,
  franquia_ate            DATE NULL,                          -- data após "FRANQUIA ATÉ / A PARTIR DE ..." na coluna CASOS A PAGAR
  data_programada         DATE NULL,                          -- data após "PROGRAMADO PARA PAGAMENTO ..." (conferir manualmente)
  status_planilha         VARCHAR(80) NULL,                   -- coluna STATUS — ETIQUETA, não decide pagamento
  classificacao_pagamento VARCHAR(60) NULL,                   -- categoria derivada da coluna CASOS A PAGAR
  observacao_pagamento    VARCHAR(255) NULL,                  -- nota de override manual (config-pagamento.casosManuais)
  valor_a_pagar_planilha  DECIMAL(12,2) NULL,                 -- coluna "Valor a Pagar"
  casos_a_pagar           TINYINT(1) NOT NULL DEFAULT 0,      -- CASOS A PAGAR classificado como "A PAGAR" (prefixo) — É ELE QUE DECIDE

  -- Conciliação parcela a parcela com `pagamentos_confirmados`.
  -- parcelas_pagas   = nº de aparições do CCB nos arquivos de pagamento (1 por lote).
  -- parcelas_restantes = parcelas_cobertas (catálogo) - parcelas_pagas (>= 0).
  -- Se restantes > 0 o caso segue "A PAGAR" (próxima parcela); se 0, "JÁ PAGO (completo)".
  parcelas_pagas          INT NULL,
  parcelas_restantes      INT NULL,

  -- Valor único que o Dashboard, a página "Pagar agora" e os 4 gráficos usam.
  -- COALESCE(valor_a_pagar_planilha, valor_total_a_pagar, valor_a_pagar) — uma
  -- coluna só, um filtro só (casos_a_pagar = 1), por isso os totais SEMPRE batem.
  valor_a_pagar_final     DECIMAL(12,2) NULL,

  KEY idx_casos_status        (status),
  KEY idx_casos_parceiro      (parceiro),
  KEY idx_casos_cia           (cia),
  KEY idx_casos_a_pagar       (casos_a_pagar),
  KEY idx_casos_conferencia   (conferencia_pendente),
  KEY idx_casos_upload        (data_upload),
  KEY idx_casos_mes_contrat   (mes_ano_contratacao)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Documentos vinculados a um caso
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documentos (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  caso_id             INT NOT NULL,
  nome_arquivo        VARCHAR(255) NOT NULL,
  status_processamento VARCHAR(40) NOT NULL DEFAULT 'PROCESSADO',
  texto_extraido      MEDIUMTEXT NULL,
  data_upload         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_documentos_caso (caso_id),
  CONSTRAINT fk_documentos_caso FOREIGN KEY (caso_id) REFERENCES casos(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Extrações automáticas (JSON de campos + confiança por campo) — feitas localmente.
-- Mantém o nome "extracoes_ia" por compatibilidade; não há mais IA envolvida.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extracoes_ia (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  caso_id       INT NOT NULL,
  json_extraido JSON NOT NULL,
  confianca_json JSON NULL,                 -- { "cpf_ccb": "alta", "data_evento": "ausente", ... }
  fonte         VARCHAR(200) NULL,          -- ex.: "Dataprev (JSON) + SETHI · CCB (regex)"
  data_extracao TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_extracoes_caso (caso_id),
  CONSTRAINT fk_extracoes_caso FOREIGN KEY (caso_id) REFERENCES casos(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Histórico / auditoria de alterações
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historico (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  caso_id        INT NOT NULL,
  campo          VARCHAR(60) NOT NULL,
  valor_anterior TEXT NULL,
  valor_novo     TEXT NULL,
  usuario        VARCHAR(160) NULL,
  data_hora      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_historico_caso (caso_id),
  CONSTRAINT fk_historico_caso FOREIGN KEY (caso_id) REFERENCES casos(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Pagamentos JÁ REALIZADOS (comprovantes + planilhas de pagamento por parceiro,
-- e a planilha da MetLife). É a FONTE DA VERDADE sobre o que já foi pago — a
-- planilha mãe pode estar desatualizada e ainda dizer "A PAGAR".
--   Carga:  node importar-pagamentos.js <pasta|zip> [--metlife <arquivo.xlsx>]
--   Uso:    a classificação da planilha (planilha-transform.js) consulta esta
--           tabela ANTES da coluna CASOS A PAGAR: CCB aqui => o caso é JÁ PAGO.
-- Um mesmo empréstimo (ccb) pode ter mais de uma linha (mais de um pagamento);
-- a classificação só verifica "existe pelo menos uma".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagamentos_confirmados (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  ccb            VARCHAR(40)  NOT NULL,                 -- CCB NORMALIZADO: só dígitos, sem zeros à esquerda (identidade.normalizarCcb). Para SETHI é o nº interno.
  ccb_bruto      VARCHAR(120) NULL,                     -- como veio no arquivo (auditoria)
  segurado       VARCHAR(200) NULL,
  parceiro       VARCHAR(120) NULL,                     -- nome canônico (regras.normalizarParceiro) quando reconhecido
  valor_pago     DECIMAL(12,2) NULL,
  data_pagamento DATE NULL,
  fonte_arquivo  VARCHAR(255) NOT NULL,                 -- caminho do arquivo dentro do zip, ou "MetLife: <arquivo>"
  lote           VARCHAR(160) NULL,                     -- nome lógico do lote (arquivo sem pasta/sufixo). 1 linha por (ccb, lote) = 1 parcela paga.
  observacao     VARCHAR(255) NULL,
  criado_em      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pgto_ccb       (ccb),
  KEY idx_pgto_parceiro  (parceiro),
  KEY idx_pgto_data      (data_pagamento)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Linhas cruas da planilha mãe (auditoria da importação).
-- Uma pessoa pode ter VÁRIAS linhas aqui, mas UM só registro em `casos`.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS linhas_planilha (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  caso_id              INT NULL,
  linha_origem         INT NULL,                 -- nº da linha no arquivo (1-based, contando o cabeçalho)
  cpf_ccb_bruto        VARCHAR(255) NULL,
  segurado             VARCHAR(200) NULL,
  parceiro_bruto       VARCHAR(160) NULL,
  fundo                VARCHAR(160) NULL,
  valor_parcela        DECIMAL(12,2) NULL,
  num_parcelas_contratadas INT NULL,
  valor_a_pagar        DECIMAL(12,2) NULL,
  casos_a_pagar_bruto  VARCHAR(255) NULL,        -- texto integral da coluna CASOS A PAGAR (pode ser longo)
  status_bruto         VARCHAR(255) NULL,        -- texto integral da coluna STATUS
  dados_json           JSON NULL,                -- linha inteira, como veio
  criado_em            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_linhas_caso (caso_id),
  CONSTRAINT fk_linhas_caso FOREIGN KEY (caso_id) REFERENCES casos(id) ON DELETE SET NULL
) ENGINE=InnoDB;
