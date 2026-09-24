const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middlewares & Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(__dirname));

// Cache & Database State
const rankCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
let cachedLoginTableName = null;

// Default Admin Security State (Override via ENV if available)
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || 'MAWI_SMP_SECURE_TOKEN_SECRET_2026';
let adminAccount = {
  username: process.env.ADMIN_USERNAME || 'admin',
  email: process.env.ADMIN_EMAIL || 'admin@mawi.com',
  // SHA-256 Hash of default password 'mawi2026'
  passwordHash: hashText(process.env.ADMIN_PASSWORD || 'mawi2026'),
  // 2FA Security PIN (6 Digits)
  securityPinHash: hashText(process.env.ADMIN_PIN || '123456')
};

// Brute-force & Login Rate Limiting Store
const failedLoginAttempts = new Map(); // IP -> { count, lockoutUntil }

function hashText(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

function generateSessionToken(username) {
  const payload = `${username}:${Date.now()}:${Math.random()}`;
  const signature = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64');
}

function verifySessionToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return false;
    const [username, timestamp, rand, signature] = parts;
    const payload = `${username}:${timestamp}:${rand}`;
    const expectedSig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
    
    // Check signature & 24h expiration
    if (signature !== expectedSig) return false;
    if (Date.now() - Number(timestamp) > 24 * 60 * 60 * 1000) return false;
    return true;
  } catch (err) {
    return false;
  }
}

const DEFAULT_RANK_PRICES = {
  'DEFAULT': 0, 'MEMBER': 0, 'VIP': 25000, 'MVP': 50000, 'SULTAN': 100000, 'OVERLORD': 200000, 'LWN': 390000, 'LORD': 390000
};

const createFastPool = (host, user, password, database, port) => {
  return mysql.createPool({
    host: host || 'localhost',
    user: user || 'root',
    password: password || '',
    database: database || 'minecraft_db',
    port: Number(port) || 3306,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 2000
  });
};

const luckpermsPool = createFastPool(
  process.env.LP_DB_HOST || process.env.DB_HOST,
  process.env.LP_DB_USER || process.env.DB_USER,
  process.env.LP_DB_PASS || process.env.DB_PASSWORD,
  process.env.LP_DB_NAME || process.env.DB_NAME_LUCKPERMS || process.env.DB_NAME,
  process.env.LP_DB_PORT || process.env.DB_PORT
);

const libreloginPool = createFastPool(
  process.env.LOGIN_DB_HOST || process.env.DB_HOST,
  process.env.LOGIN_DB_USER || process.env.DB_USER,
  process.env.LOGIN_DB_PASS || process.env.DB_PASSWORD,
  process.env.LOGIN_DB_NAME || process.env.DB_NAME_LIBRELOGIN || process.env.DB_NAME,
  process.env.LOGIN_DB_PORT || process.env.DB_PORT
);

async function queryWithTimeout(pool, sql, params, timeoutMs = 2000) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED')), timeoutMs))
  ]);
}

async function detectLoginTable() {
  if (cachedLoginTableName) return cachedLoginTableName;
  const candidateTables = ['librepremium_data', 'librelogin_users', 'users'];
  for (const table of candidateTables) {
    try {
      await queryWithTimeout(libreloginPool, `SELECT 1 FROM ${table} LIMIT 1`, [], 1000);
      cachedLoginTableName = table;
      return table;
    } catch (e) {}
  }
  return null;
}

// ----------------------------------------------------
// API ENDPOINTS
// ----------------------------------------------------

