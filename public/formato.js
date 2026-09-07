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

  global.Formato = { formatarCpf, formatarCpfCcb, brl, dataBR, soDigitos };
})(window);
