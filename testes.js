// ============================================================================
// Testes das regras puras (sem banco / sem xlsx).  Rode: npm test
// ============================================================================
const assert = require('assert');
const regras = require('./regras');
const ident = require('./identidade');
const P = require('./planilha-parse');
const { transformar, aplicarMotor } = require('./planilha-transform');

let ok = 0, falhas = 0;
function teste(nome, fn) {
  try { fn(); ok++; console.log('  ok   ' + nome); }
  catch (e) { falhas++; console.log('  FAIL ' + nome + '\n         ' + e.message); }
}

console.log('\n— Catálogo de parceiros / unificação de nome —');

teste('Fintech do Corban cobre 4 parcelas (era 3)', () => {
  assert.strictEqual(regras.produtoDoParceiro('Fintech do Corban').parcelasCobertas, 4);
});
teste('"Fintech Corban" e "Fintech do Corban" viram o mesmo parceiro', () => {
  assert.strictEqual(regras.normalizarParceiro('Fintech Corban'), 'Fintech do Corban');
  assert.strictEqual(regras.normalizarParceiro('FINTECH CORBAN'), 'Fintech do Corban');
  assert.strictEqual(regras.normalizarParceiro('  fintech  do corban '), 'Fintech do Corban');
});
teste('SETHI: 6 parcelas, teto 1000', () => {
  const p = regras.produtoDoParceiro('SETHI');
  assert.strictEqual(p.parcelasCobertas, 6); assert.strictEqual(p.tetoParcela, 1000);
});
teste('Granatech: 6 parcelas, teto parcela 500, teto total 3000', () => {
  const p = regras.produtoDoParceiro('Granatech');
  assert.strictEqual(p.parcelasCobertas, 6); assert.strictEqual(p.tetoParcela, 500); assert.strictEqual(p.tetoTotal, 3000);
});
teste('POUPACRED depende do FUNDO — Guardian/BMP => 6 parcelas / teto 500', () => {
  const p = regras.produtoDoParceiro('POUPACRED', 'Fundo Guardian (BMP)');
  assert.strictEqual(p.parcelasCobertas, 6); assert.strictEqual(p.tetoParcela, 500);
});
teste('POUPACRED — Poupa Seguros / Via Capital SCD => 3 parcelas / teto 1000', () => {
  const p = regras.produtoDoParceiro('POUPACRED', 'Poupa Seguros - Via Capital SCD');
  assert.strictEqual(p.parcelasCobertas, 3); assert.strictEqual(p.tetoParcela, 1000);
});
teste('POUPACRED sem fundo identificável => não resolve (fica pra revisão)', () => {
  const p = regras.produtoDoParceiro('POUPACRED', 'fundo desconhecido');
  assert.strictEqual(p.parcelasCobertas, null); assert.strictEqual(p.fundoResolvido, false);
});
teste('Fundo "GPC Fundo de Investimento em Direitos Creditórios" == Guardian (6 parc / teto 500)', () => {
  assert.strictEqual(regras.normalizarFundo('GPC Fundo de Investimento em Direitos Creditórios'), 'Guardian');
  const p = regras.produtoDoParceiro('POUPACRED', 'GPC Fundo de Investimento em Direitos Creditórios');
  assert.strictEqual(p.parcelasCobertas, 6);
  assert.strictEqual(p.tetoParcela, 500);
  assert.strictEqual(p.fundoResolvido, true);
});
teste('Invest All: 6 / 1000 ; Nova e Resgata Ai (fundo LA VIE): 3 / sem teto cada, parceiros separados', () => {
  assert.strictEqual(regras.produtoDoParceiro('Invest All').tetoParcela, 1000);
  assert.strictEqual(regras.normalizarParceiro('Nova'), 'Nova');
  assert.strictEqual(regras.normalizarParceiro('Resgata Aí'), 'Resgata Ai');
  assert.strictEqual(regras.produtoDoParceiro('Nova').tetoParcela, null);
  assert.strictEqual(regras.produtoDoParceiro('Resgata Ai').tetoParcela, null);
  assert.strictEqual(regras.produtoDoParceiro('Nova').parcelasCobertas, 3);
  assert.strictEqual(regras.produtoDoParceiro('Resgata Ai').parcelasCobertas, 3);
});
teste('X3 (fundo X ao Cubo): 6 parcelas, teto 1000, sem teto total', () => {
  assert.strictEqual(regras.normalizarParceiro('X 3'), 'X3');
  assert.strictEqual(regras.normalizarParceiro('x3'), 'X3');
  const p = regras.produtoDoParceiro('X 3');
  assert.strictEqual(p.noCatalogo, true);
  assert.strictEqual(p.parcelasCobertas, 6);
  assert.strictEqual(p.tetoParcela, 1000);
  assert.strictEqual(p.tetoTotal, null);
});

