// ============================================================================
// Motor de Regras de Negócio — Sistema de Sinistros Grupo Caburé
// ============================================================================
// IMPORTANTE: a lógica de ELEGIBILIDADE, CARÊNCIA, FRANQUIA e CIA NÃO mudou.
// A única adição foi o CATÁLOGO DE PRODUTOS POR PARCEIRO — o nº de parcelas
// cobertas e o teto do seguro passam a vir de um lugar só, não caso a caso.
// ============================================================================

const CODIGOS_MOTIVO_COBERTOS = ['2', '48', '49']; // Seção 5.1

// ----------------------------------------------------------------------------
// Catálogo de produtos por parceiro
// ----------------------------------------------------------------------------
//   parcelasCobertas = quantas parcelas o seguro paga
//   tetoParcela      = valor máximo de CADA parcela paga pelo seguro (R$) — null = sem teto
//   tetoTotal        = valor máximo somado do sinistro (R$) — null = sem teto total
//
// POUPACRED tem DOIS produtos distintos: a escolha depende da coluna FUNDO
// da planilha (Guardian/BMP  vs  Poupa Seguros/Via Capital SCD).
const PARCEIROS = {
  'Fintech do Corban': { parcelasCobertas: 4, tetoParcela: 1000, tetoTotal: null },
  'SETHI':             { parcelasCobertas: 6, tetoParcela: 1000, tetoTotal: null },
  'Granatech':         { parcelasCobertas: 6, tetoParcela: 500,  tetoTotal: 3000 },
  'Invest All':        { parcelasCobertas: 6, tetoParcela: 1000, tetoTotal: null },
  // Nova e Resgata Ai são PARCEIROS distintos (contatos diferentes: Nova = Andreza,
  // Resgata Ai = Luana) que usam o mesmo FUNDO por trás ("LA VIE PFO FIDC").
  // LA VIE não é parceiro — é o fundo. Mesmo catálogo de produto para os dois.
  'Nova':              { parcelasCobertas: 3, tetoParcela: null,  tetoTotal: null },
  'Resgata Ai':        { parcelasCobertas: 3, tetoParcela: null,  tetoTotal: null },
  // X3 (fundo "X ao Cubo Securitizadora S/A", contato Sophia). Regra confirmada
  // direto na planilha (coluna "Fonte do Produto"): teto R$1.000, até 6 parcelas.
  'X3':                { parcelasCobertas: 6, tetoParcela: 1000, tetoTotal: null },
  'POUPACRED': {
    porFundo: [
      { termos: ['guardian', 'bmp'],                     parcelasCobertas: 6, tetoParcela: 500,  tetoTotal: null },
      { termos: ['poupa seguros', 'via capital', 'scd'], parcelasCobertas: 3, tetoParcela: 1000, tetoTotal: null }
    ]
  }
};

