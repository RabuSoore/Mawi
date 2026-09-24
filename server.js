/**
 * MAWI SMP - UNIFIED BACKEND & FRONTEND SERVER (HIGH PERFORMANCE & OPTIMIZED)
 * Menjalankan Backend API Express + Menyajikan Website index.html
 * MENDUKUNG DUAL DATABASE: LUCKPERMS & LIBRELOGIN (PARALLEL & MEMORY CACHED)
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

// Menyajikan File Statis (index.html, gambar, CSS) dari root folder
app.use(express.static(__dirname));

// ==========================================
// IN-MEMORY CACHE SYSTEM (RAM SPEED < 1 ms)
// ==========================================
const rankCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // Cache berlaku 5 Menit

// Variabel memori untuk mengingat nama tabel login yang aktif (Mencegah sequential fallback delay)
let cachedLoginTableName = null;

// HIRARKI & HARGA RANK SERVER
const DEFAULT_RANK_PRICES = {
  'DEFAULT': 0,
  'MEMBER': 0,
  'NIKE': 25000,
  'VIP': 25000,
  'MVP': 50000,
  'SULTAN': 100000,
  'OVERLORD': 200000,
  'LWN': 390000,
  'LORD': 390000,
  'MAWI': 400000
};

// ==========================================
// CONFIG DUAL MYSQL DATABASE POOLS
// ==========================================

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
    connectTimeout: 2000 // Timeout diturunkan ke 2 detik untuk fast failover
  });
};

// Pool 1: LuckPerms
const luckpermsPool = createFastPool(
  process.env.LP_DB_HOST || process.env.DB_HOST,
  process.env.LP_DB_USER || process.env.DB_USER,
  process.env.LP_DB_PASS || process.env.DB_PASSWORD,
  process.env.LP_DB_NAME || process.env.DB_NAME_LUCKPERMS || process.env.DB_NAME,
  process.env.LP_DB_PORT || process.env.DB_PORT
);

// Pool 2: LibreLogin / LibrePremium
const libreloginPool = createFastPool(
  process.env.LOGIN_DB_HOST || process.env.DB_HOST,
  process.env.LOGIN_DB_USER || process.env.DB_USER,
  process.env.LOGIN_DB_PASS || process.env.DB_PASSWORD,
  process.env.LOGIN_DB_NAME || process.env.DB_NAME_LIBRELOGIN || process.env.DB_NAME,
  process.env.LOGIN_DB_PORT || process.env.DB_PORT
);

// Helper Query dengan Timeout Keras (Max 2 detik)
async function queryWithTimeout(pool, sql, params, timeoutMs = 2000) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED: Connection slow or port blocked')), timeoutMs)
    )
  ]);
}

// Helper untuk menemukan tabel login secara otomatis & menyimpan hasilnya di RAM
async function detectLoginTable() {
  if (cachedLoginTableName) return cachedLoginTableName;

  const candidateTables = ['librepremium_data', 'librelogin_users', 'users'];
  for (const table of candidateTables) {
    try {
      await queryWithTimeout(libreloginPool, `SELECT 1 FROM ${table} LIMIT 1`, [], 1000);
      cachedLoginTableName = table;
      console.log(`[DB DETECT] Tabel login terdeteksi & dicache di RAM: ${table}`);
      return table;
    } catch (e) {
      // Lanjut ke kandidat berikutnya
    }
  }
  return null;
}

// ==========================================
// BACKEND API ENDPOINTS
// ==========================================

// Endpoint Tes Koneksi Database Langsung
app.get('/api/test-db', async (req, res) => {
  const testResults = {
    timestamp: new Date().toISOString(),
    luckperms: { status: 'PENDING', message: '' },
    librelogin: { status: 'PENDING', message: '' },
    cache_status: { active_entries: rankCache.size, cached_login_table: cachedLoginTableName || 'Belum terdeteksi' }
  };

  // Tes 1: Database LuckPerms
  try {
    const [lpRows] = await queryWithTimeout(luckpermsPool, 'SELECT COUNT(*) as total FROM luckperms_players', [], 2000);
    testResults.luckperms = {
      status: 'SUCCESS ✅',
      message: 'Berhasil terhubung ke database LuckPerms!',
      total_players: lpRows[0].total
    };
  } catch (err) {
    testResults.luckperms = {
      status: 'ERROR ❌',
      code: err.code || 'TIMEOUT_ERROR',
      message: err.message
    };
  }

  // Tes 2: Database LibreLogin / LibrePremium
  try {
    const activeTable = await detectLoginTable();
    if (activeTable) {
      const [loginRows] = await queryWithTimeout(libreloginPool, `SELECT COUNT(*) as total FROM ${activeTable}`, [], 2000);
      testResults.librelogin = {
        status: 'SUCCESS ✅',
        message: `Berhasil terhubung ke database LibreLogin! (Tabel: ${activeTable})`,
        total_users: loginRows[0].total
      };
    } else {
      testResults.librelogin = {
        status: 'WARNING ⚠️ (Menggunakan Fallback LuckPerms)',
        message: 'Database terhubung, tetapi tabel login tidak ditemukan. Sistem tetap berjalan normal via LuckPerms!'
      };
    }
  } catch (err) {
    testResults.librelogin = {
      status: 'ERROR ❌',
      code: err.code || 'DB_ERROR',
      message: err.message
    };
  }

  return res.json(testResults);
});

// Pengecekan Rank & Bedrock Prefix (PARALEL + RAM CACHE)
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

  let possibleUsernames = [rawUsername];
  if (isBedrock) {
    if (!rawUsername.startsWith('_')) possibleUsernames.push(`_${rawUsername}`);
    if (!rawUsername.endsWith('_')) possibleUsernames.push(`${rawUsername}_`);
  } else {
    if (rawUsername.startsWith('_')) possibleUsernames.push(rawUsername.replace(/^_/, ''));
  }

  const cacheKey = `${rawUsername.toLowerCase()}_${isBedrock ? 'bedrock' : 'java'}`;

  // 1. CEK IN-MEMORY RAM CACHE (0 ms RESPONSE TIME)
  if (rankCache.has(cacheKey)) {
    const cachedData = rankCache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_TTL) {
      console.log(`[RAM CACHE HIT ⚡] Respon instan untuk ${rawUsername}`);
      return res.json(cachedData.response);
    }
  }

  let cleanSkinName = rawUsername.replace(/^_+|_+$/g, '') || 'Steve';
  const headAvatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanSkinName)}/100`;

  const placeholders = possibleUsernames.map(() => '?').join(',');
  const lowerUsernames = possibleUsernames.map(u => u.toLowerCase());

  // 2. QUERY PARALEL KE DATABASE (Promise.allSettled)
  const lpPromise = queryWithTimeout(
    luckpermsPool,
    `SELECT uuid, username, COALESCE(primary_group, 'default') AS primary_group 
     FROM luckperms_players 
     WHERE LOWER(username) IN (${placeholders})
     LIMIT 1`,
    lowerUsernames,
    1500
  );

  const loginPromise = (async () => {
    const table = await detectLoginTable();
    if (!table) return [];
    const [rows] = await queryWithTimeout(
      libreloginPool,
      `SELECT * FROM ${table} WHERE LOWER(username) IN (${placeholders}) OR LOWER(name) IN (${placeholders}) LIMIT 1`,
      [...lowerUsernames, ...lowerUsernames],
      1500
    );
    return rows;
  })();

  const [lpResult, loginResult] = await Promise.allSettled([lpPromise, loginPromise]);

  let rankRows = (lpResult.status === 'fulfilled' && lpResult.value[0]) ? lpResult.value[0] : [];
  let loginRows = (loginResult.status === 'fulfilled' && loginResult.value) ? loginResult.value : [];
  let permRows = [];

  // PERIKSA TABEL PERMISSIONS JIKA PRIMARY_GROUP MASIH 'DEFAULT'
  if (rankRows.length > 0) {
    const userUuid = rankRows[0].uuid;
    const currentPrimary = (rankRows[0].primary_group || 'default').toLowerCase();

    if (currentPrimary === 'default') {
      try {
        const [permRes] = await queryWithTimeout(
          luckpermsPool,
          `SELECT permission FROM luckperms_user_permissions 
           WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1 
           LIMIT 5`,
          [userUuid],
          1000
        );
        permRows = permRes;
      } catch (errPerm) {
        console.warn('[DB PERMISSION WARN]:', errPerm.message);
      }
    }
  }

  // DETEKSI RANK UTAMA TERBAIK
  let detectedRank = 'DEFAULT';

  if (rankRows.length > 0) {
    const primary = (rankRows[0].primary_group || 'default').toUpperCase();
    if (primary !== 'DEFAULT') {
      detectedRank = primary;
    } else if (permRows.length > 0) {
      const customGroup = permRows.find(p => p.permission.toLowerCase() !== 'group.default');
      if (customGroup) {
        detectedRank = customGroup.permission.replace(/^group\./i, '').toUpperCase();
      }
    }
  }

  const matchedUsername = rankRows.length > 0 
    ? rankRows[0].username 
    : (loginRows.length > 0 
        ? (loginRows[0].username || loginRows[0].name || loginRows[0].player || rawUsername) 
        : rawUsername);

  const isRegistered = rankRows.length > 0 || loginRows.length > 0;
  const currentRankPrice = DEFAULT_RANK_PRICES[detectedRank] || 0;

  const resultResponse = {
    success: true,
    player: {
      username: matchedUsername,
      platform: isBedrock ? 'Bedrock' : 'Java',
      rank: detectedRank,
      rankPrice: currentRankPrice,
      isRegistered: isRegistered,
      headAvatarUrl: headAvatarUrl
    }
  };

  // 3. SIMPAN KE RAM CACHE UNTUK QUERY SELANJUTNYA
  rankCache.set(cacheKey, {
    timestamp: Date.now(),
    response: resultResponse
  });

  return res.json(resultResponse);
});

// Endpoint Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', server: 'Mawi SMP Express API Running Optimized Dual-DB with RAM Cache' });
});

// Fallback Route: Mengarahkan semua halaman non-API ke index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Mawi SMP Server aktif di http://localhost:${PORT}`);
  // Jalankan deteksi tabel di latar belakang saat startup
  detectLoginTable().catch(() => {});
});