// Endpoint for frontend signal & latency preloader testing
app.get('/api/ping', (req, res) => {
  res.json({
    success: true,
    timestamp: Date.now(),
    server: 'Mawi SMP Active',
    version: '2.5.0-SECURE'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', server: 'Mawi SMP Backend Running', securityLevel: 'HIGH' });
});

// Admin Login Endpoint with 2FA PIN & Brute-force Protection
app.post('/api/admin/login', (req, res) => {
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
  const now = Date.now();

  // Check brute force lockout
  const attemptInfo = failedLoginAttempts.get(clientIp) || { count: 0, lockoutUntil: 0 };
  if (attemptInfo.lockoutUntil > now) {
    const remainingSec = Math.ceil((attemptInfo.lockoutUntil - now) / 1000);
    return res.status(429).json({
      success: false,
      message: `Akun terkunci sementara karena 3x percobaan gagal. Coba lagi dalam ${remainingSec} detik.`,
      lockout: true,
      remainingSec
    });
  }

  const { credential, password, pin } = req.body;
  if (!credential || !password || !pin) {
    return res.status(400).json({ success: false, message: 'Username/Email, Password, dan 2FA Security PIN wajib diisi!' });
  }

  const inputCred = String(credential).trim().toLowerCase();
  const inputPassHash = hashText(password);
  const inputPinHash = hashText(pin);

  const isUserMatch = (inputCred === adminAccount.username.toLowerCase() || inputCred === adminAccount.email.toLowerCase());
  const isPassMatch = (inputPassHash === adminAccount.passwordHash);
  const isPinMatch = (inputPinHash === adminAccount.securityPinHash);

  if (isUserMatch && isPassMatch && isPinMatch) {
    failedLoginAttempts.delete(clientIp);
    const sessionToken = generateSessionToken(adminAccount.username);
    return res.json({
      success: true,
      token: sessionToken,
      user: {
        username: adminAccount.username,
        email: adminAccount.email,
        isAdmin: true,
        securityLevel: '2FA_PROTECTED'
      }
    });
  }

  // Failed login attempt tracking
  attemptInfo.count += 1;
  if (attemptInfo.count >= 3) {
    attemptInfo.lockoutUntil = now + 60 * 1000; // 60 seconds lockout
    failedLoginAttempts.set(clientIp, attemptInfo);
    return res.status(429).json({
      success: false,
      message: '3x Salah password/PIN! Akses admin dikunci selama 60 detik.',
      lockout: true,
      remainingSec: 60
    });
  } else {
    failedLoginAttempts.set(clientIp, attemptInfo);
    return res.status(401).json({
      success: false,
      message: `Username, Password, atau 2FA PIN Salah! Sisa percobaan: ${3 - attemptInfo.count}`
    });
  }
});

// Admin Verify Token Endpoint
app.post('/api/admin/verify-token', (req, res) => {
  const { token } = req.body;
  const isValid = verifySessionToken(token);
  if (isValid) {
    return res.json({ success: true, valid: true, user: { username: adminAccount.username, email: adminAccount.email, isAdmin: true } });
  }
  return res.status(401).json({ success: false, valid: false });
});

// Admin Update Security Credentials
app.post('/api/admin/update-credentials', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!verifySessionToken(token)) {
    return res.status(401).json({ success: false, message: 'Sesi admin tidak valid atau telah kadaluarsa.' });
  }

  const { newUsername, newEmail, currentPassword, newPassword, newPin } = req.body;

  // Verify current password first
  if (hashText(currentPassword) !== adminAccount.passwordHash) {
    return res.status(400).json({ success: false, message: 'Password lama saat ini salah!' });
  }

  if (newUsername) adminAccount.username = String(newUsername).trim();
  if (newEmail) adminAccount.email = String(newEmail).trim();
  if (newPassword && newPassword.trim().length >= 6) {
    adminAccount.passwordHash = hashText(newPassword);
  }
  if (newPin && String(newPin).trim().length === 6) {
    adminAccount.securityPinHash = hashText(newPin);
  }

  const newSessionToken = generateSessionToken(adminAccount.username);
  return res.json({
    success: true,
    message: 'Kredensial keamanan admin berhasil diperbarui!',
    token: newSessionToken,
    user: { username: adminAccount.username, email: adminAccount.email, isAdmin: true }
  });
});