function semAcento(texto) {
  return String(texto == null ? '' : texto).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ----------------------------------------------------------------------------
// Unificação de nome de parceiro: todas as variações -> um nome canônico só.
// Ex.: "Fintech Corban", "Fintech do Corban", "FINTECH CORBAN" -> "Fintech do Corban".
// ----------------------------------------------------------------------------
function normalizarParceiro(nome) {
  if (nome === null || nome === undefined) return null;
  const limpo = semAcento(String(nome).trim().toLowerCase()).replace(/\s+/g, ' ');
  if (!limpo) return null;

  // Nomes curtos/genéricos: casam só por igualdade exata (evita falso-positivo).
  // Nova e Resgata Ai são parceiros SEPARADOS (contatos diferentes) — não juntar.
  // "LA VIE" sozinho na coluna PARCEIRO é ambíguo (é o nome do FUNDO, não de um
  // parceiro): não mapeia pra nenhum dos dois, fica para conferência manual.
  const EXATO = {
    'nova': 'Nova',
    'resgata': 'Resgata Ai',
    'resgata ai': 'Resgata Ai',
    'x 3': 'X3',
    'x3': 'X3'
  };
  if (EXATO[limpo]) return EXATO[limpo];

  // Fragmentos distintivos: casam por "contém".
  const CONTEM = [
    ['corban', 'Fintech do Corban'],
    ['sethi', 'SETHI'],
    ['granatech', 'Granatech'],
    ['grana tech', 'Granatech'],
    ['poupacred', 'POUPACRED'],
    ['poupa cred', 'POUPACRED'],
    ['invest all', 'Invest All'],
    ['investall', 'Invest All'],
    ['resgata', 'Resgata Ai'],
    ['x ao cubo', 'X3']
  ];
  for (const [frag, canon] of CONTEM) {
    if (limpo.includes(frag)) return canon;
  }

  // Desconhecido: preserva o texto original, só padroniza o espaçamento.
  return String(nome).trim().replace(/\s+/g, ' ');
}

// ----------------------------------------------------------------------------
// Normalização de FUNDO: nomes diferentes da mesma entidade -> um nome só.
// "GPC Fundo de Investimento em Direitos Creditórios" é o nome legal do fundo
// cujo apelido nos dados é "Guardian" — mesma regra de produto.
// ----------------------------------------------------------------------------
const ALIASES_FUNDO = [
  { canonico: 'Guardian', termos: ['guardian', 'gpc fundo de investimento', 'gpc fidc', 'gpc f i d c', 'gpc direitos creditorios', 'gpc'] },
  { canonico: 'Via Capital SCD', termos: ['via capital', 'poupa seguros'] },
  { canonico: 'BMP', termos: ['bmp'] }
];
function normalizarFundo(nome) {
  if (nome === null || nome === undefined) return null;
  const limpo = semAcento(String(nome).trim().toLowerCase()).replace(/\s+/g, ' ');
  if (!limpo) return null;
  for (const g of ALIASES_FUNDO) {
    if (g.termos.some(t => limpo.includes(t))) return g.canonico;
  }
  return String(nome).trim().replace(/\s+/g, ' ');
}

// ----------------------------------------------------------------------------
// Resolve o produto (parcelas cobertas / tetos) de um parceiro + fundo.
// Retorna sempre um objeto; os campos ficam null quando não dá pra resolver.
//   noCatalogo      = o parceiro está no catálogo?
//   fundoResolvido  = para POUPACRED, o fundo foi identificado? (null p/ os demais)
// ----------------------------------------------------------------------------
function produtoDoParceiro(parceiro, fundo) {
  const canon = normalizarParceiro(parceiro);
  const vazio = { parceiro: canon, parcelasCobertas: null, tetoParcela: null, tetoTotal: null, noCatalogo: false, fundoResolvido: null };
  if (!canon) return vazio;

  const entrada = PARCEIROS[canon];
  if (!entrada) return { ...vazio, parceiro: canon };

  if (entrada.porFundo) {
    // normaliza o fundo primeiro (GPC FIDC -> Guardian etc.), depois casa por termo
    const f = semAcento(String(normalizarFundo(fundo) || fundo || '').toLowerCase());
    for (const opc of entrada.porFundo) {
      if (opc.termos.some(t => f.includes(t))) {
        return { parceiro: canon, parcelasCobertas: opc.parcelasCobertas, tetoParcela: opc.tetoParcela, tetoTotal: opc.tetoTotal, noCatalogo: true, fundoResolvido: true };
      }
    }
    // Parceiro conhecido, mas o fundo não bateu com nenhum sub-caso.
    return { parceiro: canon, parcelasCobertas: null, tetoParcela: null, tetoTotal: null, noCatalogo: true, fundoResolvido: false };
  }

  return { parceiro: canon, parcelasCobertas: entrada.parcelasCobertas, tetoParcela: entrada.tetoParcela, tetoTotal: entrada.tetoTotal, noCatalogo: true, fundoResolvido: true };
}

// ----------------------------------------------------------------------------
// Helpers de data (inalterados)
// ----------------------------------------------------------------------------
// Date | 'AAAA-MM-DD...' -> 'AAAA-MM-DD' (para mensagens legíveis ao usuário).
function fmtDataCurta(d) {
  if (!d) return '?';
  const dt = (d instanceof Date) ? d : new Date(d);
  return isNaN(dt) ? String(d) : dt.toISOString().slice(0, 10);
}

function calcularDiasEntreDatas(dataInicio, dataFim) {
  if (!dataInicio || !dataFim) return null;
  const inicio = new Date(dataInicio);
  const fim = new Date(dataFim);
  return Math.floor((fim - inicio) / (1000 * 60 * 60 * 24));
}

function calcularMesesEntreDatas(dataInicio, dataFim) {
  if (!dataInicio || !dataFim) return null;
  const inicio = new Date(dataInicio);
  const fim = new Date(dataFim);
  let meses = (fim.getFullYear() - inicio.getFullYear()) * 12 + (fim.getMonth() - inicio.getMonth());
  if (fim.getDate() < inicio.getDate()) meses -= 1;
  return Math.max(meses, 0);
}

function calcularAnosCompletosTrabalhados(dataAdmissao, dataEvento) {
  const meses = calcularMesesEntreDatas(dataAdmissao, dataEvento);
  if (meses === null) return 0;
  return Math.floor(meses / 12);
}

// ----------------------------------------------------------------------------
// Elegibilidade / carência / franquia / CIA — LÓGICA INALTERADA
// ----------------------------------------------------------------------------
function verificarElegibilidade(caso) {
  if (!caso.motivo_desligamento_codigo) {
    return { elegivel: null, motivo: 'Código de motivo do desligamento não encontrado nos documentos — necessário revisão manual.' };
  }
  if (!CODIGOS_MOTIVO_COBERTOS.includes(String(caso.motivo_desligamento_codigo))) {
    return { elegivel: false, motivo: `Motivo de desligamento código ${caso.motivo_desligamento_codigo} está fora de cobertura (só são cobertos os códigos 2, 48 e 49).` };
  }
  return { elegivel: true, motivo: null };
}

function calcularCarencia(caso) {
  const dias = calcularDiasEntreDatas(caso.data_contratacao, caso.data_evento);
  if (dias === null) return { carenciaDias: null, cumprida: null };
  return { carenciaDias: dias, cumprida: dias >= 31 };
}

function calcularFranquia(caso) {
  if (!caso.data_evento) return null;
  const franquia = new Date(caso.data_evento);
  const ehSethi = (caso.parceiro || '').toUpperCase().includes('SETHI');
  if (ehSethi) {
    franquia.setDate(franquia.getDate() + 30);
  } else {
    const anosTrabalhados = calcularAnosCompletosTrabalhados(caso.data_admissao, caso.data_evento);
    franquia.setDate(franquia.getDate() + 31 + (anosTrabalhados * 3));
  }
  return franquia;
}

function calcularCia(caso) {
  const parceiro = (caso.parceiro || '').toUpperCase();
  if (!caso.data_evento) return null;
  const dataReferencia = new Date(caso.data_evento);
  if (parceiro.includes('SETHI')) {
    const corteAbril2026 = new Date('2026-04-01');
    if (dataReferencia < corteAbril2026) return 'Caburé';
    const mesesVinculo = calcularMesesEntreDatas(caso.data_admissao, caso.data_evento);
    if (mesesVinculo === null) return null;
    if (mesesVinculo >= 6 && mesesVinculo <= 12) return 'Caburé';
    if (mesesVinculo > 12) return 'MetLife';
    return null;
  }
  const corteMarco2026 = new Date('2026-03-01');
  return dataReferencia < corteMarco2026 ? 'Caburé' : 'MetLife';
}

// ----------------------------------------------------------------------------
// Valor a pagar — agora usa o teto do CATÁLOGO quando o parceiro é conhecido.
// (Antes: só o teto avulso do caso, vindo da extração por IA.)
// ----------------------------------------------------------------------------
function calcularValorAPagar(caso, produto) {
  if (caso.valor_parcela === null || caso.valor_parcela === undefined) return null;
  const parcela = Number(caso.valor_parcela);

  if (produto && produto.noCatalogo && produto.fundoResolvido) {
    if (produto.tetoParcela === null) return arred2(parcela);          // sem teto definido (LA VIE)
    return arred2(Math.min(parcela, Number(produto.tetoParcela)));
  }

  // Fora do catálogo (ou fundo POUPACRED não identificado): regra antiga.
  if (caso.teto_parcela_produto === null || caso.teto_parcela_produto === undefined) return null;
  return arred2(Math.min(parcela, Number(caso.teto_parcela_produto)));
}

function resolverParcelasCobertas(caso, produto) {
  if (produto && produto.parcelasCobertas !== null && produto.parcelasCobertas !== undefined) {
    return produto.parcelasCobertas;
  }
  if (caso.numero_parcelas_cobertas_produto !== null && caso.numero_parcelas_cobertas_produto !== undefined) {
    return Number(caso.numero_parcelas_cobertas_produto);
  }
  return null;
}

function calcularValorTotalAPagar(valorParcelaPaga, parcelasCobertas, produto) {
  if (valorParcelaPaga === null || parcelasCobertas === null) return null;
  let total = Number(valorParcelaPaga) * Number(parcelasCobertas);
  if (produto && produto.tetoTotal !== null && produto.tetoTotal !== undefined) {
    total = Math.min(total, Number(produto.tetoTotal));
  }
  return arred2(total);
}

function arred2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function calcularStatus(caso, elegibilidade, carencia, franquia, valorAPagar) {
  if (!caso.data_contratacao || !caso.data_evento) {
    return { status: 'AGUARDANDO DOC', motivo: 'Faltam datas essenciais (contratação e/ou evento) para calcular carência e franquia.' };
  }
  // Carência negativa = evento ANTES da contratação: fisicamente impossível, é
  // erro de leitura de data — NÃO é uma negativa de regra de negócio. Vai para
  // conferência manual; nunca "NEGADO automático" com um número sem sentido.
  if (carencia.carenciaDias !== null && carencia.carenciaDias < 0) {
    return {
      status: 'AGUARDANDO CONFERÊNCIA MANUAL',
      motivo: `Datas inconsistentes: carência calculada de ${carencia.carenciaDias} dia(s) — a data do evento (${fmtDataCurta(caso.data_evento)}) está antes da contratação (${fmtDataCurta(caso.data_contratacao)}). Revisar a leitura das datas antes de decidir.`
    };
  }
  if (elegibilidade.elegivel === false) {
    return { status: 'NEGADO', motivo: elegibilidade.motivo };
  }
  if (carencia.cumprida === false) {
    return { status: 'NEGADO', motivo: `Carência de ${carencia.carenciaDias} dia(s) é menor que o mínimo de 31 dias.` };
  }
  if (elegibilidade.elegivel === null) {
    return { status: 'EM CARÊNCIA / ANÁLISE', motivo: elegibilidade.motivo };
  }
  const hoje = new Date();
  if (franquia && hoje < franquia) {
    return { status: 'EM FRANQUIA', motivo: null };
  }
  if (valorAPagar === 0) {
    return { status: 'AGUARDANDO DOC', motivo: 'Valor a pagar calculado é R$ 0,00 — possível contrato já quitado (Seção 5.7), confirmar manualmente.' };
  }
  if (valorAPagar === null) {
    return { status: 'AGUARDANDO DOC', motivo: 'Faltam o valor da parcela ou o teto do produto (ver Anexo I/CCB) para calcular o valor a pagar.' };
  }
  return { status: 'PRONTO PARA PAGAR', motivo: null };
}

function calcularCaso(caso) {
  const produto = produtoDoParceiro(caso.parceiro, caso.fundo);
  const elegibilidade = verificarElegibilidade(caso);
  const carencia = calcularCarencia(caso);
  const franquia = calcularFranquia(caso);
  const cia = calcularCia(caso);
  const valorAPagar = calcularValorAPagar(caso, produto);
  const parcelasCobertas = resolverParcelasCobertas(caso, produto);
  const valorTotalAPagar = calcularValorTotalAPagar(valorAPagar, parcelasCobertas, produto);
  const resultadoStatus = calcularStatus(caso, elegibilidade, carencia, franquia, valorAPagar);

  const tetoResolvido = (produto && produto.noCatalogo && produto.fundoResolvido && produto.tetoParcela !== null)
    ? produto.tetoParcela
    : (caso.teto_parcela_produto ?? null);

  return {
    carenciaDias: carencia.carenciaDias,
    franquiaData: franquia,
    cia,
    valorAPagar,
    parcelasCobertas,
    tetoParcelaProduto: tetoResolvido,
    valorTotalAPagar,
    parceiroCanonico: produto ? produto.parceiro : normalizarParceiro(caso.parceiro),
    status: resultadoStatus.status,
    motivoNegacao: resultadoStatus.motivo
  };
}

module.exports = {
  calcularCaso,
  verificarElegibilidade,
  calcularCarencia,
  calcularFranquia,
  calcularValorAPagar,
  normalizarParceiro,
  normalizarFundo,
  produtoDoParceiro,
  PARCEIROS
};
