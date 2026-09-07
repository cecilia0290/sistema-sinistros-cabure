// ============================================================================
// Importador de PAGAMENTOS JÁ REALIZADOS  ->  tabela `pagamentos_confirmados`
// ----------------------------------------------------------------------------
//   node importar-pagamentos.js <pasta | arquivo.zip> [--metlife <arquivo.xlsx>]
//                               [--dry-run] [--sim] [--append]
//
//   <pasta | zip> : a árvore de comprovantes/planilhas de pagamento, organizada
//                   em subpastas por parceiro (SETHI, POUPACRED - GPC,
//                   INVEST ALL, RESGATA - GUARDIAN, NOVA PROMOTORA - LA VIE,
//                   X AO CUBO - X3, FINTECH CORBAN, 4 CASOS INDIVIDUAIS, ...).
//   --metlife     : planilha .xlsx separada com os pagamentos feitos pela MetLife.
//   --dry-run     : lê e mostra o relatório SEM tocar no banco (faça sempre antes).
//   --append      : NÃO trunca a tabela; só acrescenta (padrão = trunca e recarrega).
//   --sim / -y    : pula a confirmação interativa.
//
// O que ele grava por linha:  ccb (normalizado), ccb_bruto, segurado, parceiro,
// valor_pago, data_pagamento, fonte_arquivo.  Depois disto, rode de novo
// `node importar-planilha.js <planilha-mae.xlsx> --dry-run`: a classificação vai
// marcar como JÁ PAGO todo caso cujo CCB apareça aqui.
//
// LEITURA DOS ARQUIVOS
//   .xlsx/.xls/.csv : detecta a linha de cabeçalho e as colunas (CCB, segurado,
//                     valor, data) por aproximação — tolerante a acento/caixa.
//   .pdf            : extrai o texto e tenta achar CCB / valor / data por regex
//                     (1 comprovante = 1 pagamento). PDF escaneado sem texto é
//                     listado como "NÃO LIDO — mapear à mão".
//   Todo arquivo que não puder ser lido entra no relatório para conferência.
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const { PDFParse } = require('pdf-parse');
const pool = require('./db');
const P = require('./planilha-parse');
const { normalizarCcb } = require('./identidade');
const { normalizarParceiro } = require('./regras');

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
const args = process.argv.slice(2);
const opcoes = { entrada: null, metlife: null, dryRun: false, sim: false, append: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run' || a === '--dryrun') opcoes.dryRun = true;
  else if (a === '--sim' || a === '-y') opcoes.sim = true;
  else if (a === '--append') opcoes.append = true;
  else if (a === '--metlife') opcoes.metlife = args[++i];
  else if (!a.startsWith('--') && !opcoes.entrada) opcoes.entrada = a;
}
if (require.main === module && !opcoes.entrada && !opcoes.metlife) {
  console.error('Uso: node importar-pagamentos.js <pasta | arquivo.zip> [--metlife <arquivo.xlsx>] [--dry-run] [--sim] [--append]');
  process.exit(1);
}

const EXT_PLANILHA = ['.xlsx', '.xls', '.csv'];
const EXT_PDF = ['.pdf'];
const EXT_OK = [...EXT_PLANILHA, ...EXT_PDF];

// Arquivos que NÃO representam pagamento QUITADO — não entram na tabela:
//  - "pagos a menor" / "levantamento": pago só parte (falta complementar) — o caso
//    continua devendo saldo, não pode virar JÁ PAGO.
const IGNORAR_NOME = /pagos?\s*a\s*menor|levantamento_pagos/i;