console.log('\n— Motor de regras (elegibilidade/carência/franquia inalterados) —');

teste('valor a pagar = min(parcela, teto do catálogo)', () => {
  const r = regras.calcularCaso({ parceiro: 'SETHI', valor_parcela: 1500, data_contratacao: '2025-01-01', data_evento: '2025-06-01', data_admissao: '2020-01-01', motivo_desligamento_codigo: '2' });
  assert.strictEqual(r.valorAPagar, 1000);
  assert.strictEqual(r.parcelasCobertas, 6);
  assert.strictEqual(r.valorTotalAPagar, 6000);
});
teste('Granatech respeita o teto TOTAL de 3000', () => {
  const r = regras.calcularCaso({ parceiro: 'Granatech', valor_parcela: 500, data_contratacao: '2025-01-01', data_evento: '2025-06-01', data_admissao: '2020-01-01', motivo_desligamento_codigo: '2' });
  assert.strictEqual(r.valorAPagar, 500);
  assert.strictEqual(r.valorTotalAPagar, 3000); // 6*500 limitado a 3000
});
teste('carência < 31 dias continua NEGADO', () => {
  const r = regras.calcularCaso({ parceiro: 'SETHI', valor_parcela: 900, data_contratacao: '2025-05-15', data_evento: '2025-06-01', data_admissao: '2020-01-01', motivo_desligamento_codigo: '2' });
  assert.strictEqual(r.status, 'NEGADO');
});
teste('motivo fora de cobertura continua NEGADO', () => {
  const r = regras.calcularCaso({ parceiro: 'SETHI', valor_parcela: 900, data_contratacao: '2024-01-01', data_evento: '2025-06-01', data_admissao: '2020-01-01', motivo_desligamento_codigo: '7' });
  assert.strictEqual(r.status, 'NEGADO');
});

console.log('\n— Identidade: CPF com zero à esquerda / CCB composto / dedupe —');

teste('CPF ganha zero à esquerda (11 dígitos)', () => {
  assert.strictEqual(ident.normalizarCpf('1234567890'), '01234567890');
  assert.strictEqual(ident.normalizarCpf('012.345.678-90'), '01234567890');
});
teste('CCB composto "123/456" é separado antes de comparar', () => {
  assert.deepStrictEqual(ident.separarCcbComposto('123/456'), ['123', '456']);
  assert.deepStrictEqual(ident.separarCcbComposto('123 e 456'), ['123', '456']);
});
teste('não separa CPF pontuado', () => {
  assert.deepStrictEqual(ident.separarCcbComposto('123.456.789-01'), ['123.456.789-01']);
});
teste('MESMO CPF+CCB reenviado (CPF com/sem zero) = 1 caso, valor NÃO somado', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [
    { __linha: 2, col0: 'Maria', col1: '1234567890 / 555000', col2: 'Fintech Corban', col3: 'SIM', col4: '1200' },
    { __linha: 3, col0: 'Maria', col1: '012.345.678-90 / 555000', col2: 'Fintech do Corban', col3: '', col4: '1200' }
  ];
  const r = transformar(mapa, linhas);
  assert.strictEqual(r.casos.length, 1);
  assert.strictEqual(regras.normalizarParceiro(r.casos[0].parceiro_bruto), 'Fintech do Corban');
  assert.strictEqual(r.casos[0].casos_a_pagar, 1);
  assert.strictEqual(r.casos[0].valor_a_pagar_planilha, 1200); // não 2400
});

teste('CCB composto "123/456" partido em 2 linhas (mesmo CPF) = 1 caso', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [
    { __linha: 2, col0: 'Ana', col1: '11122233344 / 123', col2: 'SETHI', col3: 'SIM', col4: '800' },
    { __linha: 3, col0: 'Ana', col1: '11122233344 / 456', col2: 'SETHI', col3: 'SIM', col4: '800' },
    { __linha: 4, col0: 'Ana', col1: '11122233344 / 123 / 456', col2: 'SETHI', col3: 'SIM', col4: '800' }
  ];
  const r = transformar(mapa, linhas);
  assert.strictEqual(r.casos.length, 1);
  assert.strictEqual(r.casos[0].valor_a_pagar_planilha, 800);
});

teste('MESMO CPF, CCBs DIFERENTES = casos SEPARADOS, cada um com seu valor', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [
    { __linha: 2, col0: 'Zé', col1: '99988877766 / 1000', col2: 'SETHI', col3: 'SIM', col4: '700' },
    { __linha: 3, col0: 'Zé', col1: '99988877766 / 2000', col2: 'SETHI', col3: 'SIM', col4: '900' }
  ];
  const r = transformar(mapa, linhas);
  assert.strictEqual(r.casos.length, 2);
  const valores = r.casos.map(c => c.valor_a_pagar_planilha).sort();
  assert.deepStrictEqual(valores, [700, 900]); // nada somado, nada descartado
});

