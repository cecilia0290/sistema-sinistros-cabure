// ============================================================================
// Transformação da planilha mãe: linhas cruas -> registros -> casos deduplicados
// -> campos calculados pelo motor de regras.
// Sem dependência de xlsx / banco (testável isoladamente).
// ============================================================================

const { calcularCaso, produtoDoParceiro } = require('./regras');
const { chavesIdentidade, formatarCpfCcb, separarCcbComposto, analisarCpfCcb, Uniao } = require('./identidade');
const P = require('./planilha-parse');

function brl(n) {
  return (n === null || n === undefined) ? '—'
    : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// `linhas`: array de objetos { __linha: <n>, col0, col1, ... }  (valores já "crus" da célula)
// `mapa`  : { campoLogico: <indiceDaColuna> }
// `opcoes`: { liberarProgramadosTodos: bool, liberadosChaves: Set<digitos>,
//             fundoCorrigido: Map<digitos, {fundo, nota}> }
//           -> promove casos "PROGRAMADO" para "A PAGAR" (conferência manual);
//              fundoCorrigido substitui a coluna FUNDO da planilha por engano
//              de digitação já confirmado manualmente (config-pagamento.js)
function transformar(mapa, linhas, opcoes = {}) {
  const avisos = [];
  const liberarTodos = !!opcoes.liberarProgramadosTodos;
  const liberados = opcoes.liberadosChaves instanceof Set ? opcoes.liberadosChaves : new Set();
  const get = (linha, campo) => (mapa[campo] === undefined ? null : linha['col' + mapa[campo]]);
  const txt = v => (P.vazio(v) ? null : String(v).trim().replace(/\s+/g, ' '));

  const categorias = {
    A_PAGAR: 0, PROGRAMADO: 0, AGUARDANDO_FRANQUIA: 0, AGUARDANDO_DOCUMENTACAO: 0,
    JA_PAGO: 0, NAO_PAGAR: 0, PENDENTE: 0, NAO_RECONHECIDO: 0
  };

  const registros = linhas.map(linha => {
    const cpfCcbBruto = get(linha, 'cpf_ccb');
    const segurado = txt(get(linha, 'segurado'));
    const flag = P.parseCasosAPagar(get(linha, 'casos_a_pagar'));
    categorias[flag.categoria]++;
    if (flag.avisar) {
      avisos.push(`Linha ${linha.__linha}: "CASOS A PAGAR" = "${flag.bruto}" NÃO reconhecido (não bate com nenhum prefixo esperado).`);
    }
    const partes = separarCcbComposto(cpfCcbBruto);
    if (partes.length > 1) {
      avisos.push(`Linha ${linha.__linha}: CPF/CCB composto "${cpfCcbBruto}" separado em ${partes.length} (${partes.join(', ')}).`);
    }
    const nParc = parseInt(get(linha, 'numero_parcelas_contratadas'), 10);
    return {
      linhaOrigem: linha.__linha,
      raw: linha,
      cpfCcbBruto: P.vazio(cpfCcbBruto) ? null : String(cpfCcbBruto).trim(),
      chaves: chavesIdentidade(cpfCcbBruto, segurado),
      segurado,
      parceiroBruto: txt(get(linha, 'parceiro')),
      fundo: txt(get(linha, 'fundo')),
      cia: txt(get(linha, 'cia')),
      mesAnoContratacao: P.parseMesAno(get(linha, 'mes_ano_contratacao')),
      dataContratacao: P.parseData(get(linha, 'data_contratacao')),
      dataEvento: P.parseData(get(linha, 'data_evento')),
      dataAdmissao: P.parseData(get(linha, 'data_admissao')),
      franquiaPlanilha: P.parseData(get(linha, 'franquia')),
      motivoCodigo: txt(get(linha, 'motivo_desligamento_codigo')),
      valorParcela: P.parseValor(get(linha, 'valor_parcela')),
      numParcelasContratadas: Number.isFinite(nParc) ? nParc : null,
      valorAPagarPlanilha: P.parseValor(get(linha, 'valor_a_pagar')),
      tetoPlanilha: P.parseValor(get(linha, 'teto_parcela_produto')),
      parcelasPlanilha: (() => { const n = parseInt(get(linha, 'numero_parcelas_cobertas_produto'), 10); return Number.isFinite(n) ? n : null; })(),
      cobertura: txt(get(linha, 'cobertura')),
      statusPlanilha: txt(get(linha, 'status')),
      casosAPagar: flag.aPagar,
      categoria: flag.categoria,
      classificacaoRotulo: flag.rotulo,
      franquiaAte: flag.franquiaAte,
      programadoPara: flag.programadoPara,
      casosAPagarBruto: flag.bruto
    };
  });

  // ---- Deduplicação: MESMO CPF **e** MESMO CCB (mesmo empréstimo) -> 1 caso ----
  // CPF igual com CCB diferente = casos SEPARADOS. Só junta quando os conjuntos
  // de CCB se cruzam (cobre reenvio e CCB composto "123/456" partido em 2 linhas).
  const uniao = new Uniao();
  const semChave = [];
  const idxPar = new Map();    // "cpf|ccb"  -> id do 1º registro (CPF + CCB)
  const idxCpf = new Map();    // "cpf"      -> id do 1º registro (só CPF, sem CCB)
  const idxCcb = new Map();    // "ccb"      -> id do 1º registro (só CCB, sem CPF)
  const idxNome = new Map();   // "nome"     -> id do 1º registro (sem CPF nem CCB)

  for (const reg of registros) {
    const { cpf, ccbs } = analisarCpfCcb(reg.cpfCcbBruto);
    reg._id = 'r' + reg.linhaOrigem;
    reg._cpf = cpf;
    reg._ccbs = ccbs;
    uniao.achar(reg._id); // garante nó próprio: todo registro tem um grupo

    if (cpf && ccbs.length) {
      for (const c of ccbs) {
        const k = cpf + '|' + c;
        if (idxPar.has(k)) uniao.unir(reg._id, idxPar.get(k)); else idxPar.set(k, reg._id);
      }
    } else if (cpf) {
      if (idxCpf.has(cpf)) uniao.unir(reg._id, idxCpf.get(cpf)); else idxCpf.set(cpf, reg._id);
    } else if (ccbs.length) {
      for (const c of ccbs) {
        if (idxCcb.has(c)) uniao.unir(reg._id, idxCcb.get(c)); else idxCcb.set(c, reg._id);
      }
    } else if (reg.segurado) {
      const k = reg.segurado.toLowerCase();
      if (idxNome.has(k)) uniao.unir(reg._id, idxNome.get(k)); else idxNome.set(k, reg._id);
    } else {
      semChave.push(reg);
    }
  }
  if (semChave.length) {
    avisos.push(`${semChave.length} linha(s) sem CPF/CCB nem nome — ignoradas (linhas ${semChave.map(r => r.linhaOrigem).join(', ')}).`);
  }

  const grupos = new Map();
  for (const reg of registros) {
    if (semChave.includes(reg)) continue;
    const rep = uniao.achar(reg._id);
    if (!grupos.has(rep)) grupos.set(rep, []);
    grupos.get(rep).push(reg);
  }

  const primeiro = (regs, campo) => {
    for (const r of regs) if (r[campo] !== null && r[campo] !== undefined && r[campo] !== '') return r[campo];
    return null;
  };

  const casos = [];
  for (const regs of grupos.values()) {
    regs.sort((a, b) => a.linhaOrigem - b.linhaOrigem);
    const chavesGrupo = [...new Set(regs.flatMap(r => r.chaves))].sort();
    const rotulo = primeiro(regs, 'segurado') || chavesGrupo[0];

    const digitosGrupo = new Set([
      ...regs.map(r => r._cpf).filter(Boolean),
      ...regs.flatMap(r => r._ccbs || [])
    ]);

    let catCaso = categoriaDoCaso(regs);
    let programadoLiberado = false;
    if (catCaso === 'PROGRAMADO') {
      if (liberarTodos || [...digitosGrupo].some(d => liberados.has(d))) {
        catCaso = 'A_PAGAR';
        programadoLiberado = true;
        avisos.push(`"${rotulo}": estava PROGRAMADO — liberado por conferência manual, entrou em A PAGAR.`);
      }
    }

    // Se pagaria (A_PAGAR) mas o parceiro não está no catálogo (X 3, "NAO CADASTRADO",
    // "1573", vazio…): NÃO entra automático — fica para confirmação manual da regra.
    const parceiroBrutoCaso = primeiro(regs, 'parceiroBruto');

    // Correção manual de FUNDO com erro de digitação confirmado (config-pagamento.js).
    const fundoCorrigidoInfo = opcoes.fundoCorrigido instanceof Map
      ? [...digitosGrupo].map(d => opcoes.fundoCorrigido.get(d)).find(Boolean)
      : null;
    if (fundoCorrigidoInfo) {
      avisos.push(`"${rotulo}": FUNDO corrigido manualmente de "${primeiro(regs, 'fundo') || '(vazio)'}" para "${fundoCorrigidoInfo.fundo}" — ${fundoCorrigidoInfo.nota}.`);
    }
    const fundoCaso = fundoCorrigidoInfo ? fundoCorrigidoInfo.fundo : primeiro(regs, 'fundo');

    if (catCaso === 'A_PAGAR') {
      const prodChk = produtoDoParceiro(parceiroBrutoCaso, fundoCaso);
      if (!prodChk.noCatalogo) {
        catCaso = 'PARCEIRO_NAO_IDENTIFICADO';
        avisos.push(`"${rotulo}": marcado para pagar, mas parceiro "${parceiroBrutoCaso || '(vazio)'}" não está no catálogo — segurado para conferência.`);
      }
    }

    const parceirosDistintos = [...new Set(regs.map(r => r.parceiroBruto).filter(Boolean))];
    if (parceirosDistintos.length > 1) {
      avisos.push(`"${rotulo}": parceiros diferentes nas linhas (${parceirosDistintos.join(', ')}) — usei o primeiro.`);
    }

    // Mesmo CPF+CCB = mesmo empréstimo (reenvio / composto partido): NÃO soma
    // o valor. Usa o "Valor a Pagar" da 1ª linha; avisa se as linhas divergem.
    const valoresDistintos = [...new Set(regs.map(r => r.valorAPagarPlanilha).filter(v => v !== null))];
    const valorPlanilha = valoresDistintos.length ? valoresDistintos[0] : null;
    if (regs.length > 1) {
      avisos.push(`"${rotulo}": ${regs.length} linhas do MESMO CPF+CCB (reenvio ou CCB composto) — mantida 1, valor NÃO somado` +
        (valoresDistintos.length > 1 ? `. ATENÇÃO: "Valor a Pagar" diverge entre as linhas (${valoresDistintos.map(brl).join(' vs ')}) — usei ${brl(valorPlanilha)}` : '') + '.');
    }

    casos.push({
      chavesGrupo,
      linhas: regs,
      segurado: primeiro(regs, 'segurado'),
      cpf_ccb: formatarCpfCcb(regs.map(r => r.cpfCcbBruto).filter(Boolean).join(' / ')),
      parceiro_bruto: primeiro(regs, 'parceiroBruto'),
      fundo: fundoCaso,
      cia: primeiro(regs, 'cia'),
      mes_ano_contratacao: primeiro(regs, 'mesAnoContratacao'),
      data_contratacao: primeiro(regs, 'dataContratacao'),
      data_evento: primeiro(regs, 'dataEvento'),
      data_admissao: primeiro(regs, 'dataAdmissao'),
      franquia_planilha: primeiro(regs, 'franquiaPlanilha'),
      motivo_desligamento_codigo: primeiro(regs, 'motivoCodigo'),
      valor_parcela: primeiro(regs, 'valorParcela'),
      numero_parcelas_contratadas: primeiro(regs, 'numParcelasContratadas'),
      cobertura: primeiro(regs, 'cobertura'),
      teto_planilha: primeiro(regs, 'tetoPlanilha'),
      parcelas_planilha: primeiro(regs, 'parcelasPlanilha'),
      valor_a_pagar_planilha: valorPlanilha,
      status_planilha: primeiro(regs, 'statusPlanilha'),
      // O CASO só é "a pagar" se a sua categoria final for A_PAGAR (PROGRAMADO,
      // por exemplo, NUNCA entra automático mesmo se houver linha "PAGAR" junto).
      casos_a_pagar: catCaso === 'A_PAGAR' ? 1 : 0,
      categoria_pagamento: catCaso,
      programado_liberado: programadoLiberado,
      classificacao_pagamento: programadoLiberado ? 'A PAGAR (ex-PROGRAMADO)' : P.CATEGORIA_ROTULO[catCaso],
      franquia_ate: primeiro(regs, 'franquiaAte'),
      data_programada: primeiro(regs, 'programadoPara')
    });
  }

  return { casos, avisos, categorias, totalLinhas: linhas.length, ignoradas: semChave.length };
}

// Categoria final do CASO a partir das suas linhas. Prioridade: PROGRAMADO acima
// de tudo (para nunca virar "a pagar" sem conferência), depois A_PAGAR, etc.
const PRIORIDADE_CATEGORIA = [
  'PROGRAMADO', 'A_PAGAR', 'AGUARDANDO_FRANQUIA', 'AGUARDANDO_DOCUMENTACAO',
  'JA_PAGO', 'NAO_PAGAR', 'NAO_RECONHECIDO', 'PENDENTE'
];
function categoriaDoCaso(regs) {
  const presentes = new Set(regs.map(r => r.categoria));
  for (const cat of PRIORIDADE_CATEGORIA) if (presentes.has(cat)) return cat;
  return 'PENDENTE';
}

// Motor de regras -> campos calculados. `valor_a_pagar_final` é a coluna única
// que Dashboard / Pagar agora / gráficos usam (por isso os totais batem).
function aplicarMotor(caso) {
  const r = calcularCaso({
    parceiro: caso.parceiro_bruto,
    fundo: caso.fundo,
    data_contratacao: caso.data_contratacao,
    data_evento: caso.data_evento,
    data_admissao: caso.data_admissao,
    motivo_desligamento_codigo: caso.motivo_desligamento_codigo,
    valor_parcela: caso.valor_parcela,
    teto_parcela_produto: null,
    numero_parcelas_cobertas_produto: null
  });
  caso.parceiro = r.parceiroCanonico;
  // Nova e Resgata Ai são parceiros distintos, mas ambos usam o mesmo FUNDO por
  // trás ("LA VIE PFO FIDC"). Preenche a coluna FUNDO quando ela vier vazia da
  // planilha, ou normaliza a grafia quando já vier como "LA VIE".
  if (caso.parceiro === 'Nova' || caso.parceiro === 'Resgata Ai') {
    const fundoLimpo = P.semAcento(String(caso.fundo || '').trim().toLowerCase()).replace(/\s+/g, ' ');
    const fundoSemEspaco = fundoLimpo.replace(/\s+/g, '');
    if (!fundoLimpo || fundoSemEspaco === 'lavie' || fundoSemEspaco.startsWith('lavie')) {
      caso.fundo = 'LA VIE';
    }
  }
  caso.carencia_dias = r.carenciaDias;
  caso.franquia_data = r.franquiaData ? r.franquiaData.toISOString().slice(0, 10) : null;
  caso.cia_calculada = r.cia;
  caso.valor_a_pagar = r.valorAPagar;
  caso.valor_total_a_pagar = r.valorTotalAPagar;
  // FONTE PRINCIPAL = catálogo. Guardamos o valor do catálogo; a planilha (AP/AQ)
  // entra só para COMPARAR — quando diverge, marcamos e listamos, sem decidir.
  caso.numero_parcelas_cobertas_produto = r.parcelasCobertas;
  caso.teto_parcela_produto = r.tetoParcelaProduto;
  caso.status = r.status;
  caso.motivo_negacao = r.motivoNegacao;

  const difs = [];
  const catParc = r.parcelasCobertas, plParc = caso.parcelas_planilha;
  const catTeto = r.tetoParcelaProduto, plTeto = caso.teto_planilha;
  if (catParc != null && plParc != null && Number(catParc) !== Number(plParc)) {
    difs.push(`parcelas cobertas: catálogo ${catParc} x planilha ${plParc}`);
  }
  if (catTeto != null && plTeto != null && Math.abs(Number(catTeto) - Number(plTeto)) > 0.001) {
    difs.push(`teto parcela: catálogo ${brl(catTeto)} x planilha ${brl(plTeto)}`);
  }
  caso.divergencia_produto = difs.length ? difs.join('; ') : null;

  caso.valor_a_pagar_final =
    (caso.valor_a_pagar_planilha !== null && caso.valor_a_pagar_planilha !== undefined) ? caso.valor_a_pagar_planilha
    : (r.valorTotalAPagar !== null ? r.valorTotalAPagar : r.valorAPagar);
  return caso;
}

module.exports = { transformar, aplicarMotor, brl };
