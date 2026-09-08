// Helpers de formatação compartilhados pelas telas (CPF/CCB, moeda, data).
(function (global) {
  function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  // Formata CPF (11 díg.) como 000.000.000-00. CCB / texto: devolve como está.
  function formatarCpf(v) {
    const d = soDigitos(v);
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length >= 9 && d.length <= 10) {
      const p = d.padStart(11, '0');
      return p.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    return v == null ? '' : String(v);
  }

  // Padroniza a exibição da coluna "CPF/CCB": pode ter CPF e um ou mais CCBs,
  // já vindo do servidor como "000.000.000-00 · CCB 12345". Só garante o CPF
  // formatado quando vier cru, e mantém o resto.
  function formatarCpfCcb(v) {
    if (v == null || v === '') return '—';
    const s = String(v).trim();
    // Se é só dígitos (11) -> CPF puro
    if (/^\d{9,11}$/.test(s)) return formatarCpf(s);
    // Se começa com um bloco de 9-11 dígitos seguido de separador, formata esse bloco
    return s.replace(/^(\d{9,11})(\b|[^\d])/, (_, d, resto) => formatarCpf(d) + resto);
  }

  function brl(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function dataBR(v) {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toLocaleDateString('pt-BR');
  }

  // Rótulo curto DERIVADO de classificacao_pagamento — é o único campo que decide
  // se um caso está pronto pra pagar. NUNCA usar status / status_planilha (motor e
  // etiqueta de origem da planilha) como rótulo principal numa lista de "a pagar".
  //   'A PAGAR — próxima parcela (2/6)' -> 'PRÓXIMA PARCELA 2/6'
  //   'A PAGAR (ex-PROGRAMADO)'         -> 'PRONTO PARA PAGAR (ex-programado)'
  //   'A PAGAR'                         -> 'PRONTO PARA PAGAR'
  //   qualquer outra coisa             -> o próprio texto da classificação
  function rotuloPagamento(classificacao) {
    const v = classificacao == null ? '' : String(classificacao).trim();
    if (v.indexOf('próxima parcela') !== -1) {
      const m = v.match(/\((\d+\/\d+)\)/);
      return 'PRÓXIMA PARCELA' + (m ? ' ' + m[1] : '');
    }
    if (v.indexOf('ex-PROGRAMADO') !== -1) return 'PRONTO PARA PAGAR (ex-programado)';
    if (v === 'A PAGAR') return 'PRONTO PARA PAGAR';
    return v || '—';
  }

  // Classe de badge para o rótulo de pagamento (verde = pronto/próxima parcela).
  function classePagamento(classificacao) {
    const v = classificacao == null ? '' : String(classificacao);
    if (v === 'A PAGAR' || v.indexOf('próxima parcela') !== -1 || v.indexOf('ex-PROGRAMADO') !== -1) return 'badge-sucesso';
    if (v.indexOf('JÁ PAGO') !== -1) return 'badge-sucesso';
    if (v.indexOf('FRANQUIA') !== -1 || v.indexOf('AGUARDANDO') !== -1 || v.indexOf('PROGRAMADO') !== -1) return 'badge-alerta';
    if (v.indexOf('NÃO PAGAR') !== -1 || v.indexOf('BLOQUEADO') !== -1) return 'badge-perigo';
    return 'badge-neutro';
  }

  global.Formato = { formatarCpf, formatarCpfCcb, brl, dataBR, soDigitos, rotuloPagamento, classePagamento };
})(window);