console.log('\n— Pagamentos confirmados / casos manuais: overrides ANTES da coluna CASOS A PAGAR —');

teste('normalizarCcb: só dígitos, sem zeros à esquerda', () => {
  assert.strictEqual(ident.normalizarCcb('008.000.073-62'), '800007362');
  assert.strictEqual(ident.normalizarCcb('CCB 0004701'), '4701');
  assert.strictEqual(ident.normalizarCcb('00800007362'), '800007362'); // CPF-fake SETHI com zero
  assert.strictEqual(ident.normalizarCcb('0'), null);
  assert.strictEqual(ident.normalizarCcb(''), null);
});

teste('conciliação parcela a parcela: 6 de 6 pagas => JÁ PAGO (completo), sai de A PAGAR', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_parcela: 4, data_contratacao: 5, data_evento: 6, data_admissao: 7, motivo_desligamento_codigo: 8 };
  const linhas = [{ __linha: 2, col0: 'Sethi Completo', col1: '70000000001', col2: 'SETHI', col3: 'PAGAR', col4: '900', col5: '2025-01-01', col6: '2025-06-01', col7: '2020-01-01', col8: '2' }];
  const r = transformar(mapa, linhas, { pagamentosConfirmados: new Map([['70000000001', 6]]) });
  const c = r.casos.map(aplicarMotor)[0];
  assert.strictEqual(c.categoria_pagamento, 'JA_PAGO');
  assert.strictEqual(c.casos_a_pagar, 0);
  assert.strictEqual(c.pagamento_confirmado, true);
  assert.strictEqual(c.classificacao_pagamento, 'JÁ PAGO (completo)');
  assert.strictEqual(c.parcelas_pagas, 6);
  assert.strictEqual(c.parcelas_restantes, 0);
  assert.strictEqual(r.overrides.jaPagoCompleto, 1);
});

teste('conciliação parcela a parcela: 2 de 6 pagas => SEGUE A PAGAR (próxima parcela)', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_parcela: 4, data_contratacao: 5, data_evento: 6, data_admissao: 7, motivo_desligamento_codigo: 8 };
  const linhas = [{ __linha: 2, col0: 'Sethi Parcial', col1: '70000000002', col2: 'SETHI', col3: 'PAGAR', col4: '1500', col5: '2025-01-01', col6: '2025-06-01', col7: '2020-01-01', col8: '2' }];
  const r = transformar(mapa, linhas, { pagamentosConfirmados: new Map([['70000000002', 2]]) });
  const c = r.casos.map(aplicarMotor)[0];
  assert.strictEqual(c.categoria_pagamento, 'A_PAGAR');
  assert.strictEqual(c.casos_a_pagar, 1);            // NÃO desaparece
  assert.strictEqual(c.pagamento_parcial, true);
  assert.strictEqual(c.parcelas_pagas, 2);
  assert.strictEqual(c.parcelas_restantes, 4);
  assert.strictEqual(c.valor_a_pagar_final, 1000);   // próxima parcela = min(1500, teto SETHI 1000)
  assert.ok(/próxima parcela \(2\/6\)/.test(c.classificacao_pagamento), c.classificacao_pagamento);
  assert.strictEqual(r.overrides.proximaParcela, 1);
});

teste('escopo: comprovante NÃO reclassifica caso que a planilha diz JÁ PAGO / NÃO PAGAR', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_parcela: 4 };
  const linhas = [
    { __linha: 2, col0: 'Ja Pago Planilha', col1: '70000000010', col2: 'SETHI', col3: 'PAGO', col4: '900' },
    { __linha: 3, col0: 'Nao Pagar', col1: '70000000011', col2: 'SETHI', col3: 'NAO PAGAR', col4: '900' },
    { __linha: 4, col0: 'Em Franquia', col1: '70000000012', col2: 'SETHI', col3: 'ELEGIVEL - FRANQUIA ATE 01/02/2026', col4: '900' }
  ];
  const pg = new Map([['70000000010', 2], ['70000000011', 2], ['70000000012', 2]]);
  const r = transformar(mapa, linhas, { pagamentosConfirmados: pg });
  const jp = r.casos.find(c => c.segurado === 'Ja Pago Planilha');
  const np = r.casos.find(c => c.segurado === 'Nao Pagar');
  const fr = r.casos.find(c => c.segurado === 'Em Franquia');
  assert.strictEqual(jp.categoria_pagamento, 'JA_PAGO');           // mantido
  assert.strictEqual(jp.casos_a_pagar, 0);
  assert.strictEqual(np.categoria_pagamento, 'NAO_PAGAR');          // mantido
  assert.strictEqual(np.casos_a_pagar, 0);
  assert.strictEqual(fr.categoria_pagamento, 'A_PAGAR');            // franquia ESTÁ no escopo
  assert.strictEqual(fr.pagamento_parcial, true);
  assert.strictEqual(r.overrides.pagamentoForaDoEscopo, 2);        // JÁ PAGO + NÃO PAGAR
  assert.strictEqual(r.overrides.proximaParcela, 1);               // só o de franquia
  // parcelas_pagas fica registrado mesmo fora do escopo
  assert.strictEqual(jp.parcelas_pagas, 2);
});

