// ============================================================================
// Importador da PLANILHA MÃE  (aba "planilha geral")
// ----------------------------------------------------------------------------
//   node importar-planilha.js <arquivo.xlsx> [--aba "planilha geral"]
//                             [--dry-run] [--sim]
//
//   --dry-run  : lê, valida e mostra o relatório SEM tocar no banco (faça sempre isto antes)
//   --aba      : nome da aba (padrão: "planilha geral"; ignora maiúsculas/acentos)
//   --sim      : pula a confirmação interativa
//
// O que ele faz:
//   1. Lê a aba e casa os cabeçalhos (tolerante a acento / "Nº" / "CPF / CCB" etc.)
//   2. Normaliza CPF (zero à esquerda, 11 dígitos) e QUEBRA CCB composto "123/456"
//   3. Deduplica: uma pessoa em várias linhas -> UM caso só (union-find por identidade)
//   4. Resolve parceiro para o nome canônico e aplica o catálogo (regras.js)
//   5. "CASOS A PAGAR" decide o pagamento. "STATUS" entra só como etiqueta.
//   6. APAGA os dados de teste e recarrega `casos` + `linhas_planilha` com a base real
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const XLSX = require('xlsx');
const pool = require('./db');
const P = require('./planilha-parse');
const { transformar, aplicarMotor, brl } = require('./planilha-transform');

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
const args = process.argv.slice(2);
const opcoes = { aba: 'planilha geral', dryRun: false, sim: false, arquivo: null, linhas: null, liberarProgTodos: false, liberarProgLista: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run' || a === '--dryrun') opcoes.dryRun = true;
  else if (a === '--sim' || a === '-y') opcoes.sim = true;
  else if (a === '--aba') opcoes.aba = args[++i];
  else if (a === '--linhas') opcoes.linhas = args[++i];
  else if (a === '--liberar-programados') {
    // sem valor (ou "todos") => libera todos; com valor => só esses CCB/CPF
    const prox = args[i + 1];
    if (prox && !prox.startsWith('--') && prox.toLowerCase() !== 'todos') { opcoes.liberarProgLista = args[++i]; }
    else { opcoes.liberarProgTodos = true; if (prox && prox.toLowerCase() === 'todos') i++; }
  }
  else if (!a.startsWith('--') && !opcoes.arquivo) opcoes.arquivo = a;
}

// Chaves (só dígitos) de casos PROGRAMADO liberados por conferência manual:
// config-pagamento.js + o que vier em --liberar-programados "123,456".
const liberadosChaves = new Set();
try {
  const cfg = require('./config-pagamento');
  for (const item of (cfg.programadosLiberados || [])) {
    if (item.ccb) liberadosChaves.add(String(item.ccb).replace(/\D/g, ''));
    if (item.cpf) liberadosChaves.add(String(item.cpf).replace(/\D/g, '').padStart(11, '0'));
  }
} catch (e) { /* sem config, tudo bem */ }
if (opcoes.liberarProgLista) {
  for (const t of opcoes.liberarProgLista.split(',')) {
    const d = t.replace(/\D/g, '');
    if (d) liberadosChaves.add(d.length >= 9 && d.length <= 11 ? d.padStart(11, '0') : d);
  }
}

// --linhas "953-971,1126-1173,1630" -> Set de números de linha do Excel (1-based)
function parseRangoLinhas(spec) {
  const set = new Set();
  if (!spec) return set;
  for (const parte of String(spec).split(',')) {
    const m = parte.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { for (let n = +m[1]; n <= +m[2]; n++) set.add(n); }
    else if (/^\d+$/.test(parte.trim())) set.add(+parte.trim());
  }
  return set;
}
const LINHAS_DEBUG = parseRangoLinhas(opcoes.linhas);