// ----------------------------------------------------------------------------
// Parceiro a partir do nome da pasta
// ----------------------------------------------------------------------------
function parceiroDaPasta(nomePasta) {
  const k = P.semAcento(String(nomePasta || '').toUpperCase());
  if (/\bSETHI\b/.test(k)) return 'SETHI';
  if (/POUPACRED|\bGPC\b/.test(k)) return 'POUPACRED';
  if (/INVEST ?ALL/.test(k)) return 'Invest All';
  if (/RESGATA/.test(k)) return 'Resgata Ai';
  if (/\bNOVA\b/.test(k)) return 'Nova';
  if (/X ?AO ?CUBO|\bX ?3\b/.test(k)) return 'X3';
  if (/FINTECH|CORBAN/.test(k)) return 'Fintech do Corban';
  if (/GRANATECH|GRANA ?TECH/.test(k)) return 'Granatech';
  if (/INDIVIDU/.test(k)) return null;            // "4 CASOS INDIVIDUAIS"
  const canon = normalizarParceiro(nomePasta);
  return canon || null;
}

// ----------------------------------------------------------------------------
// Classificação de cabeçalhos das planilhas de pagamento
// ----------------------------------------------------------------------------
function classificarColuna(hn, parceiro) {
  if (!hn) return null;
  const tem = (...ts) => ts.some(t => hn.includes(t));
  if (hn === 'ccb' || tem('ccb', 'cedula', 'n contrato', 'numero contrato', 'nº contrato',
       'contrato n', 'operacao', 'proposta', 'emprestimo')) return 'ccb';
  if (tem('valor pago', 'vlr pago', 'valor do pagamento', 'valor liquido', 'valor pagamento',
       'valor parcela', 'parcela do mes', 'valor a pagar', 'valor devido')) return 'valor';
  if (tem('data pagamento', 'data do pagamento', 'data pgto', 'dt pagamento', 'data credito',
       'data de credito', 'liquidacao', 'pago em', 'data de pagamento')) return 'data';
  if (tem('segurado', 'favorecido', 'beneficiario', 'sinistrado') || hn === 'nome' || hn === 'cliente' || hn === 'nome do segurado') return 'segurado';
  if (tem('parceiro', 'correspondente', 'promotora')) return 'parceiro';
  if (tem('cpf') && parceiro === 'SETHI') return 'ccb';    // SETHI usa o nº interno na coluna "CPF"
  if (hn === 'valor' || hn === 'vlr' || hn === 'valor r' || tem('valor (r')) return 'valor';
  if (hn === 'data' || (tem('data ') && !tem('evento', 'contrat', 'admiss', 'nasc'))) return 'data';
  return null;
}

// Nome canônico de parceiro numa linha de "seção" (ex.: "SETHI (140 casos)").
function parceiroDeSecao(txt) {
  const k = P.semAcento(String(txt || '').toUpperCase());
  if (!k || k.length > 60) return null;
  if (/^SETHI\b/.test(k)) return 'SETHI';
  if (/^POUPACRED\b/.test(k)) return 'POUPACRED';
  if (/^INVEST ?ALL\b/.test(k)) return 'Invest All';
  if (/^RESGATA\b/.test(k)) return 'Resgata Ai';
  if (/^NOVA( PROMOTORA)?\b/.test(k)) return 'Nova';
  if (/^X ?3\b|^X AO CUBO\b/.test(k)) return 'X3';
  if (/^FINTECH|CORBAN\b/.test(k)) return 'Fintech do Corban';
  if (/^GRANATECH\b/.test(k)) return 'Granatech';
  return null;
}