teste('Set (compat.) = 1 parcela paga: SETHI com 6 cobertas => segue A PAGAR', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_parcela: 4, data_contratacao: 5, data_evento: 6, data_admissao: 7, motivo_desligamento_codigo: 8 };
  const linhas = [{ __linha: 2, col0: 'Sethi Set', col1: '008.000.073-62', col2: 'SETHI', col3: 'PAGAR', col4: '900', col5: '2025-01-01', col6: '2025-06-01', col7: '2020-01-01', col8: '2' }];
  const r = transformar(mapa, linhas, { pagamentosConfirmados: new Set(['800007362']) });
  const c = r.casos.map(aplicarMotor)[0];
  assert.strictEqual(c.casos_a_pagar, 1);
  assert.strictEqual(c.parcelas_pagas, 1);
  assert.strictEqual(c.parcelas_restantes, 5);
});

teste('pagamento casa por CPF mas o caso tem CCB próprio => NÃO reclassifica (ressalva)', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [{ __linha: 2, col0: 'Com CCB', col1: '11122233344 / 5000', col2: 'POUPACRED', col3: 'PAGAR', col4: '1000' }];
  // a tabela tem o CPF, não o CCB 5000
  const r = transformar(mapa, linhas, { pagamentosConfirmados: new Map([['11122233344', 6]]) });
  assert.strictEqual(r.casos[0].pagamento_confirmado, false);
  assert.strictEqual(r.casos[0].casos_a_pagar, 1);              // segue A PAGAR pela planilha
  assert.strictEqual(r.overrides.casadoPorCpfComRessalva, 1);
});

teste('mesmo CPF em 2 empréstimos (CCBs diferentes), CPF na tabela => nenhum reclassifica', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [
    { __linha: 2, col0: 'Zé', col1: '99988877766 / 1000', col2: 'SETHI', col3: 'PAGAR', col4: '700' },
    { __linha: 3, col0: 'Zé', col1: '99988877766 / 2000', col2: 'SETHI', col3: 'PAGAR', col4: '900' }
  ];
  const r = transformar(mapa, linhas, { pagamentosConfirmados: new Map([['99988877766', 3]]) });
  assert.strictEqual(r.casos.length, 2);
  assert.strictEqual(r.casos.every(c => c.pagamento_confirmado === false && c.pagamento_parcial === false), true);
  assert.strictEqual(r.overrides.casadoPorCpfComRessalva, 2);
});

teste('casosManuais: BLOQUEADO_REEMPREGO sai da operação (nem a pagar, nem já pago)', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [{ __linha: 2, col0: 'Willian', col1: '008.000.073-62', col2: 'SETHI', col3: 'PAGAR', col4: '281.30' }];
  const manuais = new Map([['800007362', { acao: 'BLOQUEADO_REEMPREGO', nota: 'reemprego' }]]);
  const r = transformar(mapa, linhas, { casosManuais: manuais });
  assert.strictEqual(r.casos[0].categoria_pagamento, 'BLOQUEADO_REEMPREGO');
  assert.strictEqual(r.casos[0].casos_a_pagar, 0);
  assert.strictEqual(r.casos[0].bloqueado_reemprego, true);
  assert.strictEqual(r.casos[0].classificacao_pagamento, 'BLOQUEADO - REEMPREGO');
  assert.strictEqual(r.overrides.bloqueadoReemprego, 1);
});

teste('casosManuais: AGUARDANDO_VALOR_MANUAL retém o caso fora de A PAGAR', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [{ __linha: 2, col0: 'Maiane', col1: '008.000.166-46', col2: 'SETHI', col3: 'PAGAR', col4: '0' }];
  const manuais = new Map([['800016646', { acao: 'AGUARDANDO_VALOR_MANUAL', nota: 'falta valor' }]]);
  const r = transformar(mapa, linhas, { casosManuais: manuais });
  assert.strictEqual(r.casos[0].categoria_pagamento, 'AGUARDANDO_VALOR_MANUAL');
  assert.strictEqual(r.casos[0].casos_a_pagar, 0);
  assert.strictEqual(r.casos[0].classificacao_pagamento, 'AGUARDANDO VALOR MANUAL');
  assert.strictEqual(r.overrides.aguardandoValorManual, 1);
});

