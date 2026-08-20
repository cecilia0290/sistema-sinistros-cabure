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
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');
const { calcularCaso, verificarElegibilidade, calcularCarencia, calcularFranquia } = require('./regras');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    req.path === '/casos' || req.path === '/exportar';
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// --- Extração de texto bruto ---

async function ocrImagem(caminhoArquivo) {
  const worker = await createWorker('por');
  const { data } = await worker.recognize(caminhoArquivo);
  await worker.terminate();
  return data.text;
}

async function extrairTextoDeArquivo(caminhoArquivo) {
  const extensao = path.extname(caminhoArquivo).toLowerCase();

  if (extensao === '.pdf') {
    const bufferArquivo = fs.readFileSync(caminhoArquivo);
    const parser = new PDFParse({ data: bufferArquivo });
    const dadosPdf = await parser.getText();
    const texto = dadosPdf.text || '';
    if (texto.trim().length < 50) return { texto: '', precisaOcrManual: true };
    return { texto, precisaOcrManual: false };
  }

  if (extensao === '.docx') {
    const resultado = await mammoth.extractRawText({ path: caminhoArquivo });
    return { texto: resultado.value, precisaOcrManual: false };
  }

  if (extensao === '.jpg' || extensao === '.jpeg' || extensao === '.png') {
    const texto = await ocrImagem(caminhoArquivo);
    return { texto, precisaOcrManual: false };
  }

  return { texto: `[Arquivo com extensão ${extensao} não pôde ser lido automaticamente nesta etapa]`, precisaOcrManual: false };
}

// --- Extração estruturada por IA ---

const MAX_CARACTERES_PARA_IA = 600000; // ~150 mil tokens, margem de seguranca abaixo do limite do modelo (200 mil tokens)

async function extrairCamposComIA(textoDocumento) {
  const textoParaAnalise = textoDocumento.length > MAX_CARACTERES_PARA_IA
    ? textoDocumento.slice(0, MAX_CARACTERES_PARA_IA) + '\n\n[AVISO: texto truncado por ser muito extenso — apenas a primeira parte foi analisada. Revisar manualmente se necessario.]'
    : textoDocumento;

  const prompt = `Você vai ler o texto de um documento de sinistro de seguro (perda de renda / seguro prestamista).
Extraia APENAS os campos abaixo, exatamente como aparecem no texto. Não calcule nada, não deduza nada que não esteja explícito.
Se um campo não existir no texto, devolva null para ele.

Atenção especial ao campo "cobertura": documentos como "Anexo I", "Termo de Seguro" ou "Apólice" costumam ter uma seção chamada
"Cobertura Capital Segurado" ou "Cobertura Contratada", geralmente em formato de tabela (o texto pode sair desorganizado da
extração do PDF). Procure por termos como "Perda de Renda", "Morte", "Invalidez" nesse tipo de seção — se encontrar "Perda de
Renda" mencionado como uma cobertura contratada, use "Perda de Renda" como valor do campo cobertura, mesmo que o texto ao
redor esteja com formatação estranha.

Responda SOMENTE com um JSON válido, sem nenhum texto antes ou depois, no formato exato:

{
  "segurado": "nome completo da pessoa segurada, ou null",
  "cpf_ccb": "CPF ou número da Cédula de Crédito Bancário, ou null",
  "parceiro": "nome do parceiro financeiro (ex: SETHI, POUPACRED, GRANATECH, X3, Invest All, Fintech Corban, Nova, Resgata), ou null",
  "fundo": "nome do fundo/instituição relacionada (ex: GUARDIAN), ou null",
  "cobertura": "tipo de cobertura do sinistro, ou null",
  "data_contratacao": "data da contratação do seguro no formato AAAA-MM-DD, ou null",
  "data_evento": "data do desligamento/evento gerador do sinistro no formato AAAA-MM-DD, ou null",
  "data_admissao": "data de admissão no vínculo empregatício, no formato AAAA-MM-DD, ou null",
  "motivo_desligamento_codigo": "código numérico do motivo do desligamento, como texto, ou null",
  "valor_parcela": "valor numérico da PARCELA DO EMPRÉSTIMO/CCB, ou null",
  "limite_beneficio": "valor numérico do limite TOTAL do benefício do seguro, ou null",
  "numero_parcelas_contratadas": "número inteiro de parcelas do EMPRÉSTIMO/CCB, ou null",
  "teto_parcela_produto": "valor numérico do teto de CADA parcela do SEGURO (não confundir com parcela do empréstimo), ou null",
  "numero_parcelas_cobertas_produto": "número inteiro de parcelas que o SEGURO cobre, ou null",
  "fonte_produto": "nome do documento onde você confirmou o teto/parcelas do seguro, ou null"
}

Texto do documento:
"""
${textoParaAnalise}
"""`;

  const resposta = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  const textoResposta = resposta.content[0].text.trim();
  const jsonLimpo = textoResposta.replace(/```json|```/g, '').trim();
  return JSON.parse(jsonLimpo);
}

// --- Vínculo entre documentos (Seção 7.3) ---

