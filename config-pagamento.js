// ============================================================================
// Decisões de pagamento conferidas MANUALMENTE (fora da planilha).
// ----------------------------------------------------------------------------
// Casos com "ELEGÍVEL - PROGRAMADO PARA PAGAMENTO <data>" NÃO entram no total
// "A PAGAR" automaticamente. Quando alguém confere no relatório de pagamentos
// realizados que um desses casos AINDA NÃO foi pago, adiciona o CCB (ou o CPF)
// aqui e o importador passa a tratá-lo como "A PAGAR" normalmente.
//
// `ccb`/`cpf`: só dígitos (o zero à esquerda do CPF é reposto automaticamente).
// `nota`/`por`/`em`: só auditoria.
// ============================================================================
const NOTA_LOTE47 = 'Lote 47 POUPACRED (Isabella) — não consta no relatório de pagos, liberado manualmente por Cecília em 08/09/2026';
const NOTA_FUNDO_LAVIE = 'FUNDO veio "GUARDIAN" na planilha por erro de digitação — a coluna "Fonte do Produto" e a nota de pagamento confirmam LA VIE PFO FIDC; corrigido manualmente por Cecília em 07/09/2026';

module.exports = {
  programadosLiberados: [
    { ccb: '82731873', nota: NOTA_LOTE47, por: 'Cecília', em: '2026-09-08' },
    { ccb: '85787969', nota: NOTA_LOTE47, por: 'Cecília', em: '2026-09-08' },
    { ccb: '86778892', nota: NOTA_LOTE47, por: 'Cecília', em: '2026-09-08' },
    { ccb: '83915246', nota: NOTA_LOTE47, por: 'Cecília', em: '2026-09-08' },
    { ccb: '86161658', nota: NOTA_LOTE47, por: 'Cecília', em: '2026-09-08' },
    { ccb: '88092057', nota: NOTA_LOTE47, por: 'Cecília', em: '2026-09-08' }
  ],

  // Correções pontuais de FUNDO com erro de digitação confirmado (`cpf`/`ccb`:
  // só dígitos; o zero à esquerda do CPF é reposto automaticamente).
  fundoCorrigido: [
    { cpf: '71198888466', fundo: 'LA VIE', nota: NOTA_FUNDO_LAVIE, por: 'Cecília', em: '2026-09-07' }, // Rafael da Silva Lopes
    { cpf: '10777573440', fundo: 'LA VIE', nota: NOTA_FUNDO_LAVIE, por: 'Cecília', em: '2026-09-07' }  // Bartolomeu da Silva Santos
  ]
};