teste('casosManuais: acao JA_PAGO (casado por CPF) => JÁ PAGO (completo), independe de parcelas', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [{ __linha: 2, col0: 'MICHAEL MADRUGA MARTINS', col1: '023.688.770-02', col2: 'NOVA PROMOTORA', col3: 'PAGAR', col4: '525.12' }];
  const manuais = new Map([['2368877002', { acao: 'JA_PAGO', nota: 'confirmado por nome' }]]);
  const r = transformar(mapa, linhas, { casosManuais: manuais });
  assert.strictEqual(r.casos[0].categoria_pagamento, 'JA_PAGO');
  assert.strictEqual(r.casos[0].casos_a_pagar, 0);
  assert.strictEqual(r.casos[0].classificacao_pagamento, 'JÁ PAGO (completo)');
  assert.strictEqual(r.overrides.jaPagoCompleto, 1);
});

teste('BLOQUEADO_REEMPREGO vence até o pagamento confirmado', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [{ __linha: 2, col0: 'Willian', col1: '008.000.073-62', col2: 'SETHI', col3: 'PAGAR', col4: '281.30' }];
  const manuais = new Map([['800007362', { acao: 'BLOQUEADO_REEMPREGO', nota: 'reemprego' }]]);
  const r = transformar(mapa, linhas, { casosManuais: manuais, pagamentosConfirmados: new Map([['800007362', 6]]) });
  assert.strictEqual(r.casos[0].categoria_pagamento, 'BLOQUEADO_REEMPREGO');
});

console.log('\n— Planilha: CASOS A PAGAR decide, STATUS é só etiqueta —');