// Lê TODAS as abas do workbook. Dentro de cada aba pode haver várias tabelas
// empilhadas com títulos/seções entre elas; a linha "SEGURADO | CCB | VALOR..."
// é o cabeçalho real. Uma linha só de texto na 1ª coluna (CCB vazio) que
// nomeie um parceiro vira a "seção" corrente (arquivos MetLife SETHI+POUPACRED).
// -> { linhas:[{ccb_bruto,ccb,segurado,valor_pago,data_pagamento,parceiro}], colunas, abas } | null
function lerPlanilhaPagamentos(caminho, parceiroPasta) {
  const wb = XLSX.readFile(caminho, { cellDates: true, cellNF: false, cellText: true });
  const linhas = [];
  const colunasUsadas = new Set();
  const abasComDados = [];

  for (const nomeAba of wb.SheetNames) {
    const ws = wb.Sheets[nomeAba];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cel = (r, c) => {
      const x = ws[XLSX.utils.encode_cell({ r, c })];
      if (!x) return null;
      if (x.t === 'n' && typeof x.v === 'number') return x.v;
      if (x.t === 'd' && x.v instanceof Date) return x.w || x.v.toISOString().slice(0, 10);
      return (x.w !== undefined && String(x.w).trim() !== '') ? x.w : (x.v == null ? null : x.v);
    };
    const ehCabecalho = (r) => {
      const m = {};
      let n = 0;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const campo = classificarColuna(P.normHeader(cel(r, c)), parceiroPasta);
        if (campo && m[campo] === undefined) { m[campo] = c; n++; }
      }
      return (m.ccb !== undefined && n >= 2) ? m : null;
    };

    let mapa = null;
    let secao = null;
    let antesDoPrimeiro = 0;
    for (let r = range.s.r; r <= range.e.r; r++) {
      if (!mapa) {
        const m = ehCabecalho(r);
        if (m) { mapa = m; continue; }
        if (++antesDoPrimeiro > 60) break;      // aba sem cabeçalho reconhecível
        const s = parceiroDeSecao(cel(r, range.s.c));
        if (s) secao = s;
        continue;
      }
      // já temos cabeçalho: cada linha ou é dado (tem CCB), ou re-cabeçalho, ou seção
      const reHdr = ehCabecalho(r);
      if (reHdr) { mapa = reHdr; continue; }
      const ccbBruto = cel(r, mapa.ccb);
      const ccb = normalizarCcb(ccbBruto);
      if (!ccb || ccb.length < 4 || ccb.length > 16) {
        const s = parceiroDeSecao(cel(r, range.s.c));
        if (s) secao = s;
        continue;
      }
      const parceiroLinha = mapa.parceiro !== undefined
        ? (normalizarParceiro(cel(r, mapa.parceiro)) || null) : null;
      linhas.push({
        ccb_bruto: ccbBruto == null ? null : String(ccbBruto).trim(),
        ccb,
        segurado: mapa.segurado === undefined ? null : (P.vazio(cel(r, mapa.segurado)) ? null : String(cel(r, mapa.segurado)).trim().replace(/\s+/g, ' ')),
        valor_pago: mapa.valor === undefined ? null : P.parseValor(cel(r, mapa.valor)),
        data_pagamento: mapa.data === undefined ? null : P.parseData(cel(r, mapa.data)),
        parceiro: parceiroLinha || secao || null
      });
      Object.keys(mapa).forEach(k => colunasUsadas.add(k));
    }
    if (mapa) abasComDados.push(nomeAba);
  }
  if (!linhas.length) return null;
  return { linhas, colunas: [...colunasUsadas], abas: abasComDados };
}

// PDFs do zip são RECIBOS BANCÁRIOS de transferência em lote (PIX Banrisul):
// "Recibo de Pagamento / NSU / Valor: R$ ... / Nome: <parceiro>". NÃO trazem
// CCB nem a lista de segurados — servem só para conferir os TOTAIS, não
// alimentam pagamentos_confirmados.
async function lerPdfPagamento(caminho) {
  const buf = fs.readFileSync(caminho);
  let texto = '';
  try { texto = (await new PDFParse({ data: buf }).getText()).text || ''; }
  catch (e) { texto = ''; }
  if (texto.trim().length < 20) return { tipo: 'sem-texto' };

  const t = P.semAcento(texto);
  const ehRecibo = /recibo de pagamento|situacao da operacao|\bNSU\b|id transacao/i.test(t);
  const mValor = t.match(/valor:?\s*R\$\s*([\d.]+,\d{2})/i) || t.match(/R\$\s*([\d.]+,\d{2})/);
  const mData = t.match(/data:?\s*(\d{2}[/.\-]\d{2}[/.\-]\d{2,4})/i) || t.match(/\b(\d{2}[/.\-]\d{2}[/.\-]\d{4})\b/);
  const mDest = t.match(/nome:\s*([^\n]{3,60})/i);
  const mDesc = t.match(/descricao:\s*([^\n]{3,80})/i);
  return {
    tipo: ehRecibo ? 'recibo-banco' : 'pdf-outro',
    valor: mValor ? P.parseValor(mValor[1]) : null,
    data: mData ? P.parseData(mData[1]) : null,
    destinatario: mDest ? mDest[1].trim() : null,
    descricao: mDesc ? mDesc[1].trim() : null
  };
}

