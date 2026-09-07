require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const { createWorker } = require('tesseract.js');
const pool = require('./db');
const { calcularCaso, verificarElegibilidade, calcularCarencia, calcularFranquia, normalizarParceiro } = require('./regras');
const { chavesIdentidade, formatarCpfCcb, analisarCpfCcb } = require('./identidade');
const { extrairCamposLocal } = require('./extracao');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// Status de casos que dependem de ação humana (Seção 6 — legenda)
const STATUS_CONFERENCIA = 'AGUARDANDO CONFERÊNCIA MANUAL';

// Extensões de documento que o pipeline local sabe ler
const EXTENSOES_DOC = ['.pdf', '.docx', '.jpg', '.jpeg', '.png', '.json', '.csv', '.txt'];

// undefined -> null (mysql2 recusa undefined em parâmetro)
const v = (x) => (x === undefined ? null : x);

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-este-segredo',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // sessão dura 8 horas
}));

// --- Login / autenticação (Seção 10 e 8) ---

function exigirLogin(req, res, next) {
  const rotasLivres = ['/login.html', '/login', '/logout'];
  if (req.session && req.session.usuario) return next();
  if (rotasLivres.includes(req.path)) return next();

  const ehChamadaDeApi = req.path.startsWith('/api/') || req.path === '/upload' ||
    req.path === '/upload-lote' || req.path === '/casos' || req.path === '/exportar';
  if (ehChamadaDeApi) {
    return res.status(401).json({ erro: 'Sessão expirada ou não autenticado. Faça login novamente.' });
  }
  return res.redirect('/login.html');
}

app.post('/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body;
    const [linhas] = await pool.query('SELECT * FROM usuarios WHERE usuario = ?', [usuario]);
    if (linhas.length === 0) {
      return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
    }
    const usuarioEncontrado = linhas[0];
    const senhaCorreta = await bcrypt.compare(senha, usuarioEncontrado.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
    }
    req.session.usuario = {
      id: usuarioEncontrado.id,
      nome: usuarioEncontrado.nome,
      usuario: usuarioEncontrado.usuario,
      perfil: usuarioEncontrado.perfil
    };
    res.json({ mensagem: 'Login realizado com sucesso.', usuario: req.session.usuario });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao efetuar login: ' + erro.message });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ mensagem: 'Sessão encerrada.' });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.usuario) {
    return res.json(req.session.usuario);
  }
  res.status(401).json({ erro: 'Não autenticado.' });
});

app.use(exigirLogin);
app.use(express.static('public'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + path.basename(file.originalname))
});
const upload = multer({ storage });

// --- Extração de texto bruto (100% local, sem API paga) ---

// OCR com Tesseract (open-source, roda no servidor). Devolve texto + confiança 0-100.
async function ocrImagem(caminhoArquivo) {
  const worker = await createWorker('por');
  try {
    const { data } = await worker.recognize(caminhoArquivo);
    return { texto: data.text || '', confianca: typeof data.confidence === 'number' ? data.confidence : null };
  } finally {
    await worker.terminate();
  }
}

// Retorno: { texto, ocrConfianca (0-100|null), precisaOcrManual }
async function extrairTextoDeArquivo(caminhoArquivo) {
  const extensao = path.extname(caminhoArquivo).toLowerCase();

  if (extensao === '.pdf') {
    const bufferArquivo = fs.readFileSync(caminhoArquivo);
    const parser = new PDFParse({ data: bufferArquivo });
    const dadosPdf = await parser.getText();
    const texto = dadosPdf.text || '';
    // PDF digital: texto direto. PDF escaneado (sem texto): não há rasterização
    // pura-JS confiável -> vai para conferência manual.
    if (texto.trim().length < 50) return { texto: '', ocrConfianca: null, precisaOcrManual: true };
    return { texto, ocrConfianca: null, precisaOcrManual: false };
  }

  if (extensao === '.docx') {
    const resultado = await mammoth.extractRawText({ path: caminhoArquivo });
    return { texto: resultado.value, ocrConfianca: null, precisaOcrManual: false };
  }

  if (extensao === '.jpg' || extensao === '.jpeg' || extensao === '.png') {
    const { texto, confianca } = await ocrImagem(caminhoArquivo);
    return { texto, ocrConfianca: confianca, precisaOcrManual: false };
  }

  if (extensao === '.json' || extensao === '.csv' || extensao === '.txt') {
    return { texto: fs.readFileSync(caminhoArquivo, 'utf8'), ocrConfianca: null, precisaOcrManual: false };
  }

  return { texto: `[Arquivo com extensão ${extensao} não pôde ser lido automaticamente]`, ocrConfianca: null, precisaOcrManual: false };
}

// A extração estruturada é feita 100% localmente por ./extracao.js
// (Dataprev estruturado + regex por parceiro sobre texto/OCR). Sem IA, sem custo.

// --- Vínculo entre documentos (Seção 7.3) ---

