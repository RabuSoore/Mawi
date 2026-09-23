/**
 * MAWI SMP - UNIFIED BACKEND & FRONTEND SERVER
 * Menjalankan Backend API Express + Menyajikan Website index.html dalam 1 Aplikasi
 */

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Keamanan & Parsing
app.use(cors());
app.use(express.json({ limit: '20kb' }));

// Menyajikan File Statis (index.html, gambar, CSS) langsung dari root folder
app.use(express.static(__dirname));

// HIRARKI HARGA DEFAULT RANK SERVER
const DEFAULT_RANK_PRICES = {
  'DEFAULT': 0,
  'MEMBER': 0,
  'VIP': 25000,
  'MVP': 50000,
  'SULTAN': 100000,
  'OVERLORD': 200000,
  'LORD': 390000
};

// ==========================================
// 1. ANTI-BOT & RATE LIMITER MIDDLEWARE
// ==========================================
const requestRateMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 Menit
const MAX_REQUESTS_PER_WINDOW = 20;

const antiBotRateLimiter = (req, res, next) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown_ip';
  const now = Date.now();

  if (!requestRateMap.has(clientIp)) {
    requestRateMap.set(clientIp, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
  } else {
    const ipData = requestRateMap.get(clientIp);
    if (now > ipData.resetTime) {
      ipData.count = 1;
      ipData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    } else {
      ipData.count++;
      if (ipData.count > MAX_REQUESTS_PER_WINDOW) {
        console.warn(`[ANTI-BOT PROTECT] Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
          success: false,
          message: 'Terlalu banyak permintaan. Silakan tunggu 1 menit!'
        });
      }
    }
  }
  next();
};

app.use('/api/', antiBotRateLimiter);

// MySQL Connection Pool Configuration
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'minecraft_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ==========================================
// 2. BACKEND API ENDPOINTS
// ==========================================

// Pengecekan Rank & Bedrock Prefix
app.post('/api/player/check-rank', async (req, res) => {
  const { username, platform } = req.body;

  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({
      success: false,
      message: 'Username parameter tidak valid',
      player: { 
        username: '', 
        platform: platform || 'Java', 
        rank: 'DEFAULT', 
        rankPrice: 0, 
        isRegistered: false,
        headAvatarUrl: 'https://mc-heads.net/avatar/Steve/100'
      }
    });
  }

  let rawUsername = username.trim();
  const isBedrock = (platform === 'MCPE' || platform === 'Bedrock');

  // Penanganan otomatis Prefix '_' Bedrock/Geyser
  let possibleUsernames = [rawUsername];
  if (isBedrock) {
    if (!rawUsername.startsWith('_')) possibleUsernames.push(`_${rawUsername}`);
    if (!rawUsername.endsWith('_')) possibleUsernames.push(`${rawUsername}_`);
  }

  let cleanSkinName = rawUsername.replace(/^_+|_+$/g, '') || 'Steve';
  const headAvatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanSkinName)}/100`;

  try {
    const placeholders = possibleUsernames.map(() => '?').join(',');

    // 1. Query LuckPerms
    const [rankRows] = await dbPool.query(
      `SELECT username, COALESCE(primary_group, 'default') AS primary_group 
       FROM luckperms_players 
       WHERE LOWER(username) IN (${placeholders.toLowerCase()})
       LIMIT 1`,
      possibleUsernames.map(u => u.toLowerCase())
    );

    // 2. Query LibreLogin
    const [loginRows] = await dbPool.query(
      `SELECT uuid, username 
       FROM librelogin_users 
       WHERE LOWER(username) IN (${placeholders.toLowerCase()})
       LIMIT 1`,
      possibleUsernames.map(u => u.toLowerCase())
    );

    const detectedRank = (rankRows.length > 0 && rankRows[0].primary_group) 
      ? rankRows[0].primary_group.toUpperCase() 
      : 'DEFAULT';

    const matchedUsername = rankRows.length > 0 ? rankRows[0].username : (loginRows.length > 0 ? loginRows[0].username : rawUsername);
    const isRegistered = loginRows.length > 0 || rankRows.length > 0;
    const currentRankPrice = DEFAULT_RANK_PRICES[detectedRank] || 0;

    return res.json({
      success: true,
      player: {
        username: matchedUsername,
        platform: isBedrock ? 'Bedrock' : 'Java',
        rank: detectedRank,
        rankPrice: currentRankPrice,
        isRegistered: isRegistered,
        headAvatarUrl: headAvatarUrl
      }
    });

  } catch (error) {
    console.warn('[DB NOTICE]: Database MySQL offline/tidak terjangkau. Menggunakan fallback rank.');
    
    return res.json({
      success: true,
      fallback: true,
      player: {
        username: rawUsername,
        platform: isBedrock ? 'Bedrock' : 'Java',
        rank: 'DEFAULT',
        rankPrice: 0,
        isRegistered: false,
        headAvatarUrl: headAvatarUrl
      }
    });
  }
});

// Endpoint Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', server: 'Mawi SMP Express API Running' });
});

// Fallback Route: Mengarahkan semua halaman non-API ke index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Mawi SMP Server aktif di http://localhost:${PORT}`);
});