if (!opcoes.arquivo) {
  console.error('Uso: node importar-planilha.js <arquivo.xlsx> [--aba "planilha geral"] [--dry-run] [--sim]\n' +
    '                                 [--linhas "953-971,1126-1173"] [--liberar-programados ["ccb1,ccb2" | todos]]');
  process.exit(1);
}
if (!fs.existsSync(opcoes.arquivo)) {
  console.error('Arquivo não encontrado: ' + opcoes.arquivo);
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Leitura da aba
// ----------------------------------------------------------------------------
function lerAba() {
  const wb = XLSX.readFile(opcoes.arquivo, { cellDates: true, cellNF: false, cellText: true });
  const alvo = P.normHeader(opcoes.aba);
  const nomeReal = wb.SheetNames.find(n => P.normHeader(n) === alvo)
    || wb.SheetNames.find(n => P.normHeader(n).includes(alvo) || alvo.includes(P.normHeader(n)));
  if (!nomeReal) {
    throw new Error(`Aba "${opcoes.aba}" não encontrada. Abas: ${wb.SheetNames.map(n => `"${n}"`).join(', ')}`);
  }
  const ws = wb.Sheets[nomeReal];
  if (!ws['!ref']) throw new Error(`A aba "${nomeReal}" está vazia.`);
  const range = XLSX.utils.decode_range(ws['!ref']);

  // Números: valor cru (precisão). Datas: texto formatado, se houver; senão partes UTC.
  const celula = (r, c) => {
    const cel = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cel) return null;
    if (cel.t === 'n' && typeof cel.v === 'number') return cel.v;
    if (cel.t === 'd' && cel.v instanceof Date) {
      return (cel.w && String(cel.w).trim())
        ? cel.w
        : P.fmtData(cel.v.getUTCFullYear(), cel.v.getUTCMonth() + 1, cel.v.getUTCDate());
    }
    if (cel.w !== undefined && cel.w !== null && String(cel.w).trim() !== '') return cel.w;
    return cel.v === undefined ? null : cel.v;
  };

  // Linha de cabeçalho = a primeira (nas 15 primeiras) que classifica mais campos.
  let linhaCabecalho = -1;
  let melhorMapa = null;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 15); r++) {
    const mapa = {};
    let acertos = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const campo = P.classificarHeader(P.normHeader(celula(r, c)));
      if (campo && mapa[campo] === undefined) { mapa[campo] = c; acertos++; }
    }
    if (acertos > (melhorMapa ? Object.keys(melhorMapa).length : 0)) { melhorMapa = mapa; linhaCabecalho = r; }
    if (acertos >= 9) break;
  }
  if (linhaCabecalho < 0 || !melhorMapa || Object.keys(melhorMapa).length < 4) {
    throw new Error('Não identifiquei a linha de cabeçalho. Rode com --dry-run e me mande a saída.');
  }

  const naoReconhecidos = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const bruto = celula(linhaCabecalho, c);
    if (P.vazio(bruto)) continue;
    if (!Object.values(melhorMapa).includes(c)) naoReconhecidos.push(String(bruto).trim());
  }

  // Mapa inverso: índice de coluna -> nome do campo lógico (para o dump de debug).
  const campoPorCol = {};
  for (const [campo, col] of Object.entries(melhorMapa)) campoPorCol[col] = campo;

  const linhas = [];
  const debug = [];
  for (let r = linhaCabecalho + 1; r <= range.e.r; r++) {
    const excelRow = r + 1;
    const obj = { __linha: excelRow };
    let algum = false;
    const celulasDump = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const v = celula(r, c);
      if (!P.vazio(v)) algum = true;
      obj['col' + c] = v;
      if (LINHAS_DEBUG.has(excelRow) && !P.vazio(v)) {
        celulasDump.push(`${XLSX.utils.encode_col(c)}${campoPorCol[c] ? '(' + campoPorCol[c] + ')' : ''}=${JSON.stringify(String(v).slice(0, 40))}`);
      }
    }
    if (algum) linhas.push(obj);
    if (LINHAS_DEBUG.has(excelRow)) {
      debug.push({ excelRow, vazia: !algum, celulas: celulasDump });
    }
  }
  return { nomeReal, mapa: melhorMapa, naoReconhecidos, linhas, debug };
}

// ----------------------------------------------------------------------------
// Gravação
// ----------------------------------------------------------------------------
const corta = (s, max) => (s == null ? null : String(s).slice(0, max));

