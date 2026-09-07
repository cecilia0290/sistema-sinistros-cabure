// ============================================================================
// Parsers puros da planilha mãe (sem dependência de xlsx / banco).
// Separado do importador para poder ser testado isoladamente.
// ============================================================================

function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normHeader(s) {
  return semAcento(String(s == null ? '' : s).toLowerCase())
    .replace(/[º°ª]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function vazio(v) {
  return v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '-';
}

// "1.234,56" -> 1234.56 ; "R$ 1.000" -> 1000 ; 1234.5 -> 1234.5 ; "" -> null
function parseValor(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  let s = String(v).trim().replace(/r\$/i, '').replace(/\s/g, '');
  if (!s || s === '-') return null;
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');
  if (temVirgula && temPonto) s = s.replace(/\./g, '').replace(',', '.'); // pt-BR
  else if (temVirgula) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const MESES_PT = {
  // abreviações em português
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  // abreviações em inglês (a planilha mistura "Feb-26", "Sep-26" etc.)
  feb: 2, apr: 4, may: 5, aug: 8, sep: 9, oct: 10, dec: 12
};

// serial do Excel (dias desde 1899-12-30) -> Date UTC
function serialParaData(n) {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  return new Date(Math.round((n - 25569) * 86400 * 1000));
}

function fmtData(ano, mes, dia) {
  if (!ano || !mes || !dia) return null;
  const a = String(ano).padStart(4, '0');
  const m = String(mes).padStart(2, '0');
  const d = String(dia).padStart(2, '0');
  if (a === '0000' || m === '00' || d === '00' || +m > 12 || +d > 31) return null;
  return `${a}-${m}-${d}`;
}

// Date | serial Excel | "DD/MM/AAAA" | "AAAA-MM-DD" | "03 mar 2025"  ->  'AAAA-MM-DD' | null
function parseData(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return fmtData(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') {
    const d = serialParaData(v);
    return d ? fmtData(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) : null;
  }
  let s = String(v).trim();
  if (!s || s === '-') return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return fmtData(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let ano = +m[3];
    if (ano < 100) ano += ano < 50 ? 2000 : 1900;
    return fmtData(ano, +m[2], +m[1]);
  }

  m = semAcento(s).toLowerCase().match(/^(\d{1,2})[ ./-]+([a-z]{3,})[ ./-]+(\d{2,4})/);
  if (m && MESES_PT[m[2].slice(0, 3)]) {
    let ano = +m[3];
    if (ano < 100) ano += ano < 50 ? 2000 : 1900;
    return fmtData(ano, MESES_PT[m[2].slice(0, 3)], +m[1]);
  }

  const serial = Number(s);
  if (Number.isFinite(serial)) {
    const d = serialParaData(serial);
    if (d) return fmtData(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

// -> 'AAAA-MM' | null   (aceita "mar/2025", "03/2025", "Março 2025", data completa, serial)
function parseMesAno(v) {
  if (v === null || v === undefined || v === '') return null;
  const comoData = parseData(v);
  if (comoData) return comoData.slice(0, 7);

  let s = semAcento(String(v).trim().toLowerCase());
  if (!s || s === '-') return null;

  let m = s.match(/^(\d{4})[-/. ](\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;

  m = s.match(/^(\d{1,2})[-/. ](\d{2,4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) {
    let ano = +m[2];
    if (ano < 100) ano += ano < 50 ? 2000 : 1900;
    return `${ano}-${String(+m[1]).padStart(2, '0')}`;
  }

  m = s.match(/([a-z]{3,})[a-z]*[-/. ]+(\d{2,4})/);
  if (m && MESES_PT[m[1].slice(0, 3)]) {
    let ano = +m[2];
    if (ano < 100) ano += ano < 50 ? 2000 : 1900;
    return `${ano}-${String(MESES_PT[m[1].slice(0, 3)]).padStart(2, '0')}`;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Classificação da coluna "CASOS A PAGAR" — é ELA que decide o pagamento
// (a coluna STATUS é só etiqueta). Casa por PREFIXO: sem acento, MAIÚSCULAS,
// ignorando TODOS os espaços. Ordem: do mais específico para o mais genérico.
// ----------------------------------------------------------------------------
const CATEGORIA_ROTULO = {
  A_PAGAR: 'A PAGAR',
  AGUARDANDO_FRANQUIA: 'AGUARDANDO FIM DA FRANQUIA',
  AGUARDANDO_DOCUMENTACAO: 'AGUARDANDO DOCUMENTAÇÃO',
  PROGRAMADO: 'PROGRAMADO - CONFIRMAR SE JÁ FOI PAGO',
  PARCEIRO_NAO_IDENTIFICADO: 'AGUARDANDO REGRA DE PRODUTO / PARCEIRO NÃO IDENTIFICADO',
  JA_PAGO: 'JÁ PAGO',
  NAO_PAGAR: 'NÃO PAGAR',
  PENDENTE: 'PENDENTE DE CLASSIFICAÇÃO',
  NAO_RECONHECIDO: 'NÃO RECONHECIDO',
  // Overrides do CASO (não vêm da coluna CASOS A PAGAR — ver planilha-transform.js):
  JA_PAGO_CONFIRMADO: 'JÁ PAGO (comprovante)',        // (legado) mantido p/ compat.
  JA_PAGO_COMPLETO: 'JÁ PAGO (completo)',             // todas as parcelas cobertas já pagas
  A_PAGAR_PROXIMA_PARCELA: 'A PAGAR — próxima parcela', // pagou N de M; falta(m) parcela(s)
  BLOQUEADO_REEMPREGO: 'BLOQUEADO - REEMPREGO',        // fora de cobertura, tratado à mão
  AGUARDANDO_VALOR_MANUAL: 'AGUARDANDO VALOR MANUAL'   // avulso: falta o valor, preencher à mão
};

// -> { categoria, rotulo, aPagar, franquiaAte, programadoPara, avisar, bruto }
//    aPagar  = conta como "a pagar agora" (só categoria A_PAGAR)
//    avisar  = valor realmente inesperado (só categoria NAO_RECONHECIDO)
function parseCasosAPagar(v) {
  const bruto = v === null || v === undefined ? '' : String(v).trim();
  const s = semAcento(bruto);                                // sem acento, preservando espaços/caixa
  const k = s.toUpperCase().replace(/\s+/g, '');             // sem acento, MAIÚSC, SEM espaços
  const dataDepoisDe = (re) => { const m = s.match(re); return m ? parseData(m[1]) : null; };

  let categoria;
  let franquiaAte = null;
  let programadoPara = null;

  if (k === '') {
    categoria = 'PENDENTE';
  } else if (k.startsWith('PAGAR') || ['SIM', 'S', 'X', '1', 'OK', 'TRUE', 'APAGAR'].includes(k)) {
    categoria = 'A_PAGAR';                                   // formato legado
  } else if (k.startsWith('ELEGIVEL-PROGRAMADOPARAPAGAMENTO') || k.startsWith('ELEGIVEL-PROGRAMADO')) {
    categoria = 'PROGRAMADO';                                // NÃO paga automático — confere se já foi pago
    programadoPara = dataDepoisDe(/pagamento\s+([0-9].*)$/i) || dataDepoisDe(/\bem\s+([0-9].*)$/i) || dataDepoisDe(/([0-9]{1,2}[/.\-][0-9]{1,2}[/.\-][0-9]{2,4})/);
  } else if (k.startsWith('ELEGIVEL-PRONTO')
          || k.startsWith('ELEGIVEL-CASOESPECIALAPROVADO')
          || k.startsWith('ELEGIVEL-CASOJAEMPAGAMENTO')) {
    categoria = 'A_PAGAR';
  } else if (k.startsWith('ELEGIVEL-FRANQUIAATE')) {
    categoria = 'AGUARDANDO_FRANQUIA';                       // "ELEGÍVEL - FRANQUIA ATÉ dd/mm/aaaa"
    franquiaAte = dataDepoisDe(/\bate\s+(.+)$/i);
  } else if (k.startsWith('ELEGIVEL-FRANQUIAAPARTIRDE') || k.startsWith('ELEGIVEL-FRANQUIAPARTIRDE')) {
    categoria = 'AGUARDANDO_FRANQUIA';                       // "ELEGÍVEL - FRANQUIA A PARTIR DE dd/mm/aaaa"
    franquiaAte = dataDepoisDe(/partir\s+de\s+(.+)$/i) || dataDepoisDe(/([0-9]{1,2}[/.\-][0-9]{1,2}[/.\-][0-9]{2,4})/);
  } else if (k.startsWith('LIBERADO')) {
    categoria = 'A_PAGAR';                                   // "LIBERADO - BASE LEGADA"
  } else if (k.startsWith('DEVIDO-PAGO') || k.startsWith('PAGO')) {
    categoria = 'JA_PAGO';
  } else if (k.startsWith('EMANALISE') || k.startsWith('AGUARDANDODOC')) {
    categoria = 'AGUARDANDO_DOCUMENTACAO';                   // "EM ANÁLISE" / "AGUARDANDO DOCUMENTAÇÃO"
  } else if (k.startsWith('NEGADO') || k.startsWith('NAOPAGAR') || ['NAO', 'N', '0', 'FALSE', '-'].includes(k)) {
    categoria = 'NAO_PAGAR';
  } else {
    categoria = 'NAO_RECONHECIDO';
  }

  return {
    categoria,
    rotulo: CATEGORIA_ROTULO[categoria],
    aPagar: categoria === 'A_PAGAR',
    franquiaAte,
    programadoPara,
    avisar: categoria === 'NAO_RECONHECIDO',
    bruto
  };
}

// ----------------------------------------------------------------------------
// Cabeçalho -> campo lógico
// ----------------------------------------------------------------------------
const ALIASES = {
  mes_ano_contratacao: ['mes ano contratacao', 'mes ano de contratacao', 'mes de contratacao', 'competencia', 'mes contratacao', 'mes ano'],
  cia: ['cia', 'companhia', 'seguradora'],
  segurado: ['segurado', 'nome do segurado', 'nome segurado', 'nome', 'cliente'],
  cpf_ccb: ['cpf ccb', 'cpf', 'ccb', 'cpf cnpj', 'documento', 'cpf ou ccb'],
  parceiro: ['parceiro', 'parceiro financeiro', 'correspondente'],
  fundo: ['fundo', 'fundo investidor', 'fundo instituicao', 'instituicao'],
  valor_parcela: ['valor parcela', 'valor da parcela', 'vlr parcela', 'parcela'],
  numero_parcelas_contratadas: ['n parcelas contratadas', 'numero de parcelas contratadas', 'qtd parcelas contratadas', 'parcelas contratadas', 'quantidade de parcelas', 'n de parcelas contratadas', 'qtde parcelas'],
  teto_parcela_produto: ['teto parcela produto', 'teto da parcela produto', 'teto parcela do produto', 'teto do produto'],
  numero_parcelas_cobertas_produto: ['n parcelas cobertas produto', 'numero de parcelas cobertas produto', 'parcelas cobertas produto', 'n de parcelas cobertas produto', 'qtd parcelas cobertas produto', 'parcelas cobertas do produto'],
  fonte_produto: ['fonte do produto', 'fonte produto', 'fonte do produto ccb anexo i'],
  cobertura: ['cobertura', 'tipo de cobertura', 'cobertura contratada'],
  valor_a_pagar: ['valor a pagar', 'vlr a pagar', 'valor pagar'],
  data_admissao: ['data admissao', 'data de admissao', 'admissao', 'dt admissao'],
  data_contratacao: ['data contratacao', 'data de contratacao', 'contratacao', 'dt contratacao', 'data da contratacao'],
  data_evento: ['data evento', 'data do evento', 'data de evento', 'evento', 'data desligamento', 'data do desligamento', 'data da rescisao', 'data rescisao', 'dt evento'],
  franquia: ['franquia', 'data franquia', 'fim da franquia', 'franquia ate', 'fim franquia', 'termino da franquia'],
  casos_a_pagar: ['casos a pagar', 'caso a pagar', 'casos apagar'],
  status: ['status', 'situacao'],
  motivo_desligamento_codigo: ['motivo', 'codigo motivo', 'cod motivo', 'motivo desligamento', 'codigo do motivo', 'motivo do desligamento', 'cod desligamento', 'codigo']
};

function classificarHeader(hn) {
  if (!hn) return null;
  for (const [campo, lista] of Object.entries(ALIASES)) {
    if (lista.includes(hn)) return campo;
  }
  const tem = (...ts) => ts.every(t => hn.includes(t));
  if (tem('mes') && hn.includes('contrat')) return 'mes_ano_contratacao';
  if (tem('data') && hn.includes('contrat')) return 'data_contratacao';
  if (tem('data') && (hn.includes('event') || hn.includes('deslig') || hn.includes('rescis'))) return 'data_evento';
  if (tem('data') && hn.includes('admiss')) return 'data_admissao';
  if (hn.includes('casos') && hn.includes('pagar')) return 'casos_a_pagar';
  if (hn.includes('valor') && hn.includes('pagar')) return 'valor_a_pagar';
  if (hn.includes('teto') && hn.includes('parcela')) return 'teto_parcela_produto';
  if (hn.includes('parcela') && hn.includes('cobert')) return 'numero_parcelas_cobertas_produto';
  if (hn.includes('fonte') && hn.includes('produto')) return 'fonte_produto';
  if (hn.includes('valor') && hn.includes('parcela')) return 'valor_parcela';
  if (hn.includes('parcela') && (hn.includes('contrat') || hn.includes('qtd') || hn.includes('numero') || hn.includes('quant'))) return 'numero_parcelas_contratadas';
  for (const [campo, lista] of Object.entries(ALIASES)) {
    if (lista.some(a => hn.startsWith(a) || a.startsWith(hn))) return campo;
  }
  for (const [campo, lista] of Object.entries(ALIASES)) {
    if (lista.some(a => hn.includes(a))) return campo;
  }
  return null;
}

module.exports = {
  semAcento, normHeader, vazio,
  parseValor, serialParaData, fmtData, parseData, parseMesAno, parseCasosAPagar,
  CATEGORIA_ROTULO, MESES_PT, ALIASES, classificarHeader
};
