'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET
  ? Buffer.from(process.env.JWT_SECRET, 'hex')
  : crypto.randomBytes(64);

const TOKEN_EXPIRY = '24h';

function createToken(player) {
  return jwt.sign(
    {
      sub: player.id,
      username: player.username,
      iat: Math.floor(Date.now() / 1000),
    },
    SECRET,
    { expiresIn: TOKEN_EXPIRY, algorithm: 'HS512' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET, { algorithms: ['HS512'] });
  } catch {
    return null;
  }
}

module.exports = { createToken, verifyToken };
