// ============================================================================
// Cria as tabelas do sistema no banco do .env (roda schema.sql).
//   node setup-db.js
// Seguro rodar de novo: o schema usa CREATE TABLE IF NOT EXISTS.
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const cfg = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true
  };

  const faltando = ['DB_HOST', 'DB_USER', 'DB_NAME'].filter(k => !process.env[k]);
  if (faltando.length) {
    console.error('Faltam variáveis no .env: ' + faltando.join(', '));
    process.exit(1);
  }

  console.log(`Conectando em ${cfg.host}:${cfg.port} / banco "${cfg.database}"...`);
  let conn;
  try {
    conn = await mysql.createConnection(cfg);
  } catch (e) {
    console.error('Não foi possível conectar: ' + e.message);
    process.exit(1);
  }

  // Migrações idempotentes: colunas adicionadas depois da 1ª versão do schema.
  async function garantirColuna(tabela, coluna, definicao) {
    const [r] = await conn.query(
      `SELECT COUNT(*) n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [tabela, coluna]);
    if (r[0].n === 0) {
      await conn.query(`ALTER TABLE \`${tabela}\` ADD COLUMN ${definicao}`);
      console.log(`  + coluna nova: ${tabela}.${coluna}`);
    }
  }

  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await conn.query(sql);

    await garantirColuna('casos', 'franquia_ate', 'franquia_ate DATE NULL AFTER franquia_planilha');
    await garantirColuna('casos', 'data_programada', 'data_programada DATE NULL AFTER franquia_ate');
    await garantirColuna('casos', 'classificacao_pagamento', 'classificacao_pagamento VARCHAR(60) NULL AFTER status_planilha');
    await garantirColuna('casos', 'tipo_documento', 'tipo_documento VARCHAR(20) NULL');
    await garantirColuna('casos', 'conferencia_pendente', 'conferencia_pendente TINYINT(1) NOT NULL DEFAULT 0');
    await garantirColuna('casos', 'motivo_conferencia', 'motivo_conferencia VARCHAR(500) NULL');
    await garantirColuna('casos', 'teto_planilha', 'teto_planilha DECIMAL(12,2) NULL AFTER numero_parcelas_cobertas_produto');
    await garantirColuna('casos', 'parcelas_planilha', 'parcelas_planilha INT NULL AFTER teto_planilha');
    await garantirColuna('casos', 'divergencia_produto', 'divergencia_produto VARCHAR(255) NULL AFTER parcelas_planilha');
    await garantirColuna('casos', 'parcelas_pagas', 'parcelas_pagas INT NULL AFTER casos_a_pagar');
    await garantirColuna('casos', 'parcelas_restantes', 'parcelas_restantes INT NULL AFTER parcelas_pagas');
    await garantirColuna('casos', 'observacao_pagamento', 'observacao_pagamento VARCHAR(255) NULL AFTER classificacao_pagamento');
    await garantirColuna('pagamentos_confirmados', 'lote', 'lote VARCHAR(160) NULL AFTER fonte_arquivo');
    await garantirColuna('extracoes_ia', 'confianca_json', 'confianca_json JSON NULL');
    await garantirColuna('extracoes_ia', 'fonte', 'fonte VARCHAR(200) NULL');
    // Colunas que podem ter sido criadas mais estreitas numa versão anterior — alarga.
    await conn.query("ALTER TABLE casos MODIFY classificacao_pagamento VARCHAR(60) NULL").catch(() => {});
    await conn.query("ALTER TABLE linhas_planilha MODIFY casos_a_pagar_bruto VARCHAR(255) NULL").catch(() => {});
    await conn.query("ALTER TABLE linhas_planilha MODIFY status_bruto VARCHAR(255) NULL").catch(() => {});

    const [tabelas] = await conn.query('SHOW TABLES');
    const nomes = tabelas.map(r => Object.values(r)[0]);
    console.log('\nOK — tabelas no banco:');
    for (const t of nomes) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      console.log(`  • ${t.padEnd(20)} ${n} linha(s)`);
    }
    console.log('\nPróximo passo: node criar_usuario.js');
  } catch (e) {
    console.error('Erro ao aplicar o schema: ' + e.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
