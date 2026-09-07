// ============================================================================
// Transformação da planilha mãe: linhas cruas -> registros -> casos deduplicados
// -> campos calculados pelo motor de regras.
// Sem dependência de xlsx / banco (testável isoladamente).
// ============================================================================

const { calcularCaso, produtoDoParceiro } = require('./regras');
const { chavesIdentidade, formatarCpfCcb, separarCcbComposto, analisarCpfCcb, normalizarCcb, Uniao } = require('./identidade');
const P = require('./planilha-parse');

function brl(n) {
  return (n === null || n === undefined) ? '—'
    : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// `linhas`: array de objetos { __linha: <n>, col0, col1, ... }  (valores já "crus" da célula)
// `mapa`  : { campoLogico: <indiceDaColuna> }
// `opcoes`: { liberarProgramadosTodos: bool, liberadosChaves: Set<digitos>,
//             fundoCorrigido: Map<digitos, {fundo, nota}>,
//             pagamentosConfirmados: Set<ccbNormalizado>,   // tabela pagamentos_confirmados
//             casosManuais: Map<ccbNormalizado, {acao, nota, ...}> }  // config-pagamento.casosManuais
//           -> promove casos "PROGRAMADO" para "A PAGAR" (conferência manual);
//              fundoCorrigido substitui a coluna FUNDO da planilha por engano
//              de digitação já confirmado manualmente (config-pagamento.js);
//              pagamentosConfirmados/casosManuais aplicam OVERRIDES ao caso ANTES
//              da coluna CASOS A PAGAR (o registro de pagamento real manda).
function transformar(mapa, linhas, opcoes = {}) {
  const avisos = [];
  const liberarTodos = !!opcoes.liberarProgramadosTodos;
  const liberados = opcoes.liberadosChaves instanceof Set ? opcoes.liberadosChaves : new Set();
  // pagamentosConfirmados: Map<ccbNormalizado, nº de parcelas pagas>. Aceita também
  // um Set (compat.) — nesse caso cada CCB conta como 1 parcela paga.
  const pagCru = opcoes.pagamentosConfirmados;
  const parcelasPagasDe = (k) => {
    if (!k) return 0;
    if (pagCru instanceof Map) return pagCru.get(k) || 0;
    if (pagCru instanceof Set) return pagCru.has(k) ? 1 : 0;
    return 0;
  };
  const casosManuais = opcoes.casosManuais instanceof Map ? opcoes.casosManuais : new Map();
  let nPagamentoConfirmado = 0, nBloqueado = 0, nAguardandoValor = 0, nResgatadosDeAPagar = 0;
  let nProximaParcela = 0, nJaPagoCompleto = 0, nPagamentoForaDoEscopo = 0;
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

  // Quantos GRUPOS (casos) distintos compartilham cada CPF — usado para não casar
  // um pagamento por CPF quando a pessoa tem mais de um empréstimo (ambíguo).
  const gruposPorCpf = new Map();
  for (const [rep, regs] of grupos) {
    for (const reg of regs) if (reg._cpf) {
      if (!gruposPorCpf.has(reg._cpf)) gruposPorCpf.set(reg._cpf, new Set());
      gruposPorCpf.get(reg._cpf).add(rep);
    }
  }

  let nCasadoPorCpfComRessalva = 0;
  const casos = [];
  for (const regs of grupos.values()) {
    regs.sort((a, b) => a.linhaOrigem - b.linhaOrigem);
    const chavesGrupo = [...new Set(regs.flatMap(r => r.chaves))].sort();
    const rotulo = primeiro(regs, 'segurado') || chavesGrupo[0];

    const digitosGrupo = new Set([
      ...regs.map(r => r._cpf).filter(Boolean),
      ...regs.flatMap(r => r._ccbs || [])
    ]);
    // Chaves normalizadas (só dígitos, sem zeros à esquerda) do grupo — para
    // casar com pagamentos_confirmados e com config-pagamento.casosManuais.
    const chavesNorm = new Set([...digitosGrupo].map(normalizarCcb).filter(Boolean));
    const infoManual = (() => {
      for (const k of chavesNorm) { const m = casosManuais.get(k); if (m) return m; }
      return null;
    })();

    // Categoria que a PLANILHA (coluna CASOS A PAGAR) daria, sem nenhum override.
    const catPlanilha = categoriaDoCaso(regs);

    // Parceiro / fundo do caso (a correção de FUNDO vem de config-pagamento.js).
    const parceiroBrutoCaso = primeiro(regs, 'parceiroBruto');
    const fundoCorrigidoInfo = opcoes.fundoCorrigido instanceof Map
      ? [...digitosGrupo].map(d => opcoes.fundoCorrigido.get(d)).find(Boolean)
      : null;
    if (fundoCorrigidoInfo) {
      avisos.push(`"${rotulo}": FUNDO corrigido manualmente de "${primeiro(regs, 'fundo') || '(vazio)'}" para "${fundoCorrigidoInfo.fundo}" — ${fundoCorrigidoInfo.nota}.`);
    }
    const fundoCaso = fundoCorrigidoInfo ? fundoCorrigidoInfo.fundo : primeiro(regs, 'fundo');

    // Parcelas COBERTAS pelo produto (catálogo). Fallback: coluna AQ da planilha.
    const prodCaso = produtoDoParceiro(parceiroBrutoCaso, fundoCaso);
    let parcelasCobertas = prodCaso && prodCaso.parcelasCobertas != null ? Number(prodCaso.parcelasCobertas) : null;
    if (parcelasCobertas == null) {
      const pl = primeiro(regs, 'parcelasPlanilha');
      if (pl != null && Number.isFinite(Number(pl))) parcelasCobertas = Number(pl);
    }

    // Como o CCB do caso casou com pagamentos_confirmados, e QUANTAS parcelas:
    //   - por CCB  -> casamento forte (mesmo empréstimo)
    //   - por CPF  -> só vale quando o caso NÃO tem CCB próprio (ex.: SETHI, cujo
    //                 "CPF" é o nº do contrato) E esse CPF tem 1 caso só.
    const ccbsGrupo = [...new Set(regs.flatMap(r => r._ccbs || []))];
    const cpfsGrupo = [...new Set(regs.map(r => r._cpf).filter(Boolean))];
    const parcViaCcb = Math.max(0, ...ccbsGrupo.map(c => parcelasPagasDe(normalizarCcb(c))));
    const parcViaCpf = Math.max(0, ...cpfsGrupo.map(c => parcelasPagasDe(normalizarCcb(c))));
    const matchPorCcb = parcViaCcb > 0;
    const matchPorCpf = parcViaCpf > 0;
    const cpfAmbiguo = cpfsGrupo.some(c => (gruposPorCpf.get(c) || new Set()).size > 1);
    const pagamentoNaTabela = matchPorCcb || (matchPorCpf && ccbsGrupo.length === 0 && !cpfAmbiguo);
    const casadoPorCpfComRessalva = !pagamentoNaTabela && matchPorCpf;
    const parcelasPagas = pagamentoNaTabela ? (matchPorCcb ? parcViaCcb : parcViaCpf) : 0;
    // restantes: só dá pra saber se conhecemos as parcelas cobertas
    const parcelasRestantes = parcelasCobertas != null ? Math.max(0, parcelasCobertas - parcelasPagas) : null;

    // ESCOPO: um comprovante só reclassifica o caso quando a coluna CASOS A PAGAR
    // da planilha já o considerava pagável ou em franquia. JÁ PAGO / PENDENTE /
    // NÃO PAGAR mantêm o que a planilha diz (só geram aviso). Decisão da operação.
    const planilhaPermiteOverride = ESCOPO_OVERRIDE_PAGAMENTO.has(catPlanilha);

    // ----- OVERRIDES DO CASO — vêm ANTES da coluna CASOS A PAGAR -----
    //  1) BLOQUEADO_REEMPREGO (config manual)      -> sai da operação
    //  2) JA_PAGO manual (config)                  -> JÁ PAGO (completo), decisão humana
    //  3) pagamento na tabela + planilha no escopo:
    //       parcelas_pagas >= cobertas            -> JÁ PAGO (completo)
    //       parcelas_pagas <  cobertas (ou desc.) -> segue A PAGAR (próxima parcela)
    //  4) AGUARDANDO_VALOR_MANUAL (config manual)  -> retido até preencher o valor
    let override = null;
    let confirmadoPorTabela = false;
    if (infoManual && infoManual.acao === 'BLOQUEADO_REEMPREGO') override = 'BLOQUEADO_REEMPREGO';
    else if (infoManual && infoManual.acao === 'JA_PAGO') override = 'JA_PAGO_COMPLETO';
    else if (pagamentoNaTabela && planilhaPermiteOverride) {
      confirmadoPorTabela = true;
      override = (parcelasRestantes != null && parcelasRestantes <= 0) ? 'JA_PAGO_COMPLETO' : 'PROXIMA_PARCELA';
    }
    else if (infoManual && infoManual.acao === 'AGUARDANDO_VALOR_MANUAL') override = 'AGUARDANDO_VALOR_MANUAL';

    if (casadoPorCpfComRessalva && !override) {
      nCasadoPorCpfComRessalva++;
      avisos.push(`"${rotulo}": um pagamento bate com o CPF, mas o caso tem CCB próprio (${ccbsGrupo.join(', ')}) ou o CPF aparece em mais de um empréstimo — NÃO reclassifiquei. Confira e adicione o CCB certo em pagamentos_confirmados.`);
    }
    const pagamentoForaDoEscopo = pagamentoNaTabela && !planilhaPermiteOverride && !override;
    if (pagamentoForaDoEscopo) {
      nPagamentoForaDoEscopo++;
      avisos.push(`"${rotulo}": ${parcelasPagas} parcela(s) em pagamentos_confirmados, mas a planilha classifica como "${P.CATEGORIA_ROTULO[catPlanilha] || catPlanilha}" — mantido como está (fora do escopo A PAGAR/PROGRAMADO/FRANQUIA). Confira manualmente.`);
    }

    let catCaso;
    let programadoLiberado = false;
    const jaPagoCompleto = override === 'JA_PAGO_COMPLETO';
    const proximaParcela = override === 'PROXIMA_PARCELA';
    const pagamentoConfirmado = jaPagoCompleto && confirmadoPorTabela;
    const bloqueado = override === 'BLOQUEADO_REEMPREGO';
    const aguardandoValorManual = override === 'AGUARDANDO_VALOR_MANUAL';

    if (jaPagoCompleto) {
      catCaso = 'JA_PAGO';
      nJaPagoCompleto++;
      if (confirmadoPorTabela) nPagamentoConfirmado++;
      if (catPlanilha === 'A_PAGAR' || catPlanilha === 'PROGRAMADO') nResgatadosDeAPagar++;
      const via = confirmadoPorTabela
        ? `comprovante (${parcelasPagas}/${parcelasCobertas ?? '?'} parcelas)`
        : 'config-pagamento.js (' + (infoManual && infoManual.nota ? infoManual.nota : 'manual') + ')';
      avisos.push(`"${rotulo}": JÁ PAGO (completo) via ${via} — a planilha dizia "${P.CATEGORIA_ROTULO[catPlanilha] || catPlanilha}".`);
    } else if (proximaParcela) {
      catCaso = 'A_PAGAR';                 // SEGUE a pagar: falta(m) parcela(s)
      nProximaParcela++;
      const falta = parcelasRestantes != null ? `${parcelasRestantes} parcela(s) restante(s)` : 'parcelas cobertas do produto desconhecidas';
      avisos.push(`"${rotulo}": ${parcelasPagas} parcela(s) paga(s) de ${parcelasCobertas ?? '?'} — SEGUE A PAGAR (${falta}).`);
    } else if (bloqueado) {
      catCaso = 'BLOQUEADO_REEMPREGO';
      nBloqueado++;
      avisos.push(`"${rotulo}": BLOQUEADO - REEMPREGO (config-pagamento.js) — fora de cobertura.`);
    } else if (aguardandoValorManual) {
      catCaso = 'AGUARDANDO_VALOR_MANUAL';
      nAguardandoValor++;
      avisos.push(`"${rotulo}": AGUARDANDO VALOR MANUAL — avulso pronto p/ pagamento, falta preencher o valor certo.`);
    } else {
      catCaso = catPlanilha;
      if (catCaso === 'PROGRAMADO') {
        if (liberarTodos || [...digitosGrupo].some(d => liberados.has(d))) {
          catCaso = 'A_PAGAR';
          programadoLiberado = true;
          avisos.push(`"${rotulo}": estava PROGRAMADO — liberado por conferência manual, entrou em A PAGAR.`);
        }
      }
    }

    if (catCaso === 'A_PAGAR' && !proximaParcela) {
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
      categoria_pagamento_planilha: catPlanilha,
      programado_liberado: programadoLiberado,
      pagamento_confirmado: pagamentoConfirmado,        // true só quando JÁ PAGO (completo) por comprovante
      pagamento_parcial: proximaParcela,                // achou pagamento, mas falta(m) parcela(s) — SEGUE A PAGAR
      pagamento_fora_do_escopo: pagamentoForaDoEscopo,  // achou pagamento, mas planilha = JÁ PAGO/PENDENTE/NÃO PAGAR
      bloqueado_reemprego: bloqueado,
      aguardando_valor_manual: aguardandoValorManual,
      parcelas_cobertas_produto: parcelasCobertas,
      parcelas_pagas: parcelasPagas,
      parcelas_restantes: parcelasRestantes,
      override_nota: (override && infoManual) ? (infoManual.nota || null) : null,
      classificacao_pagamento:
          jaPagoCompleto ? P.CATEGORIA_ROTULO.JA_PAGO_COMPLETO
        : proximaParcela ? (P.CATEGORIA_ROTULO.A_PAGAR_PROXIMA_PARCELA + (parcelasCobertas != null ? ` (${parcelasPagas}/${parcelasCobertas})` : ''))
        : bloqueado ? P.CATEGORIA_ROTULO.BLOQUEADO_REEMPREGO
        : aguardandoValorManual ? P.CATEGORIA_ROTULO.AGUARDANDO_VALOR_MANUAL
        : programadoLiberado ? 'A PAGAR (ex-PROGRAMADO)'
        : P.CATEGORIA_ROTULO[catCaso],
      franquia_ate: primeiro(regs, 'franquiaAte'),
      data_programada: primeiro(regs, 'programadoPara')
    });
  }

  return {
    casos, avisos, categorias,
    totalLinhas: linhas.length, ignoradas: semChave.length,
    overrides: {
      jaPagoCompleto: nJaPagoCompleto,
      proximaParcela: nProximaParcela,
      pagamentoForaDoEscopo: nPagamentoForaDoEscopo, // tem comprovante mas planilha = JÁ PAGO/PENDENTE/NÃO PAGAR
      pagamentoConfirmado: nPagamentoConfirmado,     // mantido p/ compat.: = nJaPagoCompleto por comprovante
      resgatadosDeAPagar: nResgatadosDeAPagar,
      bloqueadoReemprego: nBloqueado,
      aguardandoValorManual: nAguardandoValor,
      casadoPorCpfComRessalva: nCasadoPorCpfComRessalva
    }
  };
}