// Player Rank Check
app.post('/api/player/check-rank', async (req, res) => {
  const { username, platform } = req.body;
  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ success: false, player: { username: '', platform: platform || 'Java', rank: 'DEFAULT', rankPrice: 0, isRegistered: false } });
  }

  let rawUsername = username.trim();
  const isBedrock = (platform === 'MCPE' || platform === 'Bedrock');
  let possibleUsernames = [rawUsername];
  if (isBedrock) {
    if (!rawUsername.startsWith('_')) possibleUsernames.push(`_${rawUsername}`);
    if (!rawUsername.endsWith('_')) possibleUsernames.push(`${rawUsername}_`);
  } else {
    if (rawUsername.startsWith('_')) possibleUsernames.push(rawUsername.replace(/^_/, ''));
  }

  const cacheKey = `${rawUsername.toLowerCase()}_${isBedrock ? 'bedrock' : 'java'}`;
  if (rankCache.has(cacheKey)) {
    const cachedData = rankCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) return res.json(cachedData.response);
  }

  let cleanSkinName = rawUsername.replace(/^_+|_+$/g, '') || 'Steve';
  const headAvatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanSkinName)}/100`;

  const placeholders = possibleUsernames.map(() => '?').join(',');
  const lowerUsernames = possibleUsernames.map(u => u.toLowerCase());

  const lpPromise = queryWithTimeout(luckpermsPool, `SELECT uuid, username, COALESCE(primary_group, 'default') AS primary_group FROM luckperms_players WHERE LOWER(username) IN (${placeholders}) LIMIT 1`, lowerUsernames, 1500);
  const loginPromise = (async () => {
    const table = await detectLoginTable();
    if (!table) return [];
    const [rows] = await queryWithTimeout(libreloginPool, `SELECT * FROM ${table} WHERE LOWER(username) IN (${placeholders}) OR LOWER(name) IN (${placeholders}) LIMIT 1`, [...lowerUsernames, ...lowerUsernames], 1500);
    return rows;
  })();

  const [lpResult, loginResult] = await Promise.allSettled([lpPromise, loginPromise]);
  let rankRows = (lpResult.status === 'fulfilled' && lpResult.value[0]) ? lpResult.value[0] : [];
  let loginRows = (loginResult.status === 'fulfilled' && loginResult.value) ? loginResult.value : [];
  let permRows = [];

  if (rankRows.length > 0 && (rankRows[0].primary_group || 'default').toLowerCase() === 'default') {
    try {
      const [permRes] = await queryWithTimeout(luckpermsPool, `SELECT permission FROM luckperms_user_permissions WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1 LIMIT 5`, [rankRows[0].uuid], 1000);
      permRows = permRes;
    } catch (err) {}
  }

  let detectedRank = 'DEFAULT';
  if (rankRows.length > 0) {
    const primary = (rankRows[0].primary_group || 'default').toUpperCase();
    if (primary !== 'DEFAULT') detectedRank = primary;
    else if (permRows.length > 0) {
      const customGroup = permRows.find(p => p.permission.toLowerCase() !== 'group.default');
      if (customGroup) detectedRank = customGroup.permission.replace(/^group\./i, '').toUpperCase();
    }
  }

  const matchedUsername = rankRows.length > 0 ? rankRows[0].username : (loginRows.length > 0 ? (loginRows[0].username || loginRows[0].name || rawUsername) : rawUsername);
  const isRegistered = rankRows.length > 0 || loginRows.length > 0;
  const currentRankPrice = DEFAULT_RANK_PRICES[detectedRank] || 0;

  const resultResponse = {
    success: true,
    player: { username: matchedUsername, platform: isBedrock ? 'Bedrock' : 'Java', rank: detectedRank, rankPrice: currentRankPrice, isRegistered, headAvatarUrl }
  };

  rankCache.set(cacheKey, { timestamp: Date.now(), response: resultResponse });
  return res.json(resultResponse);
});

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'official_store_updates_web_app.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Mawi SMP Server aktif di http://localhost:${PORT}`);
  console.log(`🔒 Proteksi Admin 2FA PIN Active`);
  detectLoginTable().catch(() => {});
});