function normalizarCpfCcb(valor) {
  if (!valor) return null;
  const limpo = String(valor).replace(/[^a-zA-Z0-9]/g, '');
  return limpo.length > 0 ? limpo : null;
}

async function buscarCasoPorCpfCcb(cpfCcbNormalizado) {
  if (!cpfCcbNormalizado) return null;
  const [linhas] = await pool.query(
    `SELECT id FROM casos
     WHERE REPLACE(REPLACE(REPLACE(cpf_ccb, '.', ''), '-', ''), '/', '') = ?`,
    [cpfCcbNormalizado]
  );
  return linhas.length > 0 ? linhas[0].id : null;
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

async function processarUnidadeDocumental(nomeReferencia, textoExtraido, precisaOcrManual) {
  let campos = null;
  if (textoExtraido && textoExtraido.trim().length >= 10) {
    campos = await extrairCamposComIA(textoExtraido);
  }

  const cpfNormalizado = campos ? normalizarCpfCcb(campos.cpf_ccb) : null;
  const casoExistenteId = await buscarCasoPorCpfCcb(cpfNormalizado);

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
    const [resultado] = await pool.query(
      'INSERT INTO casos (nome_arquivo, texto_extraido, status) VALUES (?, ?, ?)',
      [nomeReferencia, textoExtraido, precisaOcrManual ? 'AGUARDANDO OCR MANUAL' : 'NOVO']
    );
    casoId = resultado.insertId;
    eraNovo = true;
  }

  await pool.query(
    'INSERT INTO documentos (caso_id, nome_arquivo, status_processamento, texto_extraido) VALUES (?, ?, ?, ?)',
    [casoId, nomeReferencia, precisaOcrManual ? 'AGUARDANDO OCR MANUAL' : 'PROCESSADO', textoExtraido]
  );

  if (campos) {
    await pool.query(
      'INSERT INTO extracoes_ia (caso_id, json_extraido) VALUES (?, ?)',
      [casoId, JSON.stringify(campos)]
    );

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
        campos.segurado, campos.cpf_ccb, campos.parceiro, campos.fundo, campos.cobertura,
        campos.data_contratacao, campos.data_evento, campos.data_admissao, campos.motivo_desligamento_codigo,
        campos.valor_parcela, campos.limite_beneficio, campos.numero_parcelas_contratadas,
        campos.teto_parcela_produto, campos.numero_parcelas_cobertas_produto, campos.fonte_produto,
        casoId
      ]
    );
  }

  await aplicarMotorDeRegras(casoId, 'Sistema (IA + motor de regras)');

  return { casoId, eraNovo };
}

// Roda o motor de regras, e registra em "historico" qualquer mudança de status ou valor a pagar
async function aplicarMotorDeRegras(casoId, usuario) {
  const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [casoId]);
  if (linhas.length === 0) return;
  const casoAntes = linhas[0];
  const resultado = calcularCaso(casoAntes);

  await registrarHistorico(casoId, 'status', casoAntes.status, resultado.status, usuario);
  await registrarHistorico(casoId, 'valor_a_pagar', casoAntes.valor_a_pagar, resultado.valorAPagar, usuario);

  await pool.query(
    `UPDATE casos SET
      carencia_dias = ?, franquia_data = ?, cia = ?, valor_a_pagar = ?, status = ?, motivo_negacao = ?
     WHERE id = ?`,
    [
      resultado.carenciaDias, resultado.franquiaData, resultado.cia, resultado.valorAPagar,
      resultado.status, resultado.motivoNegacao, casoId
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
  const extensoesAceitas = ['.pdf', '.docx', '.jpg', '.jpeg', '.png'];

  for (const nomeDaPasta of Object.keys(pastasPorNome)) {
    let textoAcumulado = '';
    let algumPrecisaOcrManual = false;

    for (const entrada of pastasPorNome[nomeDaPasta]) {
      const extensao = path.extname(entrada.entryName).toLowerCase();
      if (!extensoesAceitas.includes(extensao)) continue;

      const caminhoTemporario = path.join('uploads', Date.now() + '-' + path.basename(entrada.entryName));
      fs.writeFileSync(caminhoTemporario, entrada.getData());

      const resultadoExtracao = await extrairTextoDeArquivo(caminhoTemporario);
      if (resultadoExtracao.precisaOcrManual) algumPrecisaOcrManual = true;
      textoAcumulado += `\n\n--- ${entrada.entryName} ---\n` + resultadoExtracao.texto;

      fs.unlinkSync(caminhoTemporario);
    }

    // Se, depois de filtrar por extensao aceita, sobrou texto vazio (ex.: a pasta so tinha uma
    // planilha .xlsx solta ou outro arquivo que ainda nao sabemos ler), nao cria um caso fantasma.
    if (textoAcumulado.trim().length === 0) continue;

    const resultado = await processarUnidadeDocumental(nomeDaPasta, textoAcumulado.trim(), algumPrecisaOcrManual);
    resultados.push(resultado);
  }

  return resultados;
}

async function criarCaso(nomeArquivoOuPasta, textoExtraido, status) {
  const [resultado] = await pool.query(
    'INSERT INTO casos (nome_arquivo, texto_extraido, status) VALUES (?, ?, ?)',
    [nomeArquivoOuPasta, textoExtraido, status]
  );
  return resultado.insertId;
}

// --- Rotas ---

app.post('/upload', upload.single('documento'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });
    }

    const caminhoArquivo = req.file.path;
    const extensao = path.extname(req.file.originalname).toLowerCase();

    if (extensao === '.zip') {
      const resultados = await processarZip(caminhoArquivo);
      const criados = resultados.filter(r => r.eraNovo).length;
      const atualizados = resultados.filter(r => !r.eraNovo).length;
      return res.json({
        mensagem: `ZIP processado com sucesso. ${criados} caso(s) novo(s), ${atualizados} caso(s) atualizado(s).`,
        ids: resultados.map(r => r.casoId)
      });
    }

    const extensoesAceitas = ['.pdf', '.docx', '.jpg', '.jpeg', '.png'];
    if (extensoesAceitas.includes(extensao)) {
      const resultadoExtracao = await extrairTextoDeArquivo(caminhoArquivo);
      const resultado = await processarUnidadeDocumental(
        req.file.originalname, resultadoExtracao.texto, resultadoExtracao.precisaOcrManual
      );
      const mensagem = resultado.eraNovo
        ? 'Caso novo criado com sucesso.'
        : 'Documento vinculado a um caso já existente (mesmo CPF/CCB).';
      return res.json({ id: resultado.casoId, mensagem });
    }

    return res.status(400).json({ erro: 'Formato de arquivo não suportado nesta etapa (use PDF, DOCX, ZIP, JPG ou PNG).' });

  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao processar o arquivo: ' + erro.message });
  }
});