// ----------------------------------------------------------------------------
// Coleta dos arquivos (pasta na árvore, ou .zip)
// ----------------------------------------------------------------------------
function listarArquivosDaPasta(raiz) {
  const out = [];
  (function anda(dir) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      const st = fs.statSync(p);
      if (st.isDirectory()) anda(p);
      else if (EXT_OK.includes(path.extname(nome).toLowerCase())) out.push(p);
    }
  })(raiz);
  return out.map(p => ({ caminho: p, rel: path.relative(raiz, p).replace(/\\/g, '/') }));
}

function extrairZipParaTemp(caminhoZip) {
  const destino = path.join('uploads', 'pgtos-' + Date.now());
  fs.mkdirSync(destino, { recursive: true });
  new AdmZip(caminhoZip).extractAllTo(destino, true);
  return destino;
}

// parceiro = o segmento do caminho que casa com um parceiro conhecido (ignora
// pastas-invólucro tipo "JA PAGOS"). Testa do mais fundo para o mais raso.
function parceiroDoCaminho(rel) {
  const partes = rel.split('/').filter(Boolean);
  partes.pop(); // tira o nome do arquivo
  for (let i = partes.length - 1; i >= 0; i--) {
    const p = parceiroDaPasta(partes[i]);
    if (p) return p;
    if (/INDIVIDU/.test(P.semAcento(partes[i].toUpperCase()))) return null; // pasta de individuais, reconhecida
  }
  return null;
}

// ----------------------------------------------------------------------------
// Gravação
// ----------------------------------------------------------------------------
const COLS = ['ccb', 'ccb_bruto', 'segurado', 'parceiro', 'valor_pago', 'data_pagamento', 'fonte_arquivo', 'observacao'];
const corta = (s, n) => (s == null ? null : String(s).slice(0, n));