const COLS_CASO = ['origem', 'segurado', 'cpf_ccb', 'identidade_chaves', 'parceiro', 'fundo', 'cia', 'cobertura',
  'mes_ano_contratacao', 'data_contratacao', 'data_evento', 'data_admissao',
  'motivo_desligamento_codigo', 'valor_parcela', 'numero_parcelas_contratadas',
  'teto_parcela_produto', 'numero_parcelas_cobertas_produto',
  'teto_planilha', 'parcelas_planilha', 'divergencia_produto',
  'carencia_dias', 'franquia_data', 'valor_a_pagar', 'valor_total_a_pagar',
  'status', 'motivo_negacao',
  'franquia_planilha', 'franquia_ate', 'data_programada', 'status_planilha', 'classificacao_pagamento',
  'valor_a_pagar_planilha', 'casos_a_pagar', 'valor_a_pagar_final'];

function valoresCaso(caso) {
  return [
    'PLANILHA', corta(caso.segurado, 200), corta(caso.cpf_ccb, 255), JSON.stringify(caso.chavesGrupo),
    corta(caso.parceiro, 120), corta(caso.fundo, 160), corta(caso.cia || caso.cia_calculada, 60), corta(caso.cobertura, 160),
    caso.mes_ano_contratacao || null, caso.data_contratacao || null, caso.data_evento || null, caso.data_admissao || null,
    corta(caso.motivo_desligamento_codigo, 10), caso.valor_parcela ?? null, caso.numero_parcelas_contratadas ?? null,
    caso.teto_parcela_produto ?? null, caso.numero_parcelas_cobertas_produto ?? null,
    caso.teto_planilha ?? null, caso.parcelas_planilha ?? null, corta(caso.divergencia_produto, 255),
    caso.carencia_dias ?? null, caso.franquia_data || null, caso.valor_a_pagar ?? null, caso.valor_total_a_pagar ?? null,
    corta(caso.status, 40), corta(caso.motivo_negacao, 500),
    caso.franquia_planilha || null, caso.franquia_ate || null, caso.data_programada || null,
    corta(caso.status_planilha, 80), corta(caso.classificacao_pagamento, 60),
    caso.valor_a_pagar_planilha ?? null, caso.casos_a_pagar ? 1 : 0, caso.valor_a_pagar_final ?? null
  ];
}

const COLS_LINHA = ['caso_id', 'linha_origem', 'cpf_ccb_bruto', 'segurado', 'parceiro_bruto', 'fundo',
  'valor_parcela', 'num_parcelas_contratadas', 'valor_a_pagar', 'casos_a_pagar_bruto', 'status_bruto', 'dados_json'];

function valoresLinha(casoId, linha) {
  return [
    casoId, linha.linhaOrigem, corta(linha.cpfCcbBruto, 255), corta(linha.segurado, 200),
    corta(linha.parceiroBruto, 160), corta(linha.fundo, 160),
    linha.valorParcela ?? null, linha.numParcelasContratadas ?? null, linha.valorAPagarPlanilha ?? null,
    corta(linha.casosAPagarBruto, 255), corta(linha.statusPlanilha, 255), JSON.stringify(linha.raw)
  ];
}

// INSERT multi-linha em lotes (bem mais rápido em conexão remota).
async function inserirEmLotes(conn, tabela, colunas, linhasDeValores, tam = 200) {
  const ph = '(' + colunas.map(() => '?').join(',') + ')';
  for (let i = 0; i < linhasDeValores.length; i += tam) {
    const lote = linhasDeValores.slice(i, i + tam);
    await conn.query(
      `INSERT INTO ${tabela} (${colunas.join(',')}) VALUES ${lote.map(() => ph).join(',')}`,
      lote.flat()
    );
  }
}

