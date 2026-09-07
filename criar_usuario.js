// Cria um usuário do sistema.
//
//   Interativo:      node criar_usuario.js
//   Não-interativo:  node criar_usuario.js --usuario admin --senha "S3nh@..." --nome "Fulana" --perfil administrador
//
require('dotenv').config();
const bcrypt = require('bcryptjs');
const readline = require('readline');
const pool = require('./db');

function parseArgs() {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  }
  return o;
}

function perguntar(rl, texto) {
  return new Promise(resolve => rl.question(texto, resolve));
}

async function criar({ nome, usuario, senha, perfil }) {
  if (!usuario || !senha) throw new Error('usuário e senha são obrigatórios');
  perfil = perfil || 'administrador';
  nome = nome || usuario;

  const [existe] = await pool.query('SELECT id FROM usuarios WHERE usuario = ?', [usuario]);
  if (existe.length) throw new Error(`já existe um usuário com o login "${usuario}"`);

  const senhaHash = await bcrypt.hash(senha, 10);
  await pool.query(
    'INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?, ?, ?, ?)',
    [nome, usuario, senhaHash, perfil]
  );
  console.log(`Usuário "${usuario}" (${perfil}) criado com sucesso.`);
}

(async () => {
  try {
    const args = parseArgs();
    if (args.usuario && args.senha) {
      await criar(args);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log('=== Criar novo usuário do sistema ===');
      const nome = await perguntar(rl, 'Nome completo: ');
      const usuario = await perguntar(rl, 'Login (ex.: admin): ');
      const senha = await perguntar(rl, 'Senha: ');
      const perfil = await perguntar(rl, 'Perfil (analista / aprovador / administrador): ');
      rl.close();
      await criar({ nome, usuario, senha, perfil });
    }
    await pool.end();
    process.exit(0);
  } catch (erro) {
    console.error('Erro ao criar usuário:', erro.message);
    try { await pool.end(); } catch (e) {}
    process.exit(1);
  }
})();