async function gravar(registros) {
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION');
    if (!opcoes.append) await conn.query('TRUNCATE TABLE pagamentos_confirmados');
    const ph = '(' + COLS.map(() => '?').join(',') + ')';
    for (let i = 0; i < registros.length; i += 200) {
      const lote = registros.slice(i, i + 200);
      await conn.query(
        `INSERT INTO pagamentos_confirmados (${COLS.join(',')}) VALUES ${lote.map(() => ph).join(',')}`,
        lote.flatMap(r => [
          r.ccb, corta(r.ccb_bruto, 120), corta(r.segurado, 200), corta(r.parceiro, 120),
          r.valor_pago ?? null, r.data_pagamento || null, corta(r.fonte_arquivo, 255), corta(r.observacao, 255)
        ])
      );
    }
    await conn.query('COMMIT');
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

function confirmar() {
  if (opcoes.sim) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const aviso = opcoes.append ? 'ACRESCENTA à' : 'APAGA e recarrega a';
  return new Promise(res => {
    rl.question(`Isto ${aviso} tabela pagamentos_confirmados. Digite IMPORTAR para confirmar: `, r => {
      rl.close(); res(String(r).trim().toUpperCase() === 'IMPORTAR');
    });
  });
}

// Coleta (sem tocar no banco) os pagamentos de uma árvore/zip + planilha MetLife.
// Usada pelo próprio importador e por scripts de simulação.
// -> { unicos, registros, naoLidos, porFonte, recibos, limpar() }
async function coletarPagamentos({ entrada, metlife } = {}) {
  const registros = [];
  const naoLidos = [];
  const porFonte = [];
  const recibos = [];
  let tempZip = null;

  const arquivos = [];
  if (entrada) {
    if (!fs.existsSync(entrada)) throw new Error('Não encontrei: ' + entrada);
    if (path.extname(entrada).toLowerCase() === '.zip') {
      tempZip = extrairZipParaTemp(entrada);
      arquivos.push(...listarArquivosDaPasta(tempZip));
    } else if (fs.statSync(entrada).isDirectory()) {
      arquivos.push(...listarArquivosDaPasta(entrada));
    } else {
      arquivos.push({ caminho: entrada, rel: path.basename(entrada) });
    }
  }

  for (const { caminho, rel } of arquivos) {
    const ext = path.extname(caminho).toLowerCase();
    const parceiroPasta = parceiroDoCaminho(rel);
    if (IGNORAR_NOME.test(path.basename(rel))) {
      naoLidos.push({ fonte: rel, motivo: 'IGNORADO — pagamento parcial (pago a menor); o caso ainda deve saldo, não vira JÁ PAGO' });
      continue;
    }
    try {
      if (EXT_PLANILHA.includes(ext)) {
        const r = lerPlanilhaPagamentos(caminho, parceiroPasta);
        if (!r) { naoLidos.push({ fonte: rel, motivo: 'planilha sem coluna de CCB (casaria só por nome)' }); continue; }
        for (const l of r.linhas) registros.push({ ...l, parceiro: l.parceiro || parceiroPasta || null, fonte_arquivo: rel });
        porFonte.push({ fonte: rel, parceiro: parceiroPasta, n: r.linhas.length, cols: r.colunas.join('+') });
      } else if (EXT_PDF.includes(ext)) {
        const r = await lerPdfPagamento(caminho);
        if (r.tipo === 'sem-texto') { naoLidos.push({ fonte: rel, motivo: 'PDF sem texto (escaneado)' }); continue; }
        recibos.push({ fonte: rel, parceiro: parceiroPasta, ...r });
      }
    } catch (e) {
      naoLidos.push({ fonte: rel, motivo: e.message });
    }
  }

  if (metlife) {
    if (!fs.existsSync(metlife)) throw new Error('Não encontrei o --metlife: ' + metlife);
    const r = lerPlanilhaPagamentos(metlife, null);
    const fonte = 'MetLife: ' + path.basename(metlife);
    if (!r) {
      naoLidos.push({ fonte, motivo: 'planilha sem coluna de CCB (keyed por nº de processo + nome — casaria só por nome)' });
    } else {
      for (const l of r.linhas) registros.push({ ...l, parceiro: l.parceiro || null, fonte_arquivo: fonte, observacao: 'pagamento MetLife' });
      porFonte.push({ fonte, parceiro: 'MetLife', n: r.linhas.length, cols: r.colunas.join('+') });
    }
  }

  const vistos = new Set();
  const unicos = [];
  for (const r of registros) {
    const k = [r.ccb, r.data_pagamento || '', r.valor_pago ?? ''].join('|');
    if (vistos.has(k)) continue;
    vistos.add(k); unicos.push(r);
  }

  return {
    unicos, registros, naoLidos, porFonte, recibos,
    limpar: () => { if (tempZip) { try { fs.rmSync(tempZip, { recursive: true, force: true }); } catch (_) {} } }
  };
}

module.exports = { coletarPagamentos, lerPlanilhaPagamentos, lerPdfPagamento, parceiroDaPasta, parceiroDoCaminho };

// ----------------------------------------------------------------------------
if (require.main === module) (async () => {
  const brl = n => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  let limpar = () => {};

  try {
    const col = await coletarPagamentos({ entrada: opcoes.entrada, metlife: opcoes.metlife });
    const { unicos, registros, naoLidos, porFonte, recibos } = col;
    limpar = col.limpar;

    // ----- Relatório -----
    const L = console.log;
    L('\n======================================================================');
    L('  IMPORTACAO DE PAGAMENTOS CONFIRMADOS' + (opcoes.dryRun ? '   [DRY-RUN - nada gravado]' : ''));
    L('======================================================================');
    L(`  Arquivos lidos ............. ${porFonte.length}`);
    L(`  Linhas de pagamento ....... ${unicos.length}${unicos.length !== registros.length ? `  (${registros.length - unicos.length} duplicatas exatas removidas)` : ''}`);
    L(`  Arquivos NAO lidos ........ ${naoLidos.length}`);

    const porParc = {};
    for (const r of unicos) {
      const p = r.parceiro || '(individual / sem parceiro)';
      (porParc[p] = porParc[p] || { ccbs: new Set(), soma: 0, semValor: 0 });
      porParc[p].ccbs.add(r.ccb);
      if (r.valor_pago == null) porParc[p].semValor++;
      else porParc[p].soma += Number(r.valor_pago);
    }
    L('\n  ---------- PAGAMENTOS por PARCEIRO ----------');
    L('    parceiro                         CCBs distintos     soma paga   (linhas sem valor)');
    let totCcb = 0, totSoma = 0;
    for (const [p, o] of Object.entries(porParc).sort((a, b) => b[1].soma - a[1].soma)) {
      totCcb += o.ccbs.size; totSoma += o.soma;
      L(`    ${p.padEnd(32)} ${String(o.ccbs.size).padStart(10)}   ${brl(o.soma).padStart(14)}   ${o.semValor ? '(' + o.semValor + ')' : ''}`);
    }
    L(`    ${'-'.repeat(32)} ${'-'.repeat(10)}   ${'-'.repeat(14)}`);
    L(`    ${'TOTAL'.padEnd(32)} ${String(totCcb).padStart(10)}   ${brl(totSoma).padStart(14)}`);

    L('\n  ---------- por ARQUIVO (linhas com CCB extraidas) ----------');
    for (const f of porFonte) L(`    ${String(f.n).padStart(4)} linha(s)  [${(f.parceiro || '—')}]  ${f.fonte}   (${f.cols})`);

    if (recibos.length) {
      L('\n  ---------- RECIBOS BANCARIOS (PIX em lote — sem CCB, so conferem TOTAIS) ----------');
      let somaRec = 0;
      for (const x of recibos.sort((a, b) => (a.data || '').localeCompare(b.data || ''))) {
        if (x.valor) somaRec += Number(x.valor);
        L(`    ${(x.data || '????-??-??')}  ${brl(x.valor).padStart(14)}  ${(x.parceiro || '—').padEnd(16)} ${x.descricao || x.destinatario || ''}`);
      }
      L(`    ${' '.repeat(12)} ${brl(somaRec).padStart(14)}  (soma dos recibos)`);
      L('    -> estes PDFs NAO entram na tabela; use-os so para bater o total pago com o parceiro.');
    }

    if (naoLidos.length) {
      L('\n  ---------- ARQUIVOS NAO LIDOS ----------');
      for (const x of naoLidos) L(`    - ${x.fonte}\n        ${x.motivo}`);
    }

    // amostra
    L('\n  Amostra (10 primeiras linhas):');
    for (const r of unicos.slice(0, 10)) {
      L(`    ${(r.parceiro || '—').padEnd(16)} | CCB ${String(r.ccb).padEnd(14)} | ${brl(r.valor_pago).padStart(12)} | ${r.data_pagamento || '—'} | ${(r.segurado || '').slice(0, 28)}`);
    }
    L('======================================================================\n');

    if (opcoes.dryRun) {
      L('DRY-RUN: nada gravado. Revise acima e rode sem --dry-run para importar.');
      L('Depois: node importar-planilha.js "<planilha-mae>.xlsx" --dry-run  (o A PAGAR vai cair).');
    } else {
      if (!unicos.length) { L('Nada para gravar.'); }
      else if (!(await confirmar())) { L('Cancelado. Nada foi alterado.'); }
      else {
        await gravar(unicos);
        L(`OK - ${unicos.length} linha(s) em pagamentos_confirmados (${opcoes.append ? 'acrescentadas' : 'tabela recarregada'}).`);
        L('Agora rode: node importar-planilha.js "<planilha-mae>.xlsx" --dry-run');
      }
    }
  } catch (e) {
    console.error('\nErro: ' + e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exitCode = 1;
  } finally {
    limpar();
    try { await pool.end(); } catch (_) {}
  }
})();
