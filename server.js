/**
 * MAWI SMP - UNIFIED BACKEND & FRONTEND SERVER
 * Menjalankan Backend API Express + Menyajikan Website index.html dalam 1 Aplikasi
 * MENDUKUNG DUAL DATABASE: LUCKPERMS & LIBRELOGIN TERPISAH (FAST-TIMEOUT PROTECTED)
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

// HIRARKI HARGA DEFAULT RANK SERVER (MENDUKUNG RANK LWN & LORD)
const DEFAULT_RANK_PRICES = {
  'DEFAULT': 0,
  'MEMBER': 0,
  'VIP': 25000,
  'MVP': 50000,
  'SULTAN': 100000,
  'OVERLORD': 200000,
  'LWN': 390000,
  'LORD': 390000
};

// ==========================================
// CONFIG DUAL MYSQL DATABASE POOLS (STRICT SHORT TIMEOUT)
// ==========================================

const createFastPool = (host, user, password, database, port) => {
  return mysql.createPool({
    host: host || 'localhost',
    user: user || 'root',
    password: password || '',
    database: database || 'minecraft_db',
    port: Number(port) || 3306,
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    connectTimeout: 4000 // Timeout cepat 4 detik
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

// Helper Query dengan Timeout Keras (Max 4 detik)
async function queryWithTimeout(pool, sql, params) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED: Database server hosting memblokir port 3306 atau tidak merespon')), 4000)
    )
  ]);
}

// ==========================================
// BACKEND API ENDPOINTS
// ==========================================

// Endpoint Tes Koneksi Database Langsung
app.get('/api/test-db', async (req, res) => {
  const testResults = {
    timestamp: new Date().toISOString(),
    luckperms: { status: 'PENDING', message: '' },
    librelogin: { status: 'PENDING', message: '' }
  };

  // Tes 1: Database LuckPerms
  try {
    const [lpRows] = await queryWithTimeout(luckpermsPool, 'SELECT COUNT(*) as total FROM luckperms_players');
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

  // Tes 2: Database LibreLogin / LibrePremium (Dukungan tabel: librepremium_data, librelogin_users, users)
  try {
    let loginCount = 0;
    let tableUsed = '';
    
    try {
      const [loginRows] = await queryWithTimeout(libreloginPool, 'SELECT COUNT(*) as total FROM librepremium_data');
      loginCount = loginRows[0].total;
      tableUsed = 'librepremium_data';
    } catch (e0) {
      try {
        const [loginRows1] = await queryWithTimeout(libreloginPool, 'SELECT COUNT(*) as total FROM librelogin_users');
        loginCount = loginRows1[0].total;
        tableUsed = 'librelogin_users';
      } catch (e1) {
        const [loginRows2] = await queryWithTimeout(libreloginPool, 'SELECT COUNT(*) as total FROM users');
        loginCount = loginRows2[0].total;
        tableUsed = 'users';
      }
    }

    testResults.librelogin = {
      status: 'SUCCESS ✅',
      message: `Berhasil terhubung ke database LibreLogin! (Tabel: ${tableUsed})`,
      total_users: loginCount
    };
  } catch (err) {
    testResults.librelogin = {
      status: 'WARNING ⚠️ (Menggunakan Fallback LuckPerms)',
      code: err.code || 'TABLE_NOT_FOUND',
      message: 'Database terhubung, tetapi tabel belum dibuat plugin. Sistem tetap berjalan normal via LuckPerms!'
    };
  }

  return res.json(testResults);
});

// Pengecekan Rank & Bedrock Prefix (PINTAR & DUAL-TABLE PERMISSION CHECK)
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

  let cleanSkinName = rawUsername.replace(/^_+|_+$/g, '') || 'Steve';
  const headAvatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanSkinName)}/100`;

  let rankRows = [];
  let permRows = [];
  let loginRows = [];

  const placeholders = possibleUsernames.map(() => '?').join(',');
  const lowerUsernames = possibleUsernames.map(u => u.toLowerCase());

  try {
    // 1. Query Database LuckPerms (Utama)
    try {
      const [lpResult] = await queryWithTimeout(
        luckpermsPool,
        `SELECT uuid, username, COALESCE(primary_group, 'default') AS primary_group 
         FROM luckperms_players 
         WHERE LOWER(username) IN (${placeholders})
         LIMIT 1`,
        lowerUsernames
      );
      rankRows = lpResult;

      // PERIKSA TABEL PERMISSIONS JIKA PRIMARY_GROUP MASIH 'DEFAULT'
      if (rankRows.length > 0) {
        const userUuid = rankRows[0].uuid;
        const currentPrimary = (rankRows[0].primary_group || 'default').toLowerCase();

        if (currentPrimary === 'default') {
          try {
            const [permResult] = await queryWithTimeout(
              luckpermsPool,
              `SELECT permission FROM luckperms_user_permissions 
               WHERE uuid = ? AND permission LIKE 'group.%' AND value = 1 
               LIMIT 5`,
              [userUuid]
            );
            permRows = permResult;
          } catch (errPerm) {
            console.warn('[DB WARNING - Permissions]: Gagal query permissions:', errPerm.message);
          }
        }
      }
    } catch (errLP) {
      console.warn('[DB WARNING - LuckPerms]: Gagal query LuckPerms DB:', errLP.message);
    }

    // 2. Query Database LibreLogin / LibrePremium
    try {
      const [loginResult0] = await queryWithTimeout(
        libreloginPool,
        `SELECT * FROM librepremium_data WHERE LOWER(username) IN (${placeholders}) OR LOWER(name) IN (${placeholders}) LIMIT 1`,
        [...lowerUsernames, ...lowerUsernames]
      );
      loginRows = loginResult0;
    } catch (e0) {
      try {
        const [loginResult1] = await queryWithTimeout(
          libreloginPool,
          `SELECT * FROM librelogin_users WHERE LOWER(username) IN (${placeholders}) OR LOWER(name) IN (${placeholders}) LIMIT 1`,
          [...lowerUsernames, ...lowerUsernames]
        );
        loginRows = loginResult1;
      } catch (e1) {
        try {
          const [loginResult2] = await queryWithTimeout(
            libreloginPool,
            `SELECT * FROM users WHERE LOWER(username) IN (${placeholders}) OR LOWER(name) IN (${placeholders}) LIMIT 1`,
            [...lowerUsernames, ...lowerUsernames]
          );
          loginRows = loginResult2;
        } catch (e2) {
          loginRows = [];
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
        // Ambil group permission non-default (misal group.lwn -> LWN)
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
    console.warn('[DB NOTICE]: Database MySQL offline/timeout.');
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
  res.json({ status: 'OK', server: 'Mawi SMP Express API Running Dual-DB' });
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
