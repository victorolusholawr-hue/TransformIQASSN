'use strict';
const fs   = require('fs');
const path = require('path');
const { getPool, getMasterPool } = require('../config/database');
const { recoverMissingLocalSources } = require('../services/dataHealth');

const DB_NAME = process.env.DB_NAME || 'transformiq_assn';

async function initDb() {
  // 1. Connect to master and create the application database if it doesn't exist.
  const master = await getMasterPool();
  await master.request().query(`
    IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = '${DB_NAME}')
    CREATE DATABASE [${DB_NAME}]
  `);
  await master.close();

  // 2. Now connect to the app database and run the schema.
  const pool  = await getPool();
  const sqlTxt = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  const batches = sqlTxt
    .split(/^\s*GO\s*$/im)
    .map(b => b.trim())
    .filter(Boolean);

  for (const batch of batches) {
    await pool.request().query(batch);
  }

  try {
    const repair = await recoverMissingLocalSources({ pool });
    if (repair.recovered.length) {
      console.log(`[db] Recovered ${repair.recovered.length} local source file(s)`);
    }
  } catch (err) {
    console.error('[db] Local source recovery check failed:', err);
  }

  console.log('[db] Schema initialised');
}

module.exports = { initDb };
