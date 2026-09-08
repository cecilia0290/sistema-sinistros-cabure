// ============================================================================
// Extração de campos de documentos — 100% LOCAL, SEM API PAGA
// ----------------------------------------------------------------------------
//  - Dataprev (JSON/CSV): lê os campos direto do arquivo estruturado.
//  - CCB / TRCT (texto vindo de PDF digital ou de OCR Tesseract): regex por
//    parceiro + regex genérico pt-BR.
//  - Todo campo sai com um nível de confiança: alta | media | baixa | ausente.
//  - Faltou campo obrigatório ou confiança ruim  ->  precisaConferencia = true,
//    com o motivo dizendo QUAL campo. Nunca "chuta" nem deixa vazio calado.
//
// Os regex abaixo são um ponto de partida pt-BR. Para afinar por parceiro,
// edite REGRAS_EXTRACAO — cada entrada é uma lista de regex tentados em ordem;
// o 1º com captura vale, e o "peso" define a confiança.
// ============================================================================

const { normalizarParceiro } = require('./regras');
const { normalizarCpf } = require('./identidade');

const CAMPOS_OBRIGATORIOS = ['cpf_ccb', 'data_contratacao', 'data_evento'];

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------
function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function normLinha(s) {
  return semAcento(String(s || '').toLowerCase()).replace(/\s+/g, ' ').trim();
}