teste('CASOS A PAGAR classifica por PREFIXO (sem acento, maiúsc., sem espaço)', () => {
  const c = s => P.parseCasosAPagar(s);
  assert.strictEqual(c('PAGAR').categoria, 'A_PAGAR');
  assert.strictEqual(c('pagar - formato legado').categoria, 'A_PAGAR');
  assert.strictEqual(c('ELEGÍVEL - PRONTO PARA PAGAMENTO').categoria, 'A_PAGAR');
  assert.strictEqual(c('elegivel-pronto').categoria, 'A_PAGAR');
  assert.strictEqual(c('LIBERADO - BASE LEGADA').categoria, 'A_PAGAR');
  assert.strictEqual(c('SIM').aPagar, true);
});
teste('CASOS A PAGAR: FRANQUIA ATÉ vira status próprio e guarda a data', () => {
  const r = P.parseCasosAPagar('ELEGÍVEL - FRANQUIA ATÉ 15/03/2026');
  assert.strictEqual(r.categoria, 'AGUARDANDO_FRANQUIA');
  assert.strictEqual(r.aPagar, false);
  assert.strictEqual(r.avisar, false);
  assert.strictEqual(r.franquiaAte, '2026-03-15');
});
teste('CASOS A PAGAR: PAGO / DEVIDO - PAGO => JÁ PAGO, sem aviso, não conta como a pagar', () => {
  assert.strictEqual(P.parseCasosAPagar('PAGO').categoria, 'JA_PAGO');
  assert.strictEqual(P.parseCasosAPagar('DEVIDO - PAGO EM 04/2025').categoria, 'JA_PAGO');
  assert.strictEqual(P.parseCasosAPagar('PAGO').avisar, false);
  assert.strictEqual(P.parseCasosAPagar('PAGO').aPagar, false);
});
teste('CASOS A PAGAR: NEGADO / NÃO PAGAR => NÃO PAGAR, sem aviso', () => {
  assert.strictEqual(P.parseCasosAPagar('NEGADO - fora de cobertura').categoria, 'NAO_PAGAR');
  assert.strictEqual(P.parseCasosAPagar('NAO PAGAR').categoria, 'NAO_PAGAR');
  assert.strictEqual(P.parseCasosAPagar('NEGADO').avisar, false);
});
teste('CASOS A PAGAR: prefixos novos (caso especial / já em pagamento / franquia a partir de / em análise)', () => {
  assert.strictEqual(P.parseCasosAPagar('ELEGIVEL - CASO ESPECIAL APROVADO').categoria, 'A_PAGAR');
  assert.strictEqual(P.parseCasosAPagar('ELEGIVEL - CASO JA EM PAGAMENTO').categoria, 'A_PAGAR');
  const f = P.parseCasosAPagar('ELEGIVEL - FRANQUIA A PARTIR DE 10/10/2026');
  assert.strictEqual(f.categoria, 'AGUARDANDO_FRANQUIA');
  assert.strictEqual(f.franquiaAte, '2026-10-10');
  assert.strictEqual(P.parseCasosAPagar('EM ANÁLISE').categoria, 'AGUARDANDO_DOCUMENTACAO');
  assert.strictEqual(P.parseCasosAPagar('AGUARDANDO DOCUMENTACAO').categoria, 'AGUARDANDO_DOCUMENTACAO');
  assert.strictEqual(P.parseCasosAPagar('EM ANÁLISE').avisar, false);
});
teste('CASOS A PAGAR: PROGRAMADO PARA PAGAMENTO NÃO entra como a pagar; guarda a data', () => {
  const r = P.parseCasosAPagar('ELEGIVEL - PROGRAMADO PARA PAGAMENTO 02/09/2026');
  assert.strictEqual(r.categoria, 'PROGRAMADO');
  assert.strictEqual(r.aPagar, false);
  assert.strictEqual(r.avisar, false);
  assert.strictEqual(r.programadoPara, '2026-09-02');

  // no caso: PROGRAMADO vence até se houver uma linha "PAGAR" junto
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3 };
  const linhas = [
    { __linha: 1631, col0: 'SEG X', col1: '70000000001 / 999', col2: 'SETHI', col3: 'ELEGIVEL - PROGRAMADO PARA PAGAMENTO 02/09/2026' },
    { __linha: 1632, col0: 'SEG X', col1: '70000000001 / 999', col2: 'SETHI', col3: 'PAGAR' }
  ];
  const t = transformar(mapa, linhas);
  assert.strictEqual(t.casos.length, 1);
  assert.strictEqual(t.casos[0].categoria_pagamento, 'PROGRAMADO');
  assert.strictEqual(t.casos[0].casos_a_pagar, 0);
  assert.strictEqual(t.casos[0].data_programada, '2026-09-02');
});
teste('PROGRAMADO liberado por conferência (CCB na allowlist) => entra em A PAGAR', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [
    { __linha: 1630, col0: 'Isabella 1', col1: '80000000001 / 4701', col2: 'POUPACRED', col3: 'ELEGIVEL - PROGRAMADO PARA PAGAMENTO 02/09/2026', col4: '1000' },
    { __linha: 1631, col0: 'Isabella 2', col1: '80000000002 / 4702', col2: 'POUPACRED', col3: 'ELEGIVEL - PROGRAMADO PARA PAGAMENTO 02/09/2026', col4: '1000' }
  ];
  // libera só o 4701
  const t1 = transformar(mapa, linhas, { liberadosChaves: new Set(['4701']) });
  const c1 = t1.casos.find(c => c.segurado === 'Isabella 1');
  const c2 = t1.casos.find(c => c.segurado === 'Isabella 2');
  assert.strictEqual(c1.casos_a_pagar, 1);
  assert.strictEqual(c1.programado_liberado, true);
  assert.strictEqual(c1.classificacao_pagamento, 'A PAGAR (ex-PROGRAMADO)');
  assert.strictEqual(c2.casos_a_pagar, 0);

  // libera todos
  const t2 = transformar(mapa, linhas, { liberarProgramadosTodos: true });
  assert.strictEqual(t2.casos.every(c => c.casos_a_pagar === 1), true);
});
teste('Parceiro fora do catálogo (desconhecido / vazio / "1573") => NÃO entra em A PAGAR', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_a_pagar: 4 };
  const linhas = [
    { __linha: 2, col0: 'Fulano Desconhecido', col1: '90000000001', col2: 'PARCEIRO NOVO SEM CADASTRO', col3: 'PAGAR', col4: '200' },
    { __linha: 3, col0: 'Sem Parc', col1: '90000000002', col2: '', col3: 'PAGAR', col4: '300' },
    { __linha: 4, col0: 'Erro Dig', col1: '90000000003', col2: '1573', col3: 'PAGAR', col4: '400' },
    { __linha: 5, col0: 'Ok Sethi', col1: '90000000004', col2: 'SETHI', col3: 'PAGAR', col4: '500' }
  ];
  const t = transformar(mapa, linhas).casos;
  assert.strictEqual(t.find(c => c.segurado === 'Fulano Desconhecido').categoria_pagamento, 'PARCEIRO_NAO_IDENTIFICADO');
  assert.strictEqual(t.find(c => c.segurado === 'Fulano Desconhecido').casos_a_pagar, 0);
  assert.strictEqual(t.find(c => c.segurado === 'Sem Parc').casos_a_pagar, 0);
  assert.strictEqual(t.find(c => c.segurado === 'Erro Dig').casos_a_pagar, 0);
  assert.strictEqual(t.find(c => c.segurado === 'Ok Sethi').casos_a_pagar, 1);
});
teste('Divergência catálogo x planilha (AP/AQ) é sinalizada, catálogo manda', () => {
  const mapa = {
    segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, valor_parcela: 4,
    data_contratacao: 5, data_evento: 6, data_admissao: 7, motivo_desligamento_codigo: 8,
    numero_parcelas_cobertas_produto: 9, teto_parcela_produto: 10
  };
  // SETHI catálogo = 6 parcelas / teto 1000; planilha diz 4 / 800
  const linhas = [{
    __linha: 2, col0: 'Diverge', col1: '91000000001', col2: 'SETHI', col3: 'PAGAR', col4: '1500',
    col5: '2025-01-01', col6: '2025-06-01', col7: '2020-01-01', col8: '2', col9: '4', col10: '800'
  }];
  const c = transformar(mapa, linhas).casos.map(aplicarMotor)[0];
  assert.strictEqual(c.numero_parcelas_cobertas_produto, 6);      // catálogo mandou
  assert.strictEqual(c.teto_parcela_produto, 1000);
  assert.ok(/catálogo 6 x planilha 4/.test(c.divergencia_produto), c.divergencia_produto);
  assert.ok(/teto parcela/.test(c.divergencia_produto), c.divergencia_produto);
});
teste('CASOS A PAGAR: vazio => PENDENTE (sem aviso); lixo => NÃO RECONHECIDO (com aviso)', () => {
  assert.strictEqual(P.parseCasosAPagar('').categoria, 'PENDENTE');
  assert.strictEqual(P.parseCasosAPagar('').avisar, false);
  assert.strictEqual(P.parseCasosAPagar('xyzabc').categoria, 'NAO_RECONHECIDO');
  assert.strictEqual(P.parseCasosAPagar('xyzabc').avisar, true);
});
teste('contagem por categoria soma o total de linhas lidas', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3 };
  const linhas = [
    { __linha: 2, col0: 'A', col1: '10000000001', col2: 'SETHI', col3: 'PAGAR' },
    { __linha: 3, col0: 'B', col1: '10000000002', col2: 'SETHI', col3: 'ELEGÍVEL - PRONTO PARA PAGAMENTO' },
    { __linha: 4, col0: 'C', col1: '10000000003', col2: 'SETHI', col3: 'ELEGÍVEL - FRANQUIA ATÉ 01/02/2026' },
    { __linha: 5, col0: 'D', col1: '10000000004', col2: 'SETHI', col3: 'PAGO' },
    { __linha: 6, col0: 'E', col1: '10000000005', col2: 'SETHI', col3: 'NEGADO' },
    { __linha: 7, col0: 'F', col1: '10000000006', col2: 'SETHI', col3: '' },
    { __linha: 8, col0: 'G', col1: '10000000007', col2: 'SETHI', col3: 'coisa estranha' }
  ];
  const r = transformar(mapa, linhas);
  const soma = Object.values(r.categorias).reduce((s, n) => s + n, 0);
  assert.strictEqual(soma, r.totalLinhas);
  assert.strictEqual(r.categorias.A_PAGAR, 2);
  assert.strictEqual(r.categorias.AGUARDANDO_FRANQUIA, 1);
  assert.strictEqual(r.categorias.JA_PAGO, 1);
  assert.strictEqual(r.categorias.NAO_PAGAR, 1);
  assert.strictEqual(r.categorias.PENDENTE, 1);
  assert.strictEqual(r.categorias.NAO_RECONHECIDO, 1);
  const cA = r.casos.find(c => c.segurado === 'A');
  const cC = r.casos.find(c => c.segurado === 'C');
  assert.strictEqual(cA.casos_a_pagar, 1);
  assert.strictEqual(cC.casos_a_pagar, 0);
  assert.strictEqual(cC.classificacao_pagamento, 'AGUARDANDO FIM DA FRANQUIA');
  assert.strictEqual(cC.franquia_ate, '2026-02-01');
});
teste('STATUS "PAGO" NÃO marca pagamento; só CASOS A PAGAR marca', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, casos_a_pagar: 3, status: 4, valor_a_pagar: 5, valor_parcela: 6 };
  const linhas = [
    { __linha: 2, col0: 'A', col1: '11111111111', col2: 'SETHI', col3: 'NAO', col4: 'PAGO', col5: '', col6: '900' },
    { __linha: 3, col0: 'B', col1: '22222222222', col2: 'SETHI', col3: 'SIM', col4: 'EM ANALISE', col5: '900', col6: '900' }
  ];
  const casos = transformar(mapa, linhas).casos.map(aplicarMotor);
  const a = casos.find(c => c.segurado === 'A');
  const b = casos.find(c => c.segurado === 'B');
  assert.strictEqual(a.casos_a_pagar, 0);
  assert.strictEqual(b.casos_a_pagar, 1);
});
teste('valor_a_pagar_final: usa a planilha quando há; senão o total do motor', () => {
  const mapa = { segurado: 0, cpf_ccb: 1, parceiro: 2, fundo: 3, casos_a_pagar: 4, valor_a_pagar: 5, valor_parcela: 6, data_contratacao: 7, data_evento: 8, data_admissao: 9, motivo_desligamento_codigo: 10 };
  const linhas = [
    { __linha: 2, col0: 'ComPlanilha', col1: '33333333333', col2: 'POUPACRED', col3: 'Via Capital SCD', col4: 'SIM', col5: '2500', col6: '1200', col7: '2025-01-01', col8: '2025-06-01', col9: '2020-01-01', col10: '2' },
    { __linha: 3, col0: 'SemPlanilha', col1: '44444444444', col2: 'POUPACRED', col3: 'Via Capital SCD', col4: 'SIM', col5: '', col6: '1200', col7: '2025-01-01', col8: '2025-06-01', col9: '2020-01-01', col10: '2' }
  ];
  const casos = transformar(mapa, linhas).casos.map(aplicarMotor);
  const cp = casos.find(c => c.segurado === 'ComPlanilha');
  const sp = casos.find(c => c.segurado === 'SemPlanilha');
  assert.strictEqual(cp.valor_a_pagar_final, 2500);            // veio da planilha
  assert.strictEqual(sp.valor_a_pagar, 1000);                  // min(1200, teto 1000)
  assert.strictEqual(sp.valor_a_pagar_final, 3000);            // 3 parcelas * 1000
});
teste('datas pt-BR e serial do Excel', () => {
  assert.strictEqual(P.parseData('03/09/2025'), '2025-09-03');
  assert.strictEqual(P.parseData('2025-09-03'), '2025-09-03');
  assert.strictEqual(P.parseMesAno('mar/2025'), '2025-03');
  assert.strictEqual(P.parseMesAno('Feb-26'), '2026-02');   // abrev. em inglês
  assert.strictEqual(P.parseMesAno('Sep-26'), '2026-09');
  assert.strictEqual(P.parseMesAno('fev/2026'), '2026-02'); // abrev. em português
});