// Vincula um documento a um caso já existente.
//  - doc com CPF + CCB  -> casa o par exato (mesmo empréstimo)
//  - doc só com CPF     -> casa só se houver EXATAMENTE 1 caso desse CPF (senão fica ambíguo)
//  - doc só com CCB     -> casa pelo CCB
async function buscarCasoPorCpfCcb(cpfCcbBruto, nome) {
  const { cpf, ccbs } = analisarCpfCcb(cpfCcbBruto);
  const [linhas] = await pool.query('SELECT id, identidade_chaves FROM casos WHERE identidade_chaves IS NOT NULL');
  const casos = linhas.map(l => {
    let chaves = [];
    try { chaves = JSON.parse(l.identidade_chaves) || []; } catch (e) { /* ignora */ }
    return { id: l.id, chaves };
  });

  if (cpf && ccbs.length) {
    const alvo = ccbs.map(c => 'cpf:' + cpf + '|ccb:' + c);
    const m = casos.find(c => c.chaves.some(k => alvo.includes(k)));
    if (m) return m.id;
  }
  if (cpf) {
    const doCpf = casos.filter(c => c.chaves.some(k => k === 'cpf:' + cpf || k.startsWith('cpf:' + cpf + '|')));
    if (doCpf.length === 1) return doCpf[0].id;
    return null; // 0 casos, ou ambíguo (vários empréstimos do mesmo CPF)
  }
  if (ccbs.length) {
    const m = casos.find(c => c.chaves.some(k => ccbs.some(cc => k.endsWith('ccb:' + cc))));
    if (m) return m.id;
  }
  return null;
}

// --- Histórico / auditoria (Seção 4 e 8) ---

async function registrarHistorico(casoId, campo, valorAnterior, valorNovo, usuario) {
  const antigoTexto = (valorAnterior === null || valorAnterior === undefined) ? null : String(valorAnterior);
  const novoTexto = (valorNovo === null || valorNovo === undefined) ? null : String(valorNovo);
  if (antigoTexto === novoTexto) return; // não loga se nada mudou de verdade

  await pool.query(
    'INSERT INTO historico (caso_id, campo, valor_anterior, valor_novo, usuario) VALUES (?, ?, ?, ?, ?)',
    [casoId, campo, antigoTexto, novoTexto, usuario]
  );
}

// Lê UM arquivo já salvo em disco e roda a extração local nele.
// -> { nome, texto, precisaOcrManual, extracao|null }
async function lerParteDocumental(caminho, nomeOriginal) {
  const extensao = path.extname(nomeOriginal || caminho).toLowerCase();
  const { texto, ocrConfianca, precisaOcrManual } = await extrairTextoDeArquivo(caminho);
  const extracao = (texto && texto.trim().length >= 10 && !precisaOcrManual)
    ? extrairCamposLocal({ nomeArquivo: nomeOriginal, texto, extensao, ocrConfianca })
    : null;
  return { nome: nomeOriginal, texto: texto || '', precisaOcrManual: !!precisaOcrManual, extracao };
}