async function gravar(casos) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['linhas_planilha', 'historico', 'extracoes_ia', 'documentos', 'casos']) {
      await conn.query('TRUNCATE TABLE ' + t);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.query('START TRANSACTION');

    // 1) casos, lote a lote. IDs auto-incremento de um INSERT multi-linha são
    //    contíguos no InnoDB -> dá para calcular o id de cada caso do lote.
    let proximoId = null;
    const TAM = 200;
    for (let i = 0; i < casos.length; i += TAM) {
      const lote = casos.slice(i, i + TAM);
      const ph = '(' + COLS_CASO.map(() => '?').join(',') + ')';
      const [res] = await conn.query(
        `INSERT INTO casos (${COLS_CASO.join(',')}) VALUES ${lote.map(() => ph).join(',')}`,
        lote.map(valoresCaso).flat()
      );
      const primeiroId = res.insertId;
      lote.forEach((caso, k) => { caso.__id = primeiroId + k; });
      proximoId = primeiroId + lote.length;
    }

    // 2) linhas_planilha, todas de uma vez em lotes, já com o caso_id calculado.
    const linhasFlat = [];
    for (const caso of casos) {
      for (const linha of caso.linhas) linhasFlat.push(valoresLinha(caso.__id, linha));
    }
    await inserirEmLotes(conn, 'linhas_planilha', COLS_LINHA, linhasFlat, 150);

    await conn.query('COMMIT');
    return { n: casos.length, nLinhas: linhasFlat.length, proximoId };
  } catch (erro) {
    try { await conn.query('ROLLBACK'); } catch (e) { /* ignora */ }
    throw erro;
  } finally {
    conn.release();
  }
}