// Categorias da coluna CASOS A PAGAR em que um comprovante de pagamento PODE
// reclassificar o caso (para "próxima parcela" ou "JÁ PAGO completo"). Fora daqui
// (JÁ PAGO / PENDENTE / NÃO PAGAR) o comprovante só gera aviso.
const ESCOPO_OVERRIDE_PAGAMENTO = new Set(['A_PAGAR', 'PROGRAMADO', 'AGUARDANDO_FRANQUIA']);

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

  // Caso com pagamento parcial: o que falta pagar é a PRÓXIMA parcela (1 só),
  // no valor de sempre limitado pelo teto do catálogo — nunca o total.
  if (caso.pagamento_parcial) {
    let base = (r.valorAPagar != null) ? r.valorAPagar
             : (caso.valor_a_pagar_planilha != null) ? Number(caso.valor_a_pagar_planilha)
             : (r.valorTotalAPagar != null && caso.parcelas_cobertas_produto ? r.valorTotalAPagar / caso.parcelas_cobertas_produto : null);
    if (base != null && r.tetoParcelaProduto != null) base = Math.min(Number(base), Number(r.tetoParcelaProduto));
    caso.valor_a_pagar_final = base != null ? Math.round(base * 100) / 100 : caso.valor_a_pagar_final;
  }
  return caso;
}

module.exports = { transformar, aplicarMotor, brl };
