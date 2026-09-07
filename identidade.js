// ============================================================================
// Identidade do segurado / do empréstimo — normalização de CPF/CCB
// ============================================================================
// Regras da operação:
//  - CPF é sempre 11 dígitos. Quando a planilha perde o zero à esquerda, o zero
//    é reposto:  "1234567890" -> "01234567890".
//  - CCB composto vem como "123/456" (às vezes "123-456", "123 e 456",
//    "123;456") e PRECISA ser quebrado em CCBs individuais ANTES de comparar.
//
//  DEDUPLICAÇÃO (regra corrigida):
//    - Só é a MESMA pessoa/MESMO caso quando é o MESMO CPF **e** o MESMO CCB
//      (mesmo empréstimo). CCB composto "123/456" = conjunto {123,456}: duas
//      linhas se juntam se os conjuntos de CCB se cruzam.
//    - MESMO CPF com CCBs DIFERENTES = casos SEPARADOS (empréstimos diferentes),
//      cada um com seu próprio valor a pagar — não somar, não escolher um só.
//    - Só quando é exatamente o mesmo CCB duplicado (reenvio, ou composto
//      partido em duas linhas) mantém-se UMA linha e NÃO se soma o valor.
// ============================================================================

function apenasDigitos(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// "1234567890" -> "01234567890".  Já com 11 dígitos: devolve igual.
// Mais de 11 dígitos = provável nº de CCB, não é CPF -> devolve null.
function normalizarCpf(valor) {
  const d = apenasDigitos(valor);
  if (!d) return null;
  if (d.length > 11) return null;
  return d.padStart(11, '0');
}

// CCB / nº de contrato -> forma canônica para casar com `pagamentos_confirmados`
// e com as allowlists de config-pagamento.js:  só dígitos, sem zeros à esquerda.
//   "008.000.073-62" -> "800007362" ; "CCB 0004701" -> "4701" ; "" / "0" -> null
// Obs.: zerar os zeros à esquerda faz "0123" e "123" colidirem — aceitável na
// operação (os números reais não têm essa ambiguidade) e necessário porque o
// CPF-fake da SETHI vem ora com, ora sem o zero.
function normalizarCcb(valor) {
  const d = apenasDigitos(valor).replace(/^0+/, '');
  return d || null;
}

// Quebra "123/456", "123 / 456", "123-456", "123 e 456", "123;456", "123+456"
// em ['123', '456'].  NÃO quebra um CPF pontuado ("123.456.789-01"): ponto e
// hífen internos de CPF não separam itens.
function separarCcbComposto(valor) {
  if (valor == null) return [];
  return String(valor)
    .split(/\s*(?:\/|;|\+|\||,|\be\b)\s*/i)
    .map(p => p.trim())
    .filter(Boolean);
}

// Separa o conteúdo bruto da coluna "CPF/CCB" em { cpf, ccbs }.
//   - parte com 11 dígitos  -> CPF
//   - senão, parte com 9-10 dígitos e nenhum CPF ainda -> CPF (zero à esquerda reposto)
//   - todo o resto -> CCBs (conjunto, sem repetição)
function analisarCpfCcb(bruto) {
  const partes = separarCcbComposto(bruto).map(apenasDigitos).filter(Boolean);
  let idxCpf = partes.findIndex(p => p.length === 11);
  if (idxCpf === -1) idxCpf = partes.findIndex(p => p.length >= 9 && p.length <= 10);
  const cpf = idxCpf === -1 ? null : partes[idxCpf].padStart(11, '0');
  const ccbs = [...new Set(partes.filter((_, i) => i !== idxCpf))];
  return { cpf, ccbs };
}

// Chaves de identidade do CASO (empréstimo), usadas para deduplicar linhas da
// planilha e para vincular documentos ao caso certo.
//   "cpf:<11d>|ccb:<n>"   quando há CPF e CCB   (uma chave por CCB do conjunto)
//   "cpf:<11d>"           quando só há CPF
//   "ccb:<n>"             quando só há CCB
//   "nome:<nome>"         último recurso, sem CPF nem CCB
function chavesIdentidade(cpfCcbBruto, nome) {
  const { cpf, ccbs } = analisarCpfCcb(cpfCcbBruto);
  const chaves = [];
  if (cpf && ccbs.length) {
    for (const c of ccbs) chaves.push('cpf:' + cpf + '|ccb:' + c);
  } else if (cpf) {
    chaves.push('cpf:' + cpf);
  } else if (ccbs.length) {
    for (const c of ccbs) chaves.push('ccb:' + c);
  } else if (nome) {
    const n = String(nome).trim().toLowerCase().replace(/\s+/g, ' ');
    if (n) chaves.push('nome:' + n);
  }
  return chaves;
}

// Texto "bonito" do CPF/CCB para exibir/guardar:
//   CPF formatado 000.000.000-00  +  CCBs só com dígitos, juntos por " · CCB ".
function formatarCpfCcb(cpfCcbBruto) {
  const { cpf, ccbs } = analisarCpfCcb(cpfCcbBruto);
  const partes = [];
  if (cpf) partes.push(formatarCpf(cpf));
  for (const c of ccbs) partes.push('CCB ' + c);
  if (partes.length) return partes.join(' · ');
  return cpfCcbBruto == null ? null : (String(cpfCcbBruto).trim() || null);
}

// 11 dígitos -> "000.000.000-00".  Qualquer outra coisa volta como veio (só dígitos).
function formatarCpf(valor) {
  const d = apenasDigitos(valor);
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length >= 9 && d.length <= 10) {
    const p = d.padStart(11, '0');
    return `${p.slice(0, 3)}.${p.slice(3, 6)}.${p.slice(6, 9)}-${p.slice(9)}`;
  }
  return d || (valor == null ? '' : String(valor));
}

// ----------------------------------------------------------------------------
// Union-find leve: agrupa linhas que compartilham qualquer chave de identidade.
// ----------------------------------------------------------------------------
class Uniao {
  constructor() { this.pai = new Map(); }
  achar(x) {
    if (!this.pai.has(x)) { this.pai.set(x, x); return x; }
    let raiz = x;
    while (this.pai.get(raiz) !== raiz) raiz = this.pai.get(raiz);
    while (this.pai.get(x) !== raiz) { const prox = this.pai.get(x); this.pai.set(x, raiz); x = prox; }
    return raiz;
  }
  unir(a, b) {
    const ra = this.achar(a);
    const rb = this.achar(b);
    if (ra !== rb) this.pai.set(ra, rb);
  }
}

module.exports = {
  apenasDigitos,
  normalizarCpf,
  normalizarCcb,
  separarCcbComposto,
  analisarCpfCcb,
  chavesIdentidade,
  formatarCpfCcb,
  formatarCpf,
  Uniao
};