app.get('/casos', async (req, res) => {
  try {
    const { status, parceiro } = req.query;
    let query = 'SELECT * FROM casos WHERE 1=1';
    const parametros = [];
    if (status) { query += ' AND status = ?'; parametros.push(status); }
    if (parceiro) { query += ' AND parceiro = ?'; parametros.push(parceiro); }
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

app.get('/api/dashboard', async (req, res) => {
  try {
    const [porStatus] = await pool.query('SELECT status, COUNT(*) AS quantidade FROM casos GROUP BY status');
    const [porParceiro] = await pool.query(
      'SELECT parceiro, COUNT(*) AS quantidade FROM casos WHERE parceiro IS NOT NULL GROUP BY parceiro'
    );
    const [valorPorParceiro] = await pool.query(
      `SELECT parceiro, COALESCE(SUM(valor_a_pagar), 0) AS total
       FROM casos WHERE parceiro IS NOT NULL AND valor_a_pagar IS NOT NULL
       GROUP BY parceiro`
    );
    const [porMes] = await pool.query(
      `SELECT DATE_FORMAT(data_upload, '%Y-%m') AS mes, COUNT(*) AS quantidade
       FROM casos GROUP BY mes ORDER BY mes ASC`
    );
    const [totalAPagarLinhas] = await pool.query(
      "SELECT COALESCE(SUM(valor_a_pagar), 0) AS total FROM casos WHERE status = 'PRONTO PARA PAGAR'"
    );

    // Contagens específicas para os cartões do dashboard (Seção 6 — legenda de status)
    const contarPorStatus = (...statusList) =>
      porStatus.filter(item => statusList.includes(item.status)).reduce((soma, item) => soma + item.quantidade, 0);

    const totalCasos = porStatus.reduce((soma, item) => soma + item.quantidade, 0);

    res.json({
      porStatus,
      porParceiro,
      valorPorParceiro,
      porMes,
      totalAPagar: totalAPagarLinhas[0].total,
      totalCasos,
      emAnalise: contarPorStatus('EM CARÊNCIA / ANÁLISE'),
      pendentes: contarPorStatus('AGUARDANDO DOC', 'AGUARDANDO OCR MANUAL'),
      pagos: contarPorStatus('PAGO'),
      cancelados: contarPorStatus('CANCELADO')
    });
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar o dashboard: ' + erro.message });
  }
});

app.get('/exportar', async (req, res) => {
  try {
    const [linhas] = await pool.query(`
      SELECT
        id, segurado, cpf_ccb, parceiro, fundo, cobertura,
        data_contratacao, data_evento, data_admissao,
        valor_parcela, limite_beneficio, numero_parcelas_contratadas,
        teto_parcela_produto, numero_parcelas_cobertas_produto, fonte_produto,
        carencia_dias, franquia_data, cia, valor_a_pagar, status, motivo_negacao,
        nome_arquivo, data_upload
      FROM casos ORDER BY id DESC
    `);
    const planilha = XLSX.utils.json_to_sheet(linhas);
    const livro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(livro, planilha, 'CONSOLIDADO');
    const buffer = XLSX.write(livro, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename=casos_sinistros.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (erro) {
    console.error(erro);
    res.status(500).send('Erro ao exportar: ' + erro.message);
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