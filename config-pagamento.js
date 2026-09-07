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

  // --------------------------------------------------------------------------
  // Casos tratados À MÃO. NÃO entram pelo fluxo automático da planilha nem pelo
  // importador de pagamentos — a classificação (planilha-transform.js) aplica
  // estes overrides ANTES de olhar a coluna CASOS A PAGAR e a tabela
  // pagamentos_confirmados.
  //   `ccb`  : só dígitos (o normalizador tira zeros à esquerda). Para SETHI é o
  //            nº interno que aparece na coluna "CPF / CCB".
  //   `acao` : 'BLOQUEADO_REEMPREGO'      -> fora de cobertura. Nunca "a pagar" nem "já pago".
  //            'JA_PAGO'                  -> pagamento confirmado por fora da tabela
  //                                          pagamentos_confirmados (ex.: comprovante sem CCB,
  //                                          casado por nome). Mesmo efeito de um CCB na tabela.
  //            'AGUARDANDO_VALOR_MANUAL'  -> avulso pronto p/ pagar, mas falta o valor certo.
  //                                          Fica retido até alguém preencher o valor.
  //   `cpf`  : quando o caso não tem CCB, casa pelo CPF (11 díg., zero à esquerda reposto).
  // --------------------------------------------------------------------------
  casosManuais: [
    {
      ccb: '800007362', segurado: 'WILLIAN DOS PASSOS DA SILVA', parceiro: 'SETHI',
      acao: 'BLOQUEADO_REEMPREGO',
      nota: 'Reemprego confirmado — excluído da cobertura.',
      por: 'Cecília', em: '2026-09-07'
    },
    {
      ccb: '800016646', segurado: 'MAIANE PEREIRA DE BRAGA', parceiro: 'SETHI',
      acao: 'AGUARDANDO_VALOR_MANUAL',
      nota: 'Caso avulso pronto p/ pagamento; "Valor a Pagar" veio R$ 0,00 na planilha. Preencher o valor certo antes de entrar em A PAGAR.',
      por: 'Cecília', em: '2026-09-07'
    },
    {
      cpf: '02368877002', segurado: 'MICHAEL MADRUGA MARTINS', parceiro: 'Nova',
      acao: 'JA_PAGO',
      nota: 'confirmado por nome no arquivo BASE PARA ANALISE (sem CCB no comprovante) - CCB a confirmar depois',
      por: 'Cecília', em: '2026-09-07'
    },
    {
      cpf: '71198888466', segurado: 'RAFAEL DA SILVA LOPES', parceiro: 'Resgata Ai',
      acao: 'JA_PAGO',
      nota: 'confirmado por nome no arquivo BASE PARA ANALISE (sem CCB no comprovante) - CCB a confirmar depois',
      por: 'Cecília', em: '2026-09-07'
    },
    {
      cpf: '42737301890', segurado: 'DEBORA MAIARA DO NASCIMENTO SOUSA', parceiro: 'X3',
      acao: 'JA_PAGO',
      nota: 'confirmado por nome no arquivo BASE PARA ANALISE (sem CCB no comprovante) - CCB a confirmar depois',
      por: 'Cecília', em: '2026-09-07'
    }
  ],

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