// `partes`: [{ nome, texto, precisaOcrManual, extracao }] — um por documento do MESMO segurado.
async function processarUnidadeDocumental(nomeReferencia, partes) {
  const textoExtraido = partes.map(p => `--- ${p.nome} ---\n${p.texto || ''}`).join('\n\n').trim();
  const precisaOcrManual = partes.some(p => p.precisaOcrManual);
  const extraida = mesclarExtracoes(partes.map(p => p.extracao));
  const campos = Object.keys(extraida.campos || {}).length ? extraida.campos : null;

  // Precisa de conferência humana? (campo obrigatório ilegível, OCR ruim, PDF escaneado…)
  let conferencia = precisaOcrManual || extraida.precisaConferencia;
  let motivoConf = null;
  if (precisaOcrManual) motivoConf = 'PDF escaneado sem texto — precisa conferência manual (converta para imagem para tentar OCR).';
  else if (extraida.precisaConferencia) motivoConf = extraida.motivoConferencia;
  if (!campos) { conferencia = true; motivoConf = motivoConf || 'Documento sem texto legível — precisa conferência manual.'; }

  const casoExistenteId = campos ? await buscarCasoPorCpfCcb(campos.cpf_ccb, campos.segurado) : null;

  let casoId;
  let eraNovo;

  if (casoExistenteId) {
    casoId = casoExistenteId;
    eraNovo = false;
    const [linhaAtual] = await pool.query('SELECT texto_extraido FROM casos WHERE id = ?', [casoId]);
    const textoCombinado = (linhaAtual[0].texto_extraido || '') +
      `\n\n--- Documento adicional: ${nomeReferencia} ---\n` + textoExtraido;
    await pool.query('UPDATE casos SET texto_extraido = ? WHERE id = ?', [textoCombinado, casoId]);
  } else {
    const chavesIniciais = campos ? chavesIdentidade(campos.cpf_ccb, campos.segurado) : [];
    const [resultado] = await pool.query(
      `INSERT INTO casos (nome_arquivo, texto_extraido, status, origem, identidade_chaves,
                          tipo_documento, conferencia_pendente, motivo_conferencia)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nomeReferencia, textoExtraido, conferencia ? STATUS_CONFERENCIA : 'NOVO', 'DOCUMENTO',
        chavesIniciais.length ? JSON.stringify(chavesIniciais) : null,
        extraida ? extraida.tipoDoc : null, conferencia ? 1 : 0, motivoConf
      ]
    );
    casoId = resultado.insertId;
    eraNovo = true;
  }

  await pool.query(
    'INSERT INTO documentos (caso_id, nome_arquivo, status_processamento, texto_extraido) VALUES (?, ?, ?, ?)',
    [casoId, nomeReferencia, conferencia ? 'AGUARDANDO CONFERÊNCIA' : 'PROCESSADO', textoExtraido]
  );

  if (campos) {
    await pool.query(
      'INSERT INTO extracoes_ia (caso_id, json_extraido, confianca_json, fonte) VALUES (?, ?, ?, ?)',
      [casoId, JSON.stringify(campos), JSON.stringify(extraida.confianca || {}), extraida.fonte || null]
    );

    if (conferencia) {
      await pool.query(
        'UPDATE casos SET conferencia_pendente = 1, motivo_conferencia = ?, tipo_documento = COALESCE(?, tipo_documento) WHERE id = ?',
        [motivoConf, extraida ? extraida.tipoDoc : null, casoId]
      );
    }

    await pool.query(
      `UPDATE casos SET
        segurado = COALESCE(?, segurado), cpf_ccb = COALESCE(?, cpf_ccb), parceiro = COALESCE(?, parceiro),
        fundo = COALESCE(?, fundo), cobertura = COALESCE(?, cobertura),
        data_contratacao = COALESCE(?, data_contratacao), data_evento = COALESCE(?, data_evento),
        data_admissao = COALESCE(?, data_admissao), motivo_desligamento_codigo = COALESCE(?, motivo_desligamento_codigo),
        valor_parcela = COALESCE(?, valor_parcela), limite_beneficio = COALESCE(?, limite_beneficio),
        numero_parcelas_contratadas = COALESCE(?, numero_parcelas_contratadas),
        teto_parcela_produto = COALESCE(?, teto_parcela_produto),
        numero_parcelas_cobertas_produto = COALESCE(?, numero_parcelas_cobertas_produto),
        fonte_produto = COALESCE(?, fonte_produto)
       WHERE id = ?`,
      [
        v(campos.segurado), v(campos.cpf_ccb), v(campos.parceiro), v(campos.fundo), v(campos.cobertura),
        v(campos.data_contratacao), v(campos.data_evento), v(campos.data_admissao), v(campos.motivo_desligamento_codigo),
        v(campos.valor_parcela), v(campos.limite_beneficio), v(campos.numero_parcelas_contratadas),
        v(campos.teto_parcela_produto), v(campos.numero_parcelas_cobertas_produto), v(campos.fonte_produto),
        casoId
      ]
    );

    // Recalcula as chaves de identidade, o nome canônico do parceiro e o texto
    // do CPF/CCB a partir da linha já combinada (pode ter mudado com este doc).
    const [linhaAtual] = await pool.query('SELECT cpf_ccb, segurado, parceiro FROM casos WHERE id = ?', [casoId]);
    if (linhaAtual.length) {
      const row = linhaAtual[0];
      const chaves = chavesIdentidade(row.cpf_ccb, row.segurado);
      await pool.query(
        'UPDATE casos SET identidade_chaves = ?, parceiro = COALESCE(?, parceiro), cpf_ccb = COALESCE(?, cpf_ccb) WHERE id = ?',
        [chaves.length ? JSON.stringify(chaves) : null, normalizarParceiro(row.parceiro), formatarCpfCcb(row.cpf_ccb), casoId]
      );
    }
  }

  await aplicarMotorDeRegras(casoId, 'Sistema (extração local + motor de regras)');

  return { casoId, eraNovo, conferencia: !!conferencia, motivoConferencia: motivoConf, tipoDoc: extraida.tipoDoc };
}

// Roda o motor de regras, e registra em "historico" qualquer mudança de status ou valor a pagar
async function aplicarMotorDeRegras(casoId, usuario) {
  const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [casoId]);
  if (linhas.length === 0) return;
  const casoAntes = linhas[0];
  const resultado = calcularCaso(casoAntes);

  // Enquanto o caso aguarda conferência humana, o STATUS fica travado nessa
  // etiqueta — o motor continua calculando carência/franquia/valor para exibição.
  const statusFinal = casoAntes.conferencia_pendente ? STATUS_CONFERENCIA : resultado.status;
  const motivoFinal = casoAntes.conferencia_pendente ? (casoAntes.motivo_conferencia || resultado.motivoNegacao) : resultado.motivoNegacao;

  await registrarHistorico(casoId, 'status', casoAntes.status, statusFinal, usuario);
  await registrarHistorico(casoId, 'valor_a_pagar', casoAntes.valor_a_pagar, resultado.valorAPagar, usuario);

  // Coluna única que Dashboard / Pagar agora / gráficos usam: o valor da planilha
  // manda; na falta dele, o total calculado pelo motor. Um campo, um filtro.
  const temPlanilha = casoAntes.valor_a_pagar_planilha !== null && casoAntes.valor_a_pagar_planilha !== undefined;
  const valorFinal = temPlanilha
    ? Number(casoAntes.valor_a_pagar_planilha)
    : (resultado.valorTotalAPagar !== null ? resultado.valorTotalAPagar : resultado.valorAPagar);

  await pool.query(
    `UPDATE casos SET
      carencia_dias = ?, franquia_data = ?, cia = ?,
      valor_a_pagar = ?, valor_total_a_pagar = ?, valor_a_pagar_final = ?,
      numero_parcelas_cobertas_produto = COALESCE(?, numero_parcelas_cobertas_produto),
      teto_parcela_produto = COALESCE(?, teto_parcela_produto),
      parceiro = COALESCE(?, parceiro),
      status = ?, motivo_negacao = ?
     WHERE id = ?`,
    [
      resultado.carenciaDias, resultado.franquiaData, resultado.cia,
      resultado.valorAPagar, resultado.valorTotalAPagar, valorFinal,
      resultado.parcelasCobertas, resultado.tetoParcelaProduto, resultado.parceiroCanonico,
      statusFinal, motivoFinal, casoId
    ]
  );
}

async function processarZip(caminhoZip) {
  const zip = new AdmZip(caminhoZip);
  const entradas = zip.getEntries();
  const pastasPorNome = {};

  entradas.forEach(entrada => {
    if (entrada.isDirectory) return;
    // Remove partes vazias (ex.: zip criado no Mac pode ter barras duplicadas)
    const partesCaminho = entrada.entryName.split('/').filter(Boolean);
    if (partesCaminho.length < 2) return; // arquivo solto na raiz do zip, sem pasta — ignora

    // Agrupa pela pasta MAIS PRÓXIMA do arquivo (o penúltimo item do caminho),
    // não importa quantos níveis de pasta existam acima dela. Isso corrige o caso
    // de ZIPs organizados como "pasta-mae/subpasta/NOME DO SEGURADO/documento.pdf".
    const nomeDaPasta = partesCaminho[partesCaminho.length - 2];
    if (!pastasPorNome[nomeDaPasta]) pastasPorNome[nomeDaPasta] = [];
    pastasPorNome[nomeDaPasta].push(entrada);
  });

  const resultados = [];
  for (const nomeDaPasta of Object.keys(pastasPorNome)) {
    const partes = [];
    for (const entrada of pastasPorNome[nomeDaPasta]) {
      const extensao = path.extname(entrada.entryName).toLowerCase();
      if (!EXTENSOES_DOC.includes(extensao)) continue;
      const caminhoTemporario = path.join('uploads', Date.now() + '-' + path.basename(entrada.entryName));
      fs.writeFileSync(caminhoTemporario, entrada.getData());
      try {
        partes.push(await lerParteDocumental(caminhoTemporario, entrada.entryName));
      } finally {
        fs.unlinkSync(caminhoTemporario);
      }
    }
    if (partes.length === 0 || partes.every(p => !p.texto.trim())) continue;
    resultados.push(await processarUnidadeDocumental(nomeDaPasta, partes));
  }
  return resultados;
}

// --- Rotas ---

// Upload de UM arquivo (ou um .zip com pastas por segurado).
app.post('/upload', upload.single('documento'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });
    const caminhoArquivo = req.file.path;
    const extensao = path.extname(req.file.originalname).toLowerCase();

    if (extensao === '.zip') {
      const resultados = await processarZip(caminhoArquivo);
      const criados = resultados.filter(r => r.eraNovo).length;
      const atualizados = resultados.filter(r => !r.eraNovo).length;
      const conferencia = resultados.filter(r => r.conferencia).length;
      return res.json({
        mensagem: `ZIP processado. ${criados} caso(s) novo(s), ${atualizados} atualizado(s), ${conferencia} em conferência manual.`,
        ids: resultados.map(r => r.casoId)
      });
    }

    if (EXTENSOES_DOC.includes(extensao)) {
      const parte = await lerParteDocumental(caminhoArquivo, req.file.originalname);
      const resultado = await processarUnidadeDocumental(req.file.originalname, [parte]);
      const mensagem = resultado.conferencia
        ? 'Documento recebido, mas caiu em CONFERÊNCIA MANUAL: ' + (resultado.motivoConferencia || '')
        : (resultado.eraNovo ? 'Caso novo criado com sucesso.' : 'Documento vinculado a um caso já existente (mesmo CPF+CCB).');
      return res.json({ id: resultado.casoId, mensagem, conferencia: !!resultado.conferencia });
    }

    return res.status(400).json({ erro: 'Formato não suportado (use PDF, DOCX, JPG, PNG, JSON, CSV, TXT ou ZIP).' });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao processar o arquivo: ' + erro.message });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
  }
});

// Upload EM LOTE: pasta inteira (input webkitdirectory) e/ou vários .zip de uma vez.
// Responde em NDJSON — uma linha por item processado + uma linha final de resumo —
// para a tela mostrar o progresso em tempo real.
app.post('/upload-lote', upload.array('documentos', 5000), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  const envia = (obj) => res.write(JSON.stringify(obj) + '\n');
  const arquivos = req.files || [];
  const caminhosRelativos = [].concat(req.body.caminhos || []); // um por arquivo, na mesma ordem
  const resumo = { processados: 0, novos: 0, duplicados: 0, conferencia: 0, erros: 0, total: 0 };

  try {
    // Agrupa por "pasta do segurado": penúltimo segmento do caminho relativo; se não
    // houver, cada arquivo é a sua própria unidade. .zip é expandido à parte.
    const grupos = new Map(); // chave -> [{ caminho, nome }]
    const zips = [];
    arquivos.forEach((f, i) => {
      const rel = (caminhosRelativos[i] || f.originalname || '').replace(/\\/g, '/');
      const ext = path.extname(rel || f.originalname).toLowerCase();
      if (ext === '.zip') { zips.push(f); return; }
      if (!EXTENSOES_DOC.includes(ext)) return;
      const partesCaminho = rel.split('/').filter(Boolean);
      const chave = partesCaminho.length >= 2 ? partesCaminho[partesCaminho.length - 2] : (f.originalname + '#' + i);
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push({ caminho: f.path, nome: rel || f.originalname });
    });

    resumo.total = grupos.size + zips.length;
    envia({ tipo: 'inicio', total: resumo.total });

    for (const [chave, itens] of grupos) {
      try {
        const partes = [];
        for (const it of itens) partes.push(await lerParteDocumental(it.caminho, it.nome));
        if (partes.every(p => !p.texto.trim())) {
          resumo.erros++; envia({ tipo: 'item', nome: chave, status: 'erro', motivo: 'sem texto legível' });
        } else {
          const r = await processarUnidadeDocumental(chave, partes);
          resumo.processados++;
          if (r.conferencia) resumo.conferencia++;
          else if (r.eraNovo) resumo.novos++;
          else resumo.duplicados++;
          envia({ tipo: 'item', nome: chave, casoId: r.casoId,
            status: r.conferencia ? 'conferencia' : (r.eraNovo ? 'novo' : 'duplicado'),
            motivo: r.conferencia ? r.motivoConferencia : null });
        }
      } catch (e) {
        resumo.erros++; envia({ tipo: 'item', nome: chave, status: 'erro', motivo: e.message });
      }
    }

    for (const zf of zips) {
      try {
        const resultados = await processarZip(zf.path);
        for (const r of resultados) {
          resumo.processados++;
          if (r.conferencia) resumo.conferencia++;
          else if (r.eraNovo) resumo.novos++;
          else resumo.duplicados++;
        }
        envia({ tipo: 'item', nome: zf.originalname, status: 'zip', qtd: resultados.length });
      } catch (e) {
        resumo.erros++; envia({ tipo: 'item', nome: zf.originalname, status: 'erro', motivo: e.message });
      }
    }

    envia({ tipo: 'resumo', ...resumo });
    res.end();
  } catch (erro) {
    console.error(erro);
    envia({ tipo: 'fatal', erro: erro.message });
    res.end();
  } finally {
    for (const f of arquivos) { if (f.path && fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch (e) {} } }
  }
});

app.get('/casos', async (req, res) => {
  try {
    const { status, parceiro, fundo, cia, conferencia, criado_de, criado_ate } = req.query;
    let query = 'SELECT * FROM casos WHERE 1=1';
    const parametros = [];
    if (status) { query += ' AND status = ?'; parametros.push(status); }
    if (parceiro) { query += ' AND parceiro = ?'; parametros.push(parceiro); }
    if (fundo) { query += ' AND fundo = ?'; parametros.push(fundo); }
    if (cia) { query += ' AND cia = ?'; parametros.push(cia); }
    if (conferencia === '1') { query += ' AND conferencia_pendente = 1'; }
    if (criado_de) { query += ' AND data_upload >= ?'; parametros.push(criado_de + ' 00:00:00'); }
    if (criado_ate) { query += ' AND data_upload <= ?'; parametros.push(criado_ate + ' 23:59:59'); }
    query += ' ORDER BY id DESC';

    const [linhas] = await pool.query(query, parametros);
    res.json(linhas);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar os casos: ' + erro.message });
  }
});

// Edição manual de um caso — sempre registrada no histórico (Seção 3.5 e 4)
app.get('/api/casos/:id', async (req, res) => {
  try {
    const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [req.params.id]);
    if (linhas.length === 0) return res.status(404).json({ erro: 'Caso não encontrado.' });
    const caso = linhas[0];

    // Recalcula a analise "em tempo real" so para exibicao (nao grava nada) — permite mostrar
    // o "porque" de cada etapa do motor de regras na pagina de detalhe do caso.
    const elegibilidade = verificarElegibilidade(caso);
    const carencia = calcularCarencia(caso);
    const franquiaData = calcularFranquia(caso);

    res.json({ ...caso, analise: { elegibilidade, carencia, franquiaData } });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar o caso: ' + erro.message });
  }
});

app.put('/api/casos/:id', async (req, res) => {
  try {
    const casoId = req.params.id;
    const usuarioLogado = req.session.usuario.nome;
    const camposPermitidos = ['segurado', 'cpf_ccb', 'parceiro', 'cobertura', 'data_contratacao', 'data_evento', 'data_admissao'];

    const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [casoId]);
    if (linhas.length === 0) return res.status(404).json({ erro: 'Caso não encontrado.' });
    const casoAntes = linhas[0];

    for (const campo of camposPermitidos) {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
        const valorNovo = req.body[campo];
        await registrarHistorico(casoId, campo, casoAntes[campo], valorNovo, usuarioLogado);
        await pool.query(`UPDATE casos SET ${campo} = ? WHERE id = ?`, [valorNovo, casoId]);
      }
    }

    await aplicarMotorDeRegras(casoId, usuarioLogado);
    res.json({ mensagem: 'Caso atualizado com sucesso.' });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao atualizar o caso: ' + erro.message });
  }
});

app.get('/api/historico/:casoId', async (req, res) => {
  try {
    const [linhas] = await pool.query(
      'SELECT * FROM historico WHERE caso_id = ? ORDER BY data_hora DESC',
      [req.params.casoId]
    );
    res.json(linhas);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar histórico: ' + erro.message });
  }
});

// FONTE ÚNICA DA VERDADE para "pronto pra pagar": a coluna CASOS A PAGAR da
// planilha (casos_a_pagar = 1). O campo STATUS é só etiqueta e NÃO entra aqui.
// Dashboard, "Pagar agora" e os 4 gráficos leem exatamente este mesmo critério
// e a mesma coluna de valor (valor_a_pagar_final) — por isso os totais batem.
const CRITERIO_A_PAGAR = 'casos_a_pagar = 1';

app.get('/api/dashboard', async (req, res) => {
  try {
    const [[{ total: totalCasos }]] = await pool.query('SELECT COUNT(*) AS total FROM casos');

    const [porStatus] = await pool.query(
      'SELECT COALESCE(status, \'(sem status)\') AS status, COUNT(*) AS quantidade FROM casos GROUP BY status ORDER BY quantidade DESC'
    );
    const [porParceiro] = await pool.query(
      `SELECT COALESCE(parceiro, '—') AS parceiro, COUNT(*) AS quantidade
       FROM casos WHERE parceiro IS NOT NULL AND parceiro <> ''
       GROUP BY parceiro ORDER BY quantidade DESC`
    );
    const [porMes] = await pool.query(
      `SELECT mes_ano_contratacao AS mes, COUNT(*) AS quantidade
       FROM casos WHERE mes_ano_contratacao IS NOT NULL AND mes_ano_contratacao <> ''
       GROUP BY mes_ano_contratacao ORDER BY mes_ano_contratacao ASC`
    );

    const [[aPagar]] = await pool.query(
      `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor_a_pagar_final), 0) AS total
       FROM casos WHERE ${CRITERIO_A_PAGAR}`
    );
    const [valorPorParceiro] = await pool.query(
      `SELECT COALESCE(parceiro, '—') AS parceiro, COUNT(*) AS qtd,
              COALESCE(SUM(valor_a_pagar_final), 0) AS total
       FROM casos WHERE ${CRITERIO_A_PAGAR}
       GROUP BY parceiro ORDER BY total DESC`
    );

    const [[{ n: emConferencia }]] = await pool.query('SELECT COUNT(*) AS n FROM casos WHERE conferencia_pendente = 1');

    // "Pagos" / "Cancelados" NÃO saem da coluna `status` (o motor nunca gera esses
    // valores) — saem de `classificacao_pagamento`, que a importação preenche a
    // partir da planilha (JÁ PAGO) e da tabela pagamentos_confirmados
    // (JÁ PAGO (comprovante)). Contamos os dois juntos.
    const [[{ n: pagos }]] = await pool.query(
      "SELECT COUNT(*) AS n FROM casos WHERE classificacao_pagamento IN ('JÁ PAGO', 'JÁ PAGO (comprovante)')"
    );
    const [[{ n: pagosComprovante }]] = await pool.query(
      "SELECT COUNT(*) AS n FROM casos WHERE classificacao_pagamento = 'JÁ PAGO (comprovante)'"
    );
    const [[{ n: cancelados }]] = await pool.query(
      "SELECT COUNT(*) AS n FROM casos WHERE classificacao_pagamento = 'CANCELADO' OR status = 'CANCELADO'"
    );
    const [porCia] = await pool.query(
      `SELECT COALESCE(cia, '(sem CIA)') AS cia, COUNT(*) AS quantidade,
              COALESCE(SUM(CASE WHEN ${CRITERIO_A_PAGAR} THEN valor_a_pagar_final ELSE 0 END), 0) AS total_a_pagar
       FROM casos GROUP BY cia ORDER BY quantidade DESC`
    );

    const contar = (...lista) =>
      porStatus.filter(i => lista.includes(i.status)).reduce((s, i) => s + i.quantidade, 0);

    res.json({
      totalCasos,
      porStatus,
      porParceiro,
      porCia,
      porMes,
      valorPorParceiro,
      totalAPagar: Number(aPagar.total),
      aPagarQtd: aPagar.qtd,
      emAnalise: contar('EM CARÊNCIA / ANÁLISE'),
      emFranquia: contar('EM FRANQUIA'),
      emConferencia,
      pendentes: contar('AGUARDANDO DOC', 'AGUARDANDO OCR MANUAL', 'NOVO'),
      negados: contar('NEGADO'),
      pagos,
      pagosComprovante,
      cancelados
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar o dashboard: ' + erro.message });
  }
});

// Lista dos casos prontos pra pagar — mesmo critério e mesma coluna de valor do
// cartão "A pagar" do dashboard, então a soma da tabela == o cartão.
app.get('/api/pagar-agora', async (req, res) => {
  try {
    const [linhas] = await pool.query(
      `SELECT id, segurado, nome_arquivo, cpf_ccb, parceiro, fundo, cia,
              valor_parcela, numero_parcelas_cobertas_produto,
              valor_a_pagar, valor_total_a_pagar, valor_a_pagar_planilha,
              valor_a_pagar_final, status, status_planilha
       FROM casos WHERE ${CRITERIO_A_PAGAR}
       ORDER BY parceiro ASC, valor_a_pagar_final DESC, segurado ASC`
    );
    const total = linhas.reduce((s, c) => s + Number(c.valor_a_pagar_final || 0), 0);
    const porParceiro = [];
    for (const c of linhas) {
      const nome = c.parceiro || '—';
      let grupo = porParceiro.find(g => g.parceiro === nome);
      if (!grupo) { grupo = { parceiro: nome, quantidade: 0, total: 0 }; porParceiro.push(grupo); }
      grupo.quantidade++;
      grupo.total += Number(c.valor_a_pagar_final || 0);
    }
    res.json({ casos: linhas, total, quantidade: linhas.length, porParceiro });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar casos a pagar: ' + erro.message });
  }
});

// Opções para montar os selects do painel de exportação (e da lista de casos).
app.get('/api/filtros', async (req, res) => {
  try {
    const [parceiros] = await pool.query("SELECT DISTINCT parceiro FROM casos WHERE parceiro IS NOT NULL AND parceiro <> '' ORDER BY parceiro");
    const [fundos] = await pool.query("SELECT DISTINCT fundo FROM casos WHERE fundo IS NOT NULL AND fundo <> '' ORDER BY fundo");
    const [status] = await pool.query("SELECT DISTINCT status FROM casos WHERE status IS NOT NULL ORDER BY status");
    res.json({
      parceiros: parceiros.map(r => r.parceiro),
      fundos: fundos.map(r => r.fundo),
      status: status.map(r => r.status)
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: erro.message });
  }
});

// Exportação configurável. `incluir_cia` desmarcado => a coluna CIA NÃO existe
// na planilha (nem oculta): os dados são montados sem ela.
app.get('/exportar', async (req, res) => {
  try {
    const { parceiro, fundo, cia, status, evento_de, evento_ate, criado_de, criado_ate } = req.query;
    const incluirCia = req.query.incluir_cia === '1' || req.query.incluir_cia === 'true';

    let where = 'WHERE 1=1';
    const p = [];
    if (parceiro) { where += ' AND parceiro = ?'; p.push(parceiro); }
    if (fundo) { where += ' AND fundo = ?'; p.push(fundo); }
    if (cia && cia !== 'TODOS') { where += ' AND cia = ?'; p.push(cia); }
    if (status) { where += ' AND status = ?'; p.push(status); }
    if (evento_de) { where += ' AND data_evento >= ?'; p.push(evento_de); }
    if (evento_ate) { where += ' AND data_evento <= ?'; p.push(evento_ate); }
    if (criado_de) { where += ' AND data_upload >= ?'; p.push(criado_de + ' 00:00:00'); }
    if (criado_ate) { where += ' AND data_upload <= ?'; p.push(criado_ate + ' 23:59:59'); }

    const colunasBase = [
      'id', 'origem', 'segurado', 'cpf_ccb', 'parceiro', 'fundo', 'cobertura',
      'mes_ano_contratacao', 'data_contratacao', 'data_evento', 'data_admissao',
      'valor_parcela', 'numero_parcelas_contratadas',
      'teto_parcela_produto', 'numero_parcelas_cobertas_produto',
      'carencia_dias', 'franquia_data', 'franquia_planilha',
      'valor_a_pagar', 'valor_total_a_pagar', 'valor_a_pagar_planilha', 'valor_a_pagar_final',
      'casos_a_pagar', 'status', 'status_planilha', 'motivo_negacao', 'motivo_conferencia',
      'nome_arquivo', 'data_upload'
    ];
    // CIA entra na lista de colunas SOMENTE se o checkbox estiver marcado.
    const colunas = incluirCia
      ? [...colunasBase.slice(0, 7), 'cia', ...colunasBase.slice(7)]
      : colunasBase;

    const [linhas] = await pool.query(`SELECT ${colunas.join(', ')} FROM casos ${where} ORDER BY id DESC`, p);

    const planilha = XLSX.utils.json_to_sheet(linhas, { header: colunas });
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, planilha, 'CONSOLIDADO');
    const buffer = XLSX.write(livro, { type: 'buffer', bookType: 'xlsx' });

    const hoje = new Date();
    const dd = String(hoje.getDate()).padStart(2, '0') + String(hoje.getMonth() + 1).padStart(2, '0') + hoje.getFullYear();
    const semAcentoAscii = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]/g, '');
    const marcaCia = (!cia || cia === 'TODOS') ? 'TODOS' : semAcentoAscii(cia).toUpperCase();
    const sufixo = incluirCia ? (marcaCia === 'TODOS' ? 'TODOS_interno' : marcaCia) : 'sem_cia';
    const nomeArquivo = `casos_${status === 'PRONTO PARA PAGAR' ? 'a_pagar_' : ''}${sufixo}_${dd}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename=${nomeArquivo}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (erro) {
    console.error(erro);
    res.status(500).send('Erro ao exportar: ' + erro.message);
  }
});

