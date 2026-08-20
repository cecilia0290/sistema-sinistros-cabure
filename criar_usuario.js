// Script para criar o primeiro usuário administrador do sistema.
// Rode com: node criar_usuario.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const readline = require('readline');
const pool = require('./db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function perguntar(pergunta) {
  return new Promise(resolve => rl.question(pergunta, resolve));
}

async function main() {
  console.log('=== Criar novo usuário do sistema ===');
  const nome = await perguntar('Nome completo: ');
  const usuario = await perguntar('Login (ex.: admin): ');
  const senha = await perguntar('Senha: ');
  const perfil = await perguntar('Perfil (analista / aprovador / administrador): ');

  const senhaHash = await bcrypt.hash(senha, 10);

  await pool.query(
    'INSERT INTO usuarios (nome, usuario, senha_hash, perfil) VALUES (?, ?, ?, ?)',
    [nome, usuario, senhaHash, perfil]
  );

  console.log(`Usuário "${usuario}" criado com sucesso!`);
  rl.close();
  process.exit(0);
}

main().catch(erro => {
  console.error('Erro ao criar usuário:', erro.message);
  rl.close();
  process.exit(1);
});