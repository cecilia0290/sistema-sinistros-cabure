require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const { createWorker } = require('tesseract.js');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');
const { calcularCaso } = require('./regras');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
// A IA SÓ lê e organiza os dados. Ela NUNCA decide nada nem calcula nada.

async function extrairCamposComIA(textoDocumento) {
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
${textoDocumento}
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

// Processa UM documento ou UMA pasta de ZIP já com o texto extraído.
// Decide se atualiza um caso já existente (mesmo CPF/CCB) ou cria um novo (Seção 7.3),
// registra o documento na tabela "documentos" (Seção 8), e no final roda o motor de regras.
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

  await aplicarMotorDeRegras(casoId);

  return { casoId, eraNovo };
}

async function aplicarMotorDeRegras(casoId) {
  const [linhas] = await pool.query('SELECT * FROM casos WHERE id = ?', [casoId]);
  if (linhas.length === 0) return;
  const caso = linhas[0];
  const resultado = calcularCaso(caso);
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

// Processa um ZIP: identifica uma pasta por segurado, junta o texto dos documentos dela,
// e usa processarUnidadeDocumental para decidir se atualiza um caso existente ou cria um novo.
async function processarZip(caminhoZip) {
  const zip = new AdmZip(caminhoZip);
  const entradas = zip.getEntries();
  const pastasPorNome = {};

  entradas.forEach(entrada => {
    if (entrada.isDirectory) return;
    const partesCaminho = entrada.entryName.split('/');
    if (partesCaminho.length < 2) return;
    const nomeDaPasta = partesCaminho[0];
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

    const resultado = await processarUnidadeDocumental(nomeDaPasta, textoAcumulado.trim(), algumPrecisaOcrManual);
    resultados.push(resultado);
  }

  return resultados;
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

    if (status) {
      query += ' AND status = ?';
      parametros.push(status);
    }
    if (parceiro) {
      query += ' AND parceiro = ?';
      parametros.push(parceiro);
    }
    query += ' ORDER BY id DESC';

    const [linhas] = await pool.query(query, parametros);
    res.json(linhas);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao buscar os casos: ' + erro.message });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [porStatus] = await pool.query('SELECT status, COUNT(*) AS quantidade FROM casos GROUP BY status');
    const [porParceiro] = await pool.query(
      'SELECT parceiro, COUNT(*) AS quantidade FROM casos WHERE parceiro IS NOT NULL GROUP BY parceiro'
    );
    const [totalAPagarLinhas] = await pool.query(
      "SELECT COALESCE(SUM(valor_a_pagar), 0) AS total FROM casos WHERE status = 'PRONTO PARA PAGAR'"
    );
    res.json({ porStatus, porParceiro, totalAPagar: totalAPagarLinhas[0].total });
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