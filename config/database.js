'use strict';
const sql = require('mssql');

const baseOpts = {
  server:   process.env.DB_SERVER   || 'localhost',
  port:     parseInt(process.env.DB_PORT || '1433', 10),
  user:     process.env.DB_USER     || 'sa',
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt:                process.env.NODE_ENV === 'production',
    trustServerCertificate: process.env.NODE_ENV !== 'production',
    enableArithAbort:       true,
  },
  pool: {
    max:               10,
    min:               0,
    idleTimeoutMillis: 30000,
  },
};

const masterConfig = { ...baseOpts, database: 'master' };
const appConfig    = { ...baseOpts, database: process.env.DB_NAME || 'transformiq_assn' };

let _pool = null;

async function getPool() {
  if (_pool) return _pool;
  _pool = await sql.connect(appConfig);
  return _pool;
}

async function getMasterPool() {
  return sql.connect(masterConfig);
}

module.exports = { getPool, getMasterPool, sql };
