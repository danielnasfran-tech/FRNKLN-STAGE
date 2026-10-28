'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, DATA_DIR } = require('./db');

// Segredo persistente: sobrevive a reinícios do container mesmo sem env var.
const JWT_SECRET =
  process.env.JWT_SECRET || (() => {
    const file = path.join(DATA_DIR, '.jwt-secret');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  })();

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.cookies && req.cookies.fnk_token) return req.cookies.fnk_token;
  return null;
}

/**
 * Exige sessão válida. Todos os recursos são filtrados por owner_id,
 * garantindo que um usuário nunca leia/escreva dados de outro
 * (equivalente a Row Level Security).
 */
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ error: 'unauthorized', message: 'Sessão não encontrada.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'session_expired', message: 'Sessão expirada.' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res
      .status(401)
      .json({ error: 'session_expired', message: 'Sessão expirada. Entre novamente.' });
  }
}

function setAuthCookie(res, token) {
  res.cookie('fnk_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  });
}

module.exports = {
  JWT_SECRET,
  TOKEN_TTL_SECONDS,
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  setAuthCookie,
  readToken,
};