// ----------------------------------------------------------------------------
// Relatório
// ----------------------------------------------------------------------------
function relatorio(aba, resultado, casos) {
  const L = s => console.log(s);
  L('');
  L('======================================================================');
  L('  IMPORTACAO DA PLANILHA MAE' + (opcoes.dryRun ? '   [DRY-RUN - nada gravado]' : ''));
  L('======================================================================');
  L(`  Arquivo : ${path.basename(opcoes.arquivo)}`);
  L(`  Aba     : "${aba.nomeReal}"`);
  L('');
  L('  Cabecalhos reconhecidos:');
  for (const [campo, col] of Object.entries(aba.mapa).sort((a, b) => a[1] - b[1])) {
    L(`    - ${campo.padEnd(30)} -> coluna ${XLSX.utils.encode_col(col)}`);
  }
  const faltando = ['segurado', 'cpf_ccb', 'parceiro', 'casos_a_pagar'].filter(c => aba.mapa[c] === undefined);
  if (faltando.length) L(`\n  [!] Colunas essenciais NAO encontradas: ${faltando.join(', ')}`);
  if (aba.naoReconhecidos.length) L(`\n  Cabecalhos ignorados: ${aba.naoReconhecidos.join(' | ')}`);

  const aPagar = casos.filter(c => c.casos_a_pagar === 1);
  const total = aPagar.reduce((s, c) => s + Number(c.valor_a_pagar_final || 0), 0);

  // --- Classificação da coluna CASOS A PAGAR, contada LINHA A LINHA ---
  const cat = resultado.categorias || {};
  const somaCat = Object.values(cat).reduce((s, n) => s + n, 0);
  const lin = (rot, n, extra) => L(`    ${rot.padEnd(30, '.')} ${String(n || 0).padStart(5)}${extra ? '  ' + extra : ''}`);
  L('');
  L('  ---------- COLUNA "CASOS A PAGAR" (contagem por LINHA) ----------');
  const nLiberados = casos.filter(c => c.programado_liberado).length;
  const nParcNaoId = casos.filter(c => c.categoria_pagamento === 'PARCEIRO_NAO_IDENTIFICADO').length;
  lin('A PAGAR', cat.A_PAGAR, nLiberados ? `(linhas; +${nLiberados} ex-PROGRAMADO liberados, -${nParcNaoId} parceiro nao id.)` : (nParcNaoId ? `(linhas; -${nParcNaoId} parceiro nao id.)` : ''));
  lin('PROGRAMADO (confirmar)', cat.PROGRAMADO, nLiberados ? `- ${nLiberados} ja liberados = ${cat.PROGRAMADO - nLiberados} pendentes` : '<< NAO entra automatico');
  lin('AGUARDANDO FIM DA FRANQUIA', cat.AGUARDANDO_FRANQUIA);
  lin('AGUARDANDO DOCUMENTACAO', cat.AGUARDANDO_DOCUMENTACAO);
  lin('JA PAGO', cat.JA_PAGO);
  lin('NAO PAGAR', cat.NAO_PAGAR);
  lin('PENDENTE DE CLASSIFICACAO', cat.PENDENTE, '(so celula vazia)');
  lin('NAO RECONHECIDO', cat.NAO_RECONHECIDO, '(gera aviso)');
  L(`    ${'-'.repeat(30)} ${'-'.repeat(5)}`);
  L(`    ${'SOMA'.padEnd(30, '.')} ${String(somaCat).padStart(5)}   ${somaCat === resultado.totalLinhas ? '== linhas lidas (OK)' : '!= linhas lidas (' + resultado.totalLinhas + ') -- CONFERIR'}`);
  L('');
  L(`  Casos (apos dedupe) que ENTRAM no total A PAGAR: ${casos.filter(c => c.casos_a_pagar === 1).length}`);
  L(`  Casos "AGUARDANDO REGRA / PARCEIRO NAO IDENTIFICADO" (fora do total): ${nParcNaoId}`);

  // --- PROGRAMADO: listar 1 a 1 (liberados por conferência vs. ainda pendentes) ---
  const linhaProg = c => `    ${(c.segurado || '?').slice(0, 32).padEnd(32)} | ${(c.cpf_ccb || '?').padEnd(26)} | ` +
    `${(c.parceiro || '—').padEnd(10)} | data ${c.data_programada || '?'} | ${brl(c.valor_a_pagar_final)}`;
  const progLiberados = casos.filter(c => c.programado_liberado);
  const progPendentes = casos.filter(c => c.categoria_pagamento === 'PROGRAMADO');
  if (progLiberados.length) {
    L('');
    L(`  ===== EX-PROGRAMADO liberados por conferencia manual -> ENTRARAM em A PAGAR (${progLiberados.length}) =====`);
    for (const c of progLiberados) L(linhaProg(c));
  }
  if (progPendentes.length) {
    L('');
    L(`  ===== PROGRAMADO - CONFIRMAR SE JA FOI PAGO (${progPendentes.length}) — NAO entraram no total =====`);
    for (const c of progPendentes) L(linhaProg(c));
    L('    (para liberar: adicione o CCB em config-pagamento.js, ou rode com --liberar-programados "ccb1,ccb2")');
  }

  // --- PARCEIRO NÃO IDENTIFICADO: pagariam, mas sem regra de produto ---
  const semRegra = casos.filter(c => c.categoria_pagamento === 'PARCEIRO_NAO_IDENTIFICADO');
  if (semRegra.length) {
    L('');
    L(`  ===== AGUARDANDO REGRA DE PRODUTO / PARCEIRO NAO IDENTIFICADO (${semRegra.length}) — NAO entraram no total =====`);
    for (const c of semRegra) {
      L(`    ${(c.segurado || '?').slice(0, 32).padEnd(32)} | ${(c.cpf_ccb || '?').padEnd(24)} | parceiro="${c.parceiro_bruto || '(vazio)'}" | ${brl(c.valor_a_pagar_planilha)}`);
    }
  }

  // --- DIVERGÊNCIA CATÁLOGO x PLANILHA (parcelas cobertas / teto) ---
  const diverg = casos.filter(c => c.divergencia_produto);
  if (diverg.length) {
    L('');
    L(`  ===== DIVERGENCIA CATALOGO x PLANILHA (${diverg.length}) — conferir manualmente =====`);
    for (const c of diverg) {
      L(`    ${(c.parceiro || '—').padEnd(18)} | ${(c.segurado || '?').slice(0, 28).padEnd(28)} | ${c.divergencia_produto}`);
    }
    L('    (o motor usou o valor do CATALOGO; a coluna da planilha so foi comparada)');
  }

  // --- Dump bruto de linhas pedidas via --linhas ---
  if (aba.debug && aba.debug.length) {
    L('');
    L(`  ===== CONTEUDO BRUTO DAS LINHAS SOLICITADAS (--linhas) =====`);
    let vaziasSeguidas = 0;
    for (const d of aba.debug) {
      if (d.vazia) { vaziasSeguidas++; L(`    L${String(d.excelRow).padStart(4)}: (linha totalmente VAZIA)`); }
      else { vaziasSeguidas = 0; L(`    L${String(d.excelRow).padStart(4)}: ${d.celulas.join('  ')}`); }
    }
    const totalVazias = aba.debug.filter(d => d.vazia).length;
    L(`    -> ${totalVazias} de ${aba.debug.length} linhas solicitadas estao TOTALMENTE vazias; ${aba.debug.length - totalVazias} tem algum conteudo.`);
  }

  L('');
  L('  --------------- RESUMO ---------------');
  L(`  Linhas lidas ...................... ${resultado.totalLinhas}`);
  L(`  Linhas ignoradas (sem identidade) . ${resultado.ignoradas}`);
  L(`  Pessoas / casos apos dedupe ....... ${casos.length}`);
  L(`  Casos marcados "A PAGAR" .......... ${aPagar.length}`);
  L(`  TOTAL A PAGAR (final) ............. ${brl(total)}`);

  const porParc = {};
  for (const c of aPagar) {
    const p = c.parceiro || '—';
    (porParc[p] = porParc[p] || { q: 0, v: 0 }).q++;
    porParc[p].v += Number(c.valor_a_pagar_final || 0);
  }
  L('');
  L('  Casos a pagar por parceiro:');
  for (const [p, o] of Object.entries(porParc).sort((a, b) => b[1].v - a[1].v)) {
    L(`    - ${p.padEnd(22)} ${String(o.q).padStart(4)} caso(s)   ${brl(o.v)}`);
  }

  if (resultado.avisos.length) {
    L('');
    L(`  --------------- AVISOS (${resultado.avisos.length}) ---------------`);
    for (const a of resultado.avisos.slice(0, 80)) L('  - ' + a);
    if (resultado.avisos.length > 80) L(`  ... e mais ${resultado.avisos.length - 80}.`);
  }

  L('');
  L('  Amostra (8 primeiros casos):');
  for (const c of casos.slice(0, 8)) {
    L(`    ${(c.segurado || c.cpf_ccb || '?').slice(0, 26).padEnd(26)} | ${(c.parceiro || '—').padEnd(18)} | ` +
      `parc.cob=${String(c.numero_parcelas_cobertas_produto == null ? '—' : c.numero_parcelas_cobertas_produto).padStart(2)} | ` +
      `pagar=${c.casos_a_pagar ? 'SIM' : 'nao'} | final=${brl(c.valor_a_pagar_final)}`);
  }
  L('======================================================================');
  L('');
}