// "1.234,56" | "1234.56" | "R$ 1.000" -> Number
function valorBR(txt) {
  if (txt == null) return null;
  let s = String(txt).replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// "31/12/2025" | "2025-12-31" | "31 de dezembro de 2025" -> "AAAA-MM-DD"
const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
function dataISO(txt) {
  if (!txt) return null;
  const s = semAcento(String(txt).trim().toLowerCase());
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
  if (m) {
    let a = +m[3]; if (a < 100) a += a < 50 ? 2000 : 1900;
    return `${a}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  m = s.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  return null;
}

// ----------------------------------------------------------------------------
// Detecção do tipo de documento
// ----------------------------------------------------------------------------
function detectarTipo(nomeArquivo, texto, extensao) {
  const nome = normLinha(nomeArquivo);
  const t = normLinha(texto).slice(0, 4000);
  if (extensao === '.json' || extensao === '.csv') {
    if (/dataprev|cnis|vinculos e remuneracoes|extrato previdenciario/.test(t) || /dataprev|cnis/.test(nome)) return 'DATAPREV';
    return 'DATAPREV'; // JSON/CSV estruturado do parceiro
  }
  if (/termo de rescisao|trct|cod\.? afastamento|codigo do afastamento|homolognet/.test(t) || /trct|rescis/.test(nome)) return 'TRCT';
  if (/cedula de credito bancario|\bccb\b|valor da parcela|numero da cedula/.test(t) || /ccb|cedula/.test(nome)) return 'CCB';
  if (/dataprev|cnis/.test(t) || /dataprev|cnis/.test(nome)) return 'DATAPREV';
  return 'DESCONHECIDO';
}

// ----------------------------------------------------------------------------
// DATAPREV — JSON / CSV estruturado (sem OCR, sem regex "adivinhando")
// ----------------------------------------------------------------------------
const ALIASES_DATAPREV = {
  segurado:  ['nome', 'nomesegurado', 'nometrabalhador', 'nomecompleto', 'segurado'],
  cpf_ccb:   ['cpf', 'nrocpf', 'numcpf', 'cpftrabalhador'],
  data_admissao:   ['dataadmissao', 'dtadmissao', 'admissao', 'datainiciovinculo', 'dtiniciovinculo', 'iniciovinculo'],
  data_contratacao:['datacontratacao', 'dtcontratacao', 'datacontrato', 'dataemprestimo'],
  data_evento:     ['datadesligamento', 'dtdesligamento', 'desligamento', 'datafimvinculo', 'dtfimvinculo', 'fimvinculo',
                    'dataafastamento', 'dtafastamento', 'ultimodiatrabalhado', 'datarescisao'],
  motivo_desligamento_codigo: ['codigomotivodesligamento', 'codmotivodesligamento', 'motivodesligamento', 'codigoafastamento',
                    'codafastamento', 'motivoafastamento', 'causaafastamento', 'codmotivo', 'codigomotivo'],
  situacao_emprestimo: ['situacao', 'situacaocontrato', 'statuscontrato', 'situacaoemprestimo', 'statusemprestimo']
};

function acharChave(obj, alvos, prefixo, saida) {
  if (obj == null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const kn = semAcento(String(k).toLowerCase()).replace(/[^a-z0-9]/g, '');
    for (const [campo, lista] of Object.entries(alvos)) {
      if (saida[campo] !== undefined) continue;
      if (lista.includes(kn) && (typeof v === 'string' || typeof v === 'number')) saida[campo] = v;
    }
    if (v && typeof v === 'object') acharChave(v, alvos, prefixo + k + '.', saida);
  }
}

function lerCSV(texto) {
  const linhas = String(texto).split(/\r?\n/).filter(l => l.trim() !== '');
  if (linhas.length < 2) return [];
  const sep = (linhas[0].match(/;/g) || []).length >= (linhas[0].match(/,/g) || []).length ? ';' : ',';
  const cab = linhas[0].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
  return linhas.slice(1).map(l => {
    const cels = l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    const o = {};
    cab.forEach((c, i) => { o[c] = cels[i]; });
    return o;
  });
}

function extrairDataprev(texto) {
  const campos = {};
  const confianca = {};
  let fonte = 'Dataprev';
  try {
    const trim = texto.trim();
    let objetos = [];
    if (trim.startsWith('{') || trim.startsWith('[')) {
      const j = JSON.parse(trim);
      objetos = Array.isArray(j) ? j : [j];
      fonte = 'Dataprev (JSON)';
    } else {
      objetos = lerCSV(trim);
      fonte = 'Dataprev (CSV)';
    }
    // Usa o 1º objeto que tiver CPF; se nenhum, o primeiro.
    const alvo = objetos.find(o => JSON.stringify(o).match(/cpf/i)) || objetos[0] || {};
    const bruto = {};
    acharChave(alvo, ALIASES_DATAPREV, '', bruto);

    if (bruto.segurado != null) { campos.segurado = String(bruto.segurado).trim(); confianca.segurado = 'alta'; }
    if (bruto.cpf_ccb != null) {
      const cpf = normalizarCpf(bruto.cpf_ccb);
      if (cpf) { campos.cpf_ccb = cpf; confianca.cpf_ccb = 'alta'; }
    }
    for (const c of ['data_admissao', 'data_contratacao', 'data_evento']) {
      const iso = dataISO(bruto[c]);
      if (iso) { campos[c] = iso; confianca[c] = 'alta'; }
    }
    if (bruto.motivo_desligamento_codigo != null) {
      const cod = String(bruto.motivo_desligamento_codigo).replace(/\D/g, '');
      if (cod) { campos.motivo_desligamento_codigo = cod; confianca.motivo_desligamento_codigo = 'alta'; }
    }
    if (bruto.situacao_emprestimo != null) campos.situacao_emprestimo = String(bruto.situacao_emprestimo).trim();
  } catch (e) {
    return { campos: {}, confianca: {}, fonte: 'Dataprev (falha ao ler: ' + e.message + ')' };
  }
  return { campos, confianca, fonte };
}

// ----------------------------------------------------------------------------
// CCB / TRCT — texto (PDF digital ou OCR) + regex
// ----------------------------------------------------------------------------
// Cada campo: lista de { re, grupo, peso }.  peso: 2 = âncora forte (confiança
// alta), 1 = padrão frouxo (confiança média). Editar por parceiro em REGRAS_EXTRACAO.
const GENERICO = {
  cpf_ccb: [
    { re: /cpf[^\d]{0,20}(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/i, grupo: 1, peso: 2 },
    { re: /\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/, grupo: 1, peso: 1 }
  ],
  data_admissao: [
    { re: /admiss[aã]o[^\d]{0,25}(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/i, grupo: 1, peso: 2 },
    { re: /data\s+de\s+admiss[aã]o[^\d]{0,25}(\d{1,2}\s+de\s+[a-zç]+\s+de\s+\d{4})/i, grupo: 1, peso: 2 }
  ],
  data_contratacao: [
    { re: /(?:contrata[cç][aã]o|emiss[aã]o|libera[cç][aã]o)[^\d]{0,25}(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/i, grupo: 1, peso: 2 },
    { re: /data\s+do?\s+contrato[^\d]{0,25}(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/i, grupo: 1, peso: 2 }
  ],
  data_evento: [
    { re: /(?:desligamento|rescis[aã]o|afastamento|demiss[aã]o|dispensa)[^\d]{0,25}(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/i, grupo: 1, peso: 2 },
    { re: /(?:ultimo\s+dia\s+trabalhado|proje[cç][aã]o\s+do\s+aviso)[^\d]{0,25}(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/i, grupo: 1, peso: 1 }
  ],
  valor_parcela: [
    { re: /(?:valor\s+d[ao]\s+(?:parcela|presta[cç][aã]o))[^\d]{0,15}r?\$?\s*([\d.]+,\d{2})/i, grupo: 1, peso: 2 },
    { re: /parcela[^\d]{0,15}r\$\s*([\d.]+,\d{2})/i, grupo: 1, peso: 1 }
  ],
  numero_parcelas_contratadas: [
    { re: /(?:n[ºo.]?\s*de\s+parcelas|quantidade\s+de\s+parcelas|prazo)[^\d]{0,10}(\d{1,3})/i, grupo: 1, peso: 2 }
  ],
  teto_parcela_produto: [
    { re: /(?:limite|teto)\s+d[ao]\s+parcela[^\d]{0,15}r?\$?\s*([\d.]+,\d{2})/i, grupo: 1, peso: 2 }
  ],
  motivo_desligamento_codigo: [
    { re: /(?:c[oó]d(?:igo)?\.?\s*(?:do)?\s*(?:afastamento|motivo|deslig)[^\d]{0,10})(\d{1,2})\b/i, grupo: 1, peso: 2 },
    { re: /causa\s+do\s+afastamento[^\d]{0,10}(\d{1,2})\b/i, grupo: 1, peso: 2 }
  ]
};

// Sobrescreve/expande o GENERICO por parceiro (nome canônico de regras.js).
const REGRAS_EXTRACAO = {
  // 'SETHI': { valor_parcela: [ { re: /.../, grupo:1, peso:2 } ] },
  // 'Fintech do Corban': { ... },
  // 'POUPACRED': { ... },
  // 'Granatech': { ... },
  // 'Invest All': { ... },
  // 'LA VIE': { ... },
};

function detectarParceiro(texto) {
  const t = normLinha(texto).slice(0, 6000);
  for (const termo of ['fintech do corban', 'fintech corban', 'corban', 'sethi', 'granatech',
    'poupacred', 'invest all', 'investall', 'la vie', 'resgata', 'nova ']) {
    if (t.includes(termo)) {
      const canon = normalizarParceiro(termo);
      if (canon) return canon;
    }
  }
  return null;
}

function extrairPorRegex(texto, tipoDoc) {
  const parceiro = detectarParceiro(texto);
  const regras = { ...GENERICO, ...(parceiro && REGRAS_EXTRACAO[parceiro] ? REGRAS_EXTRACAO[parceiro] : {}) };
  const campos = {};
  const confianca = {};

  for (const [campo, tentativas] of Object.entries(regras)) {
    for (const { re, grupo, peso } of tentativas) {
      const m = texto.match(re);
      if (m && m[grupo]) {
        const cru = m[grupo].trim();
        let valor = cru;
        if (campo.startsWith('data_')) valor = dataISO(cru);
        else if (campo.startsWith('valor_') || campo.startsWith('teto_')) valor = valorBR(cru);
        else if (campo === 'cpf_ccb') valor = normalizarCpf(cru) || cru;
        else if (campo === 'numero_parcelas_contratadas' || campo === 'motivo_desligamento_codigo') valor = String(cru).replace(/\D/g, '');
        if (valor === null || valor === '' || valor === undefined) continue;
        campos[campo] = valor;
        confianca[campo] = peso >= 2 ? 'alta' : 'media';
        break;
      }
    }
  }
  if (parceiro && !campos.parceiro) { campos.parceiro = parceiro; confianca.parceiro = 'media'; }

  // data_evento (desligamento) e data_admissao são fatos do VÍNCULO — vêm de
  // Dataprev/TRCT. Uma CCB é contrato de EMPRÉSTIMO e um doc "DESCONHECIDO"
  // (resumo de margem, ficha do parceiro) costuma ter uma data solta que os
  // regex de "rescisão/admissão" capturam por engano com falsa confiança alta.
  // Rebaixa para 'baixa' -> avaliarConferencia manda pra conferência, a menos que
  // um Dataprev/TRCT real corrobore (mesclarExtracoes deixa o mais forte vencer).
  if (tipoDoc === 'CCB' || tipoDoc === 'DESCONHECIDO') {
    for (const c of ['data_evento', 'data_admissao']) {
      if (campos[c] && confianca[c] && confianca[c] !== 'baixa') confianca[c] = 'baixa';
    }
  }
  return { campos, confianca, parceiro };
}

// ----------------------------------------------------------------------------
// Ponto de entrada
// ----------------------------------------------------------------------------
//  entrada: { nomeArquivo, texto, extensao, ocrConfianca (0-100 ou null) }
//  saída  : { campos, confianca, tipoDoc, fonte, precisaConferencia, motivoConferencia }
// ----------------------------------------------------------------------------
function extrairCamposLocal({ nomeArquivo = '', texto = '', extensao = '', ocrConfianca = null } = {}) {
  const tipoDoc = detectarTipo(nomeArquivo, texto, String(extensao).toLowerCase());

  let campos = {};
  let confianca = {};
  let fonte = tipoDoc;

  if (tipoDoc === 'DATAPREV') {
    ({ campos, confianca, fonte } = extrairDataprev(texto));
  } else {
    const r = extrairPorRegex(texto, tipoDoc);
    campos = r.campos; confianca = r.confianca;
    fonte = (r.parceiro ? r.parceiro + ' · ' : '') + (tipoDoc === 'DESCONHECIDO' ? 'regex genérico' : tipoDoc + ' (regex)');
  }

  // OCR ruim rebaixa toda a confiança e por si só já pede conferência.
  const ocrRuim = ocrConfianca !== null && ocrConfianca < 70;
  if (ocrRuim) {
    for (const k of Object.keys(confianca)) if (confianca[k] === 'alta') confianca[k] = 'media';
  }

  const { precisaConferencia, motivoConferencia } = avaliarConferencia(campos, confianca, { tipoDoc, ocrRuim, ocrConfianca });
  return { campos, confianca, tipoDoc, fonte, precisaConferencia, motivoConferencia };
}

// Datas incoerentes entre si = leitura errada, NUNCA decisão de regra de negócio.
// (carência negativa, admissão depois do evento, as três datas no mesmo dia...)
// -> conferência manual, não "NEGADO automático".
function incoerenciasDeData(campos) {
  const fora = [];
  const ev = campos.data_evento ? new Date(campos.data_evento) : null;
  const ct = campos.data_contratacao ? new Date(campos.data_contratacao) : null;
  const ad = campos.data_admissao ? new Date(campos.data_admissao) : null;
  const ok = d => d && !isNaN(d);
  if (ok(ev) && ok(ct) && ev < ct) {
    fora.push(`evento (${campos.data_evento}) anterior à contratação (${campos.data_contratacao}) — carência negativa`);
  }
  if (ok(ev) && ok(ad) && ad > ev) {
    fora.push(`admissão (${campos.data_admissao}) posterior ao evento (${campos.data_evento})`);
  }
  if (campos.data_admissao && campos.data_evento && campos.data_admissao === campos.data_evento) {
    fora.push(`admissão e evento na mesma data (${campos.data_evento})`);
  }
  if (campos.data_contratacao && campos.data_evento && campos.data_contratacao === campos.data_evento) {
    fora.push(`contratação e evento na mesma data (${campos.data_evento}) — carência zero`);
  }
  return fora;
}

// Decide se o caso precisa de conferência humana e monta o motivo.
function avaliarConferencia(campos, confianca, { tipoDoc = null, ocrRuim = false, ocrConfianca = null } = {}) {
  const problemas = [];
  for (const campo of CAMPOS_OBRIGATORIOS) {
    const nivel = campos[campo] ? (confianca[campo] || 'baixa') : 'ausente';
    confianca[campo] = campos[campo] ? (confianca[campo] || 'baixa') : 'ausente';
    if (nivel === 'ausente' || nivel === 'baixa') problemas.push(campo);
  }
  const incoerencias = incoerenciasDeData(campos);
  const precisaConferencia = problemas.length > 0 || incoerencias.length > 0 || ocrRuim || tipoDoc === 'DESCONHECIDO';
  let motivoConferencia = null;
  if (precisaConferencia) {
    const p = [];
    if (problemas.length) p.push('Não foi possível ler automaticamente: ' + problemas.join(', '));
    if (incoerencias.length) p.push('Datas inconsistentes — ' + incoerencias.join('; '));
    if (ocrRuim) p.push(`OCR com baixa confiança (${Math.round(ocrConfianca)}%)`);
    if (tipoDoc === 'DESCONHECIDO') p.push('Tipo de documento não reconhecido');
    motivoConferencia = p.join('. ') + '.';
  }
  return { precisaConferencia, motivoConferencia };
}

// Junta as extrações de vários documentos do MESMO segurado (CCB + TRCT + Dataprev):
// para cada campo fica o valor de MAIOR confiança; Dataprev tem prioridade nos
// campos que são "dele" (motivo/datas de vínculo).
const PRIORIDADE_DATAPREV = ['motivo_desligamento_codigo', 'data_evento', 'data_admissao', 'situacao_emprestimo'];
const NIVEL = { alta: 3, media: 2, baixa: 1, ausente: 0 };

function mesclarExtracoes(lista) {
  const validas = (lista || []).filter(Boolean);
  if (validas.length === 0) {
    return { campos: {}, confianca: {}, tipoDoc: 'DESCONHECIDO', fonte: null,
      precisaConferencia: true, motivoConferencia: 'Nenhum campo pôde ser lido automaticamente.' };
  }
  if (validas.length === 1) return validas[0];

  const campos = {};
  const confianca = {};
  const fontes = [];
  let tipoDoc = null;
  for (const ex of validas) {
    if (ex.fonte) fontes.push(ex.fonte);
    if (ex.tipoDoc && ex.tipoDoc !== 'DESCONHECIDO' && !tipoDoc) tipoDoc = ex.tipoDoc;
    const ehDataprev = ex.tipoDoc === 'DATAPREV';
    for (const [k, val] of Object.entries(ex.campos || {})) {
      const nv = (NIVEL[ex.confianca[k]] || 0) + (ehDataprev && PRIORIDADE_DATAPREV.includes(k) ? 0.5 : 0);
      const atual = confianca[k] !== undefined ? NIVEL[confianca[k]] || 0 : -1;
      if (nv > atual) { campos[k] = val; confianca[k] = ex.confianca[k]; }
    }
  }
  const { precisaConferencia, motivoConferencia } = avaliarConferencia(campos, confianca, { tipoDoc: tipoDoc || 'DESCONHECIDO' });
  return { campos, confianca, tipoDoc: tipoDoc || 'DESCONHECIDO', fonte: [...new Set(fontes)].join(' + ') || null, precisaConferencia, motivoConferencia };
}

module.exports = {
  extrairCamposLocal,
  mesclarExtracoes,
  avaliarConferencia,
  incoerenciasDeData,
  detectarTipo,
  detectarParceiro,
  dataISO,
  valorBR,
  CAMPOS_OBRIGATORIOS,
  REGRAS_EXTRACAO,
  GENERICO
};
