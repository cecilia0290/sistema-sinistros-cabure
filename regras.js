// ============================================================================
// Motor de Regras de Negócio — Sistema de Sinistros Grupo Caburé
// ============================================================================
// TUDO NESTE ARQUIVO É CÁLCULO DETERMINÍSTICO (código puro, sempre o mesmo
// resultado para a mesma entrada). A IA NUNCA decide nada aqui — isso é
// exigido pela Seção 1 e pela Seção 5 da especificação, para o sistema ser
// auditável e seguro para uso financeiro real.
//
// Baseado na aba REGRAS da planilha real, atualizada em 19/08/2026.
//
// ATENÇÃO — PONTO A CONFIRMAR COM A EQUIPE (ver Seção 13 da especificação):
// A regra da Seção 5.4 diz "até fevereiro/2026 = Caburé; a partir de março/2026
// = MetLife", mas não deixa claro qual data usar como referência (contratação,
// evento, ou processamento do caso). Este código usa a DATA DO EVENTO como
// referência — procure o comentário "CONFIRMAR COM A EQUIPE" mais abaixo se
// precisar trocar isso.
// ============================================================================

const CODIGOS_MOTIVO_COBERTOS = ['2', '48', '49']; // Seção 5.1

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

// --- Seção 5.1 — Elegibilidade (motivo do sinistro) ---
function verificarElegibilidade(caso) {
  if (!caso.motivo_desligamento_codigo) {
    return { elegivel: null, motivo: 'Código de motivo do desligamento não encontrado nos documentos — necessário revisão manual.' };
  }
  if (!CODIGOS_MOTIVO_COBERTOS.includes(String(caso.motivo_desligamento_codigo))) {
    return { elegivel: false, motivo: `Motivo de desligamento código ${caso.motivo_desligamento_codigo} está fora de cobertura (só são cobertos os códigos 2, 48 e 49).` };
  }
  return { elegivel: true, motivo: null };
}

// --- Seção 5.2 — Carência (mínimo 31 dias entre contratação e evento) ---
function calcularCarencia(caso) {
  const dias = calcularDiasEntreDatas(caso.data_contratacao, caso.data_evento);
  if (dias === null) return { carenciaDias: null, cumprida: null };
  return { carenciaDias: dias, cumprida: dias >= 31 };
}

// --- Seção 5.3 — Franquia ---
function calcularFranquia(caso) {
  if (!caso.data_evento) return null;
  const franquia = new Date(caso.data_evento);
  const ehSethi = (caso.parceiro || '').toUpperCase().includes('SETHI');

  if (ehSethi) {
    franquia.setDate(franquia.getDate() + 31);
  } else {
    const anosTrabalhados = calcularAnosCompletosTrabalhados(caso.data_admissao, caso.data_evento);
    franquia.setDate(franquia.getDate() + 31 + (anosTrabalhados * 3));
  }
  return franquia;
}

// --- Seção 5.4 — Definição da CIA pagadora ---
function calcularCia(caso) {
  const parceiro = (caso.parceiro || '').toUpperCase();
  if (!caso.data_evento) return null;

  // CONFIRMAR COM A EQUIPE: usando data do evento como referência (ver aviso no topo do arquivo)
  const dataReferencia = new Date(caso.data_evento);

  if (parceiro.includes('SETHI')) {
    const corteAbril2026 = new Date('2026-04-01');
    if (dataReferencia < corteAbril2026) return 'Caburé'; // base legada / até março 2026

    const mesesVinculo = calcularMesesEntreDatas(caso.data_admissao, caso.data_evento);
    if (mesesVinculo === null) return null;
    if (mesesVinculo >= 6 && mesesVinculo <= 12) return 'Caburé';
    if (mesesVinculo > 12) return 'MetLife';
    return null; // vínculo com menos de 6 meses: regra não coberta explicitamente na Seção 5.4, revisar manualmente
  }

  const corteMarco2026 = new Date('2026-03-01');
  return dataReferencia < corteMarco2026 ? 'Caburé' : 'MetLife';
}

// --- Seção 5.5 — Valor a pagar = MÍNIMO(parcela do contrato; teto do produto) ---
function calcularValorAPagar(caso) {
  if (caso.valor_parcela === null || caso.valor_parcela === undefined) return null;
  if (caso.teto_parcela_produto === null || caso.teto_parcela_produto === undefined) return null;
  return Math.min(Number(caso.valor_parcela), Number(caso.teto_parcela_produto));
}

// --- Seção 6 — Status final do caso ---
function calcularStatus(caso, elegibilidade, carencia, franquia, valorAPagar) {
  if (!caso.data_contratacao || !caso.data_evento) {
    return { status: 'AGUARDANDO DOC', motivo: 'Faltam datas essenciais (contratação e/ou evento) para calcular carência e franquia.' };
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

// --- Função principal: roda todas as regras acima para um caso ---
function calcularCaso(caso) {
  const elegibilidade = verificarElegibilidade(caso);
  const carencia = calcularCarencia(caso);
  const franquia = calcularFranquia(caso);
  const cia = calcularCia(caso);
  const valorAPagar = calcularValorAPagar(caso);
  const resultadoStatus = calcularStatus(caso, elegibilidade, carencia, franquia, valorAPagar);

  return {
    carenciaDias: carencia.carenciaDias,
    franquiaData: franquia,
    cia,
    valorAPagar,
    status: resultadoStatus.status,
    motivoNegacao: resultadoStatus.motivo
  };
}

module.exports = { calcularCaso };