function confirmar() {
  if (opcoes.sim) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Isto APAGA os dados atuais de `casos` e recarrega com a planilha. Digite IMPORTAR para confirmar: ', resp => {
      rl.close();
      resolve(String(resp).trim().toUpperCase() === 'IMPORTAR');
    });
  });
}

// ----------------------------------------------------------------------------
(async () => {
  try {
    const aba = lerAba();
    const resultado = transformar(aba.mapa, aba.linhas, {
      liberarProgramadosTodos: opcoes.liberarProgTodos,
      liberadosChaves
    });
    const casos = resultado.casos.map(aplicarMotor);
    relatorio(aba, resultado, casos);

    if (opcoes.dryRun) {
      console.log('DRY-RUN: nada gravado. Revise acima e rode sem --dry-run para importar.');
      await pool.end();
      process.exit(0);
    }

    const faltando = ['segurado', 'cpf_ccb', 'parceiro', 'casos_a_pagar'].filter(c => aba.mapa[c] === undefined);
    if (faltando.length) {
      console.error(`Abortado: colunas essenciais nao encontradas (${faltando.join(', ')}).`);
      await pool.end();
      process.exit(1);
    }
    if (!(await confirmar())) {
      console.log('Cancelado. Nada foi alterado.');
      await pool.end();
      process.exit(0);
    }

    const { n, nLinhas } = await gravar(casos);
    console.log(`OK - Importacao concluida: ${n} caso(s) em \`casos\`, ${nLinhas} linha(s) em \`linhas_planilha\`.`);
    await pool.end();
    process.exit(0);
  } catch (erro) {
    console.error('\nErro na importacao: ' + erro.message);
    if (erro.stack) console.error(erro.stack.split('\n').slice(1, 4).join('\n'));
    try { await pool.end(); } catch (e) {}
    process.exit(1);
  }
})();
