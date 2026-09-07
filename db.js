require('dotenv').config();
const mysql = require('mysql2/promise');

// Railway (MySQL gerenciado): use o host/porta PÚBLICOS do serviço, que vêm em
// variáveis separadas. DB_PORT costuma não ser 3306 no endpoint público.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, // no Railway gerenciado este banco chama-se "railway"
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true
});

module.exports = pool;