// --- Separação por quem paga (CIA) — informação INTERNA, atrás do login ---
app.get('/api/por-cia/:cia', async (req, res) => {
  try {
    const cia = req.params.cia;
    if (!['MetLife', 'Caburé'].includes(cia)) return res.status(400).json({ erro: 'CIA inválida.' });
    const [linhas] = await pool.query(
      `SELECT id, segurado, cpf_ccb, parceiro, fundo, cia, data_evento,
              valor_a_pagar, valor_total_a_pagar, valor_a_pagar_final, casos_a_pagar, status
       FROM casos WHERE cia = ? ORDER BY ${CRITERIO_A_PAGAR} DESC, valor_a_pagar_final DESC, segurado ASC`,
      [cia]
    );
    const aPagar = linhas.filter(c => c.casos_a_pagar === 1);
    const totalAPagar = aPagar.reduce((s, c) => s + Number(c.valor_a_pagar_final || 0), 0);
    res.json({ cia, casos: linhas, quantidade: linhas.length, aPagarQtd: aPagar.length, totalAPagar });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar casos por CIA: ' + erro.message });
  }
});

// --- Conferência manual (casos que a leitura automática não conseguiu ler) ---
app.get('/api/conferencia', async (req, res) => {
  try {
    const [linhas] = await pool.query(
      `SELECT id, segurado, cpf_ccb, parceiro, tipo_documento, motivo_conferencia, data_upload
       FROM casos WHERE conferencia_pendente = 1 ORDER BY data_upload ASC`
    );
    res.json(linhas);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.get('/api/conferencia/:id', async (req, res) => {
  try {
    const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [req.params.id]);
    if (linhas.length === 0) return res.status(404).json({ erro: 'Caso não encontrado.' });
    const [extr] = await pool.query(
      'SELECT json_extraido, confianca_json, fonte, data_extracao FROM extracoes_ia WHERE caso_id = ? ORDER BY id DESC LIMIT 1',
      [req.params.id]
    );
    res.json({ caso: linhas[0], extracao: extr[0] || null });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: erro.message });
  }
});

