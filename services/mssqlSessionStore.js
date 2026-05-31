'use strict';

const session = require('express-session');
const { getPool, sql } = require('../config/database');

class MssqlSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = options.ttlMs || 7 * 24 * 60 * 60 * 1000;
  }

  async get(sid, callback) {
    try {
      const pool = await getPool();
      const result = await pool.request()
        .input('sid', sql.NVarChar, sid)
        .query(`
          SELECT sess
          FROM dbo.Sessions
          WHERE sid=@sid AND expires_at > GETUTCDATE()
        `);
      if (!result.recordset.length) return callback(null, null);
      callback(null, JSON.parse(result.recordset[0].sess));
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sess, callback) {
    try {
      const pool = await getPool();
      const expiresAt = this._expiresAt(sess);
      await pool.request()
        .input('sid', sql.NVarChar, sid)
        .input('sess', sql.NVarChar, JSON.stringify(sess))
        .input('expires', sql.DateTime2, expiresAt)
        .query(`
          IF EXISTS (SELECT 1 FROM dbo.Sessions WHERE sid=@sid)
            UPDATE dbo.Sessions
            SET sess=@sess, expires_at=@expires, updated_at=GETUTCDATE()
            WHERE sid=@sid
          ELSE
            INSERT INTO dbo.Sessions (sid, sess, expires_at)
            VALUES (@sid, @sess, @expires)
        `);
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      const pool = await getPool();
      await pool.request()
        .input('sid', sql.NVarChar, sid)
        .query('DELETE FROM dbo.Sessions WHERE sid=@sid');
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  async touch(sid, sess, callback) {
    try {
      const pool = await getPool();
      await pool.request()
        .input('sid', sql.NVarChar, sid)
        .input('expires', sql.DateTime2, this._expiresAt(sess))
        .query('UPDATE dbo.Sessions SET expires_at=@expires, updated_at=GETUTCDATE() WHERE sid=@sid');
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  async prune() {
    try {
      const pool = await getPool();
      await pool.request().query('DELETE FROM dbo.Sessions WHERE expires_at <= GETUTCDATE()');
    } catch (_) {}
  }

  _expiresAt(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      const expires = new Date(sess.cookie.expires);
      if (!Number.isNaN(expires.getTime())) return expires;
    }
    return new Date(Date.now() + this.ttlMs);
  }
}

module.exports = MssqlSessionStore;