console.log('\n— Extração local (sem API paga): OCR/regex + Dataprev + conferência —');

const extr = require('./extracao');

teste('Dataprev JSON: lê motivo e data de desligamento direto (sem regex adivinhando)', () => {
  const r = extr.extrairCamposLocal({ nomeArquivo: 'dp.json', extensao: '.json',
    texto: JSON.stringify({ nome: 'F', cpf: '00123456789', dataDesligamento: '2025-06-15', codigoMotivoDesligamento: '2', dataAdmissao: '2019-01-02' }) });
  assert.strictEqual(r.tipoDoc, 'DATAPREV');
  assert.strictEqual(r.campos.data_evento, '2025-06-15');
  assert.strictEqual(r.campos.motivo_desligamento_codigo, '2');
  assert.strictEqual(r.confianca.data_evento, 'alta');
});
teste('CCB por regex: pega CPF, datas e valor da parcela', () => {
  const r = extr.extrairCamposLocal({ nomeArquivo: 'ccb.pdf', extensao: '.pdf',
    texto: 'CEDULA DE CREDITO BANCARIO SETHI CPF: 123.456.789-01 Data de contratacao: 10/01/2025 Valor da parcela: R$ 850,00 admissao 05/03/2019' });
  assert.strictEqual(r.campos.valor_parcela, 850);
  assert.strictEqual(r.campos.data_contratacao, '2025-01-10');
  assert.strictEqual(r.campos.parceiro, 'SETHI');
});
teste('campo obrigatório ausente -> precisa conferência, com o motivo nomeando o campo', () => {
  const r = extr.extrairCamposLocal({ nomeArquivo: 'ccb.pdf', extensao: '.pdf',
    texto: 'CCB CPF 123.456.789-01 contratacao 10/01/2025' });
  assert.strictEqual(r.precisaConferencia, true);
  assert.ok(/data_evento/.test(r.motivoConferencia), r.motivoConferencia);
});
teste('CCB + Dataprev juntos completam os obrigatórios -> NÃO precisa conferência', () => {
  const ccb = extr.extrairCamposLocal({ nomeArquivo: 'ccb.pdf', extensao: '.pdf',
    texto: 'CEDULA DE CREDITO BANCARIO SETHI CPF: 123.456.789-01 contratacao 10/01/2025 parcela R$ 900,00' });
  const dp = extr.extrairCamposLocal({ nomeArquivo: 'dp.json', extensao: '.json',
    texto: JSON.stringify({ cpf: '12345678901', dataDesligamento: '2025-06-15', codigoMotivoDesligamento: '48' }) });
  const m = extr.mesclarExtracoes([ccb, dp]);
  assert.strictEqual(m.precisaConferencia, false);
  assert.strictEqual(m.campos.data_evento, '2025-06-15');
  assert.strictEqual(m.campos.data_contratacao, '2025-01-10');
});
teste('OCR com baixa confiança sozinho já manda para conferência', () => {
  const r = extr.extrairCamposLocal({ nomeArquivo: 'foto.png', extensao: '.png', texto: 'texto ruim ilegivel', ocrConfianca: 45 });
  assert.strictEqual(r.precisaConferencia, true);
  assert.ok(/baixa confian/i.test(r.motivoConferencia));
});

console.log(`\n${ok} ok, ${falhas} falha(s).\n`);
process.exit(falhas ? 1 : 0);