app.put('/api/conferencia/:id', async (req, res) => {
  try {
    const casoId = req.params.id;
    const usuario = req.session.usuario.nome;
    const permitidos = ['segurado', 'cpf_ccb', 'parceiro', 'fundo', 'cobertura',
      'data_contratacao', 'data_evento', 'data_admissao', 'motivo_desligamento_codigo',
      'valor_parcela', 'teto_parcela_produto', 'numero_parcelas_contratadas', 'numero_parcelas_cobertas_produto'];

    const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [casoId]);
    if (linhas.length === 0) return res.status(404).json({ erro: 'Caso não encontrado.' });
    const antes = linhas[0];

    for (const campo of permitidos) {
      if (Object.prototype.hasOwnProperty.call(req.body, campo)) {
        let valor = req.body[campo];
        if (valor === '' ) valor = null;
        await registrarHistorico(casoId, campo, antes[campo], valor, usuario);
        await pool.query(`UPDATE casos SET ${campo} = ? WHERE id = ?`, [valor, casoId]);
      }
    }

    // Conferência concluída: libera o caso para o motor de regras decidir o status.
    await registrarHistorico(casoId, 'conferencia', 'pendente', 'conferido por ' + usuario, usuario);
    await pool.query(
      "UPDATE casos SET conferencia_pendente = 0, motivo_conferencia = NULL, status = 'NOVO' WHERE id = ?",
      [casoId]
    );
    const [row] = await pool.query('SELECT cpf_ccb, segurado FROM casos WHERE id = ?', [casoId]);
    const chaves = chavesIdentidade(row[0].cpf_ccb, row[0].segurado);
    await pool.query('UPDATE casos SET identidade_chaves = ?, cpf_ccb = COALESCE(?, cpf_ccb) WHERE id = ?',
      [chaves.length ? JSON.stringify(chaves) : null, formatarCpfCcb(row[0].cpf_ccb), casoId]);

    await aplicarMotorDeRegras(casoId, usuario);
    res.json({ mensagem: 'Conferência salva. O motor de regras reprocessou o caso.' });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao salvar conferência: ' + erro.message });
  }
});

app.get('/api/documentos/:casoId', async (req, res) => {
  try {
    const [linhas] = await pool.query(
      'SELECT id, nome_arquivo, status_processamento, data_upload FROM documentos WHERE caso_id = ? ORDER BY data_upload DESC',
      [req.params.casoId]
    );
    res.json(linhas);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar documentos: ' + erro.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});