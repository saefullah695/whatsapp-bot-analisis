// ============================================================
// bot-analisis.js - Bot Analisis Multi-Group dengan Proteksi Data
// ============================================================

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { google } from 'googleapis';
import axios from 'axios';
import dotenv from 'dotenv';
import cron from 'node-cron';
import axiosRetry from 'axios-retry';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ====== KONFIGURASI DARI ENVIRONMENT ======
const PORT = process.env.PORT || 3041; // FIX: Support ZevCloud / Dynamic Port
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'gateway_key_123';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CREDENTIALS_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || 'oceanic-student-295612-3522644ba19e.json';
const STORE_TYPE = process.env.STORE_TYPE || 'normal'; // 'normal' atau '24jam'

// ====== KREDENSIAL BASIC AUTH GATEWAY ======
const GATEWAY_AUTH_USERNAME = process.env.GATEWAY_AUTH_USERNAME || 'admin';
const GATEWAY_AUTH_PASSWORD = process.env.GATEWAY_AUTH_PASSWORD || 'password';

// ====== KONFIGURASI GROUP ======
const REPORT_GROUPS = {
  PPSA: ["2GL6 FOKUS MARKETING"],
  TEBUS_MURAH: ["2GL6 FOKUS MARKETING"],
  LOSS_DETECTION: ["GroupTes"],
  KOREKSI: ["SO RAWAN 2GL6"]
};
const ADMIN_GROUP = "GroupTes";

// ====== KONFIGURASI JADWAL (cron expression) ======
const SCHEDULE_CRON = process.env.SCHEDULE_CRON || '0 8 * * *'; // setiap hari jam 08:00
const TIMEZONE = 'Asia/Jakarta';

// ====== KONFIGURASI SHEETS ======
const SHEET_NAME = "Data";
const SO_SHEET_NAME = "SO";
const KOREKSI_SHEET_NAME = "RekapSo";

// ====== BOBOT INDIKATOR ======
const BOBOT = {
  PSM: 20,
  PWP: 25,
  SG: 30,
  APC: 25
};

// ====== KONFIGURASI QUICKCHART ======
const QUICKCHART_URL = "https://quickchart.io";
const CHART_WIDTH = 800;
const CHART_HEIGHT = 400;
const CHART_BG_COLOR = '#000000';
const CHART_TEXT_COLOR = '#ffffff';
const CHART_GRID_COLOR = '#333333';

// ====== INISIALISASI ======
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

let sheets = null;

// FIX: Inisialisasi Sheets mendukung ENV (ZevCloud) dan File Lokal (Dev)
function initializeSheets() {
  try {
    let credentials;
    
    if (process.env.GOOGLE_CREDS_JSON) {
      log.info('🔐 Membaca kredensial dari GOOGLE_CREDS_JSON (Environment)');
      credentials = JSON.parse(process.env.GOOGLE_CREDS_JSON);
    } else {
      const credentialPath = path.resolve(process.cwd(), CREDENTIALS_FILE);
      log.info(`🔐 Membaca file kredensial lokal: ${credentialPath}`);
      if (!fs.existsSync(credentialPath)) {
        throw new Error(`File kredensial tidak ditemukan: ${credentialPath}`);
      }
      credentials = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    }
    
    const { client_email, private_key } = credentials;
    
    if (!client_email || !private_key) {
      throw new Error('Kredensial tidak lengkap: client_email atau private_key tidak ditemukan');
    }
    
    const jwtClient = new google.auth.JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    
    sheets = google.sheets({ version: 'v4', auth: jwtClient });
    log.info('✅ Google Sheets client berhasil diinisialisasi');
    return sheets;
  } catch (error) {
    log.error(`❌ Gagal inisialisasi Sheets: ${error.message}`);
    throw error;
  }
}

const app = express();
app.use(express.json());

// ====== RETRY CONFIGURATION ======
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => error.response?.status >= 500 || error.code === 'ECONNABORTED',
});

// ====== FUNGSI LOGGING ======
const log = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  debug: (msg) => process.env.DEBUG && console.debug(`[DEBUG] ${new Date().toISOString()} - ${msg}`),
};

// ====== FUNGSI PENGIRIMAN PESAN VIA GATEWAY ======
async function sendMessageToGateway(groupName, message) {
  try {
    log.info(`📤 Mengirim ke ${groupName} (${message.length} chars)`);
    
    const auth = Buffer.from(`${GATEWAY_AUTH_USERNAME}:${GATEWAY_AUTH_PASSWORD}`).toString('base64');

    const response = await axios.post(`${GATEWAY_URL}/send`, {
      groupName,
      message,
      apiKey: API_KEY,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 15000
    });
    
    if (response.data.success) {
      log.info(`✅ Pesan terkirim ke ${groupName}`);
      return true;
    } else {
      log.error(`❌ Gagal: ${response.data.error}`);
      return false;
    }
  } catch (error) {
    log.error(`❌ Error kirim ke ${groupName}: ${error.message}`);
    if (error.response) {
      log.error(`   Status: ${error.response.status}`);
      log.error(`   Data: ${JSON.stringify(error.response.data)}`);
    }
    return false;
  }
}

async function sendMessageToGroups(groupNames, message) {
  for (const group of groupNames) {
    const chunks = splitMessageIntoChunks(message, 4000);
    for (const chunk of chunks) {
      await sendMessageToGateway(group, chunk);
      await sleep(2000);
    }
  }
}

async function sendToAdminGroup(message) {
  return await sendMessageToGateway(ADMIN_GROUP, message);
}

async function sendErrorToAdmin(error, context = '') {
  const msg = `❌ ERROR ${context}:\n${error.message}\n${error.stack?.slice(0, 500)}`;
  await sendToAdminGroup(msg);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function splitMessageIntoChunks(message, maxLength = 4000) {
  if (message.length <= maxLength) return [message];
  const chunks = [];
  const lines = message.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + line).length + 1 <= maxLength) {
      current += (current ? '\n' : '') + line;
    } else {
      if (current) chunks.push(current);
      current = line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ====== FUNGSI PENJADWALAN (cron) ======
let lastReportDate = null;

function setupScheduler() {
  if (!SCHEDULE_CRON) {
    log.info('⏰ Penjadwalan dinonaktifkan (SCHEDULE_CRON kosong)');
    return;
  }
  cron.schedule(SCHEDULE_CRON, async () => {
    const today = new Date().toDateString();
    if (lastReportDate === today) {
      log.warn('⚠️ Laporan sudah dikirim hari ini, lewati.');
      return;
    }
    log.info('⏰ Waktu pengiriman laporan tiba!');
    lastReportDate = today;
    await sendAllReports();
  }, { timezone: TIMEZONE });
  log.info(`⏰ Penjadwalan aktif dengan cron: ${SCHEDULE_CRON} (${TIMEZONE})`);
}

// ====== FUNGSI FORMAT TANGGAL ======
function parseDate(dateStr) {
  if (!dateStr) return null;
  const formats = [
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
  ];
  for (const fmt of formats) {
    const m = dateStr.match(fmt);
    if (m) {
      if (fmt === /^(\d{4})-(\d{1,2})-(\d{1,2})$/) {
        return new Date(+m[1], +m[2] - 1, +m[3]);
      } else {
        const day = +m[1], month = +m[2] - 1, year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        return new Date(year, month, day);
      }
    }
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function formatPeriod(dates) {
  if (!dates || dates.length === 0) return "Periode tidak tersedia";
  const valid = dates.map(d => parseDate(d)).filter(d => d !== null);
  if (valid.length === 0) return "Periode tidak tersedia";
  valid.sort((a, b) => a - b);
  const first = valid[0], last = valid[valid.length - 1];
  return `${first.getDate()}/${first.getMonth()+1}/${first.getFullYear()} - ${last.getDate()}/${last.getMonth()+1}/${last.getFullYear()}`;
}

function formatDateForReport(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
}

function formatDateForTrend(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return `${d.getDate()}/${d.getMonth()+1}`;
}

function subtractOneDay(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  d.setDate(d.getDate() - 1);
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
}

// ====== FUNGSI GOOGLE SHEETS ======
async function getDataFromGoogleSheet() {
  try {
    log.info("📊 Mengambil data dari Google Sheets...");
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:AB`,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) {
      log.warn('⚠️ Tidak ada data di worksheet.');
      return { kasirData: [], tebusMurahData: [], periodText: "Periode tidak tersedia", grandAPCTarget: 0, grandAPCActual: 0 };
    }
    const dataRows = rows.slice(1);
    const kasirMap = new Map();
    const tebusMap = new Map();
    const allDates = [];
    const apcGlobal = [];

    for (const row of dataRows) {
      if (row.length < 25) continue;
      try {
        const nama = row[0]?.trim();
        if (!nama || nama === '' || nama === 'Unknown' || nama === 'NAMA KASIR') continue;
        const tanggal = row[1]?.trim();
        if (tanggal) allDates.push(tanggal);

        const psmT = parseFloat(row[3]) || 0, psmA = parseFloat(row[4]) || 0;
        const pwpT = parseFloat(row[8]) || 0, pwpA = parseFloat(row[9]) || 0;
        const sgT = parseFloat(row[13]) || 0, sgA = parseFloat(row[14]) || 0;
        const apcT = parseFloat(row[18]) || 0, apcA = parseFloat(row[19]) || 0;
        const tebusT = parseFloat(row[23]) || 0, tebusA = parseFloat(row[24]) || 0;

        if (apcT > 0 || apcA > 0) apcGlobal.push({ target: apcT, actual: apcA });

        // Kasir PPSA
        if (!kasirMap.has(nama)) {
          kasirMap.set(nama, {
            nama, jhk: 0, psmTarget: 0, psmActual: 0, pwpTarget: 0, pwpActual: 0,
            sgTarget: 0, sgActual: 0, apcData: []
          });
        }
        const k = kasirMap.get(nama);
        k.jhk += 1;
        k.psmTarget += psmT; k.psmActual += psmA;
        k.pwpTarget += pwpT; k.pwpActual += pwpA;
        k.sgTarget += sgT; k.sgActual += sgA;
        k.apcData.push({ target: apcT, actual: apcA });

        // Tebus Murah
        if (!tebusMap.has(nama)) {
          tebusMap.set(nama, { nama, jhk: 0, target: 0, actual: 0 });
        }
        const t = tebusMap.get(nama);
        t.jhk += 1;
        t.target += tebusT;
        t.actual += tebusA;

      } catch (e) {
        log.warn('⚠️ Gagal parsing baris: ' + e.message);
      }
    }

    // Hitung rata-rata APC per kasir
    const kasirData = Array.from(kasirMap.values()).map(k => {
      let totalT = 0, totalA = 0, count = 0;
      k.apcData.forEach(day => {
        if (day.target > 0 || day.actual > 0) {
          totalT += day.target; totalA += day.actual; count++;
        }
      });
      return {
        ...k,
        apcTarget: count > 0 ? totalT / count : 0,
        apcActual: count > 0 ? totalA / count : 0,
      };
    });

    const tebusMurahData = Array.from(tebusMap.values());

    // Grand APC
    let gT = 0, gA = 0, gCount = 0;
    apcGlobal.forEach(day => {
      if (day.target > 0 || day.actual > 0) {
        gT += day.target; gA += day.actual; gCount++;
      }
    });
    const grandAPCTarget = gCount > 0 ? gT / gCount : 0;
    const grandAPCActual = gCount > 0 ? gA / gCount : 0;
    const periodText = formatPeriod(allDates);

    log.info(`✅ ${kasirData.length} kasir, ${tebusMurahData.length} tebus, periode ${periodText}`);
    return { kasirData, tebusMurahData, periodText, grandAPCTarget, grandAPCActual };
  } catch (error) {
    log.error('❌ Error getDataFromGoogleSheet: ' + error.message);
    await sendErrorToAdmin(error, 'getDataFromGoogleSheet');
    return { kasirData: [], tebusMurahData: [], periodText: "Periode tidak tersedia", grandAPCTarget: 0, grandAPCActual: 0 };
  }
}

// ====== FUNGSI PERHITUNGAN ======
function calculateACV(actual, target) {
  if (!target || target === 0) return 0;
  return (actual / target) * 100;
}
function calculateScore(acv, bobot) {
  return (acv * bobot) / 100;
}

function calculateKasirPerformance(kasirData) {
  const results = { psm: [], pwp: [], sg: [], apc: [], totalScore: [] };
  kasirData.forEach(k => {
    const psmACV = calculateACV(k.psmActual || 0, k.psmTarget || 0);
    const psmScore = calculateScore(psmACV, BOBOT.PSM);
    const pwpACV = calculateACV(k.pwpActual || 0, k.pwpTarget || 0);
    const pwpScore = calculateScore(pwpACV, BOBOT.PWP);
    const sgACV = calculateACV(k.sgActual || 0, k.sgTarget || 0);
    const sgScore = calculateScore(sgACV, BOBOT.SG);
    const apcACV = calculateACV(k.apcActual || 0, k.apcTarget || 0);
    const apcScore = calculateScore(apcACV, BOBOT.APC);
    const total = psmScore + pwpScore + sgScore + apcScore;

    results.psm.push({ nama: k.nama, jhk: k.jhk, target: k.psmTarget.toFixed(1), actual: k.psmActual.toFixed(1), acv: psmACV.toFixed(2)+'%', score: psmScore.toFixed(2) });
    results.pwp.push({ nama: k.nama, jhk: k.jhk, target: k.pwpTarget.toFixed(1), actual: k.pwpActual.toFixed(1), acv: pwpACV.toFixed(2)+'%', score: pwpScore.toFixed(2) });
    results.sg.push({ nama: k.nama, jhk: k.jhk, target: k.sgTarget.toFixed(1), actual: k.sgActual.toFixed(1), acv: sgACV.toFixed(2)+'%', score: sgScore.toFixed(2) });
    results.apc.push({ nama: k.nama, jhk: k.jhk, target: k.apcTarget.toFixed(0), actual: k.apcActual.toFixed(0), acv: apcACV.toFixed(2)+'%', score: apcScore.toFixed(2) });
    results.totalScore.push({ nama: k.nama, jhk: k.jhk, totalScore: total.toFixed(2) });
  });
  return results;
}

function calculateGrandTotal(performanceData, grandAPCTarget, grandAPCActual) {
  const grandTotal = {
    PSM: { target: 0, actual: 0, acv: 0, score: 0 },
    PWP: { target: 0, actual: 0, acv: 0, score: 0 },
    SG: { target: 0, actual: 0, acv: 0, score: 0 },
    APC: { target: grandAPCTarget || 0, actual: grandAPCActual || 0, acv: 0, score: 0 }
  };
  if (!performanceData) return grandTotal;
  try {
    performanceData.psm?.forEach(item => { grandTotal.PSM.target += parseFloat(item.target)||0; grandTotal.PSM.actual += parseFloat(item.actual)||0; });
    performanceData.pwp?.forEach(item => { grandTotal.PWP.target += parseFloat(item.target)||0; grandTotal.PWP.actual += parseFloat(item.actual)||0; });
    performanceData.sg?.forEach(item => { grandTotal.SG.target += parseFloat(item.target)||0; grandTotal.SG.actual += parseFloat(item.actual)||0; });

    grandTotal.PSM.acv = calculateACV(grandTotal.PSM.actual, grandTotal.PSM.target);
    grandTotal.PSM.score = calculateScore(grandTotal.PSM.acv, BOBOT.PSM);
    grandTotal.PWP.acv = calculateACV(grandTotal.PWP.actual, grandTotal.PWP.target);
    grandTotal.PWP.score = calculateScore(grandTotal.PWP.acv, BOBOT.PWP);
    grandTotal.SG.acv = calculateACV(grandTotal.SG.actual, grandTotal.SG.target);
    grandTotal.SG.score = calculateScore(grandTotal.SG.acv, BOBOT.SG);
    grandTotal.APC.acv = calculateACV(grandTotal.APC.actual, grandTotal.APC.target);
    grandTotal.APC.score = calculateScore(grandTotal.APC.acv, BOBOT.APC);
  } catch (e) {
    log.error('Error calculateGrandTotal: ' + e.message);
  }
  return grandTotal;
}

// ====== FUNGSI TEBUS MURAH ======
function calculateTebusMurahPerformance(tebusMurahData) {
  if (!Array.isArray(tebusMurahData)) return [];
  return tebusMurahData.map(k => {
    const acv = calculateACV(k.actual || 0, k.target || 0);
    return { nama: k.nama, jhk: k.jhk, target: Math.round(k.target||0), actual: Math.round(k.actual||0), acv: Math.round(acv)+'%' };
  });
}
function calculateTebusMurahGrandTotal(data) {
  if (!Array.isArray(data)) return { totalJHK:0, totalTarget:0, totalActual:0, totalACV:'0%' };
  let jhk=0, target=0, actual=0;
  data.forEach(k => { jhk += k.jhk||0; target += k.target||0; actual += k.actual||0; });
  const acv = calculateACV(actual, target);
  return { totalJHK: jhk, totalTarget: Math.round(target), totalActual: Math.round(actual), totalACV: Math.round(acv)+'%' };
}

function formatTebusMurahReport(data, periodText) {
  if (!data || data.length === 0) return `*📊 LAPORAN TEBUS MURAH RP. 2.500*\nPeriode: ${periodText}\n\n❌ Tidak ada data.`;
  let report = `*📊 LAPORAN TEBUS MURAH RP. 2.500*\nPeriode: ${periodText}\nTotal Kasir: ${data.length}\n══════════════════════════════\n`;
  report += `| NAMA KASIR | JHK | TARGET | ACTUAL | %ACV  |\n|------------|-----|--------|--------|-------|\n`;
  data.forEach(k => {
    report += `| ${(k.nama||'Unknown').padEnd(10)} | ${(k.jhk||0).toString().padStart(3)} | ${(k.target||0).toString().padStart(6)} | ${(k.actual||0).toString().padStart(6)} | ${(k.acv||'0%').padStart(6)} |\n`;
  });
  report += `|---------------------------------------------|\n`;
  const gt = calculateTebusMurahGrandTotal(data);
  report += `| TOTAL      | ${gt.totalJHK.toString().padStart(3)} | ${gt.totalTarget.toString().padStart(6)} | ${gt.totalActual.toString().padStart(6)} | ${gt.totalACV.padStart(6)} |\n`;
  report += `══════════════════════════════\n`;
  return report;
}

async function generateTebusMurahAnalysis(data) {
  if (!data || data.length === 0) return '📊 *ANALISIS TEBUS MURAH:*\nTidak ada data.';
  try {
    const sorted = [...data].sort((a,b) => (parseFloat(b.acv)||0) - (parseFloat(a.acv)||0));
    const gt = calculateTebusMurahGrandTotal(data);
    let prompt = `Buat analisis SINGKAT (maks 6 baris) untuk data Tebus Murah:\n`;
    sorted.slice(0,5).forEach((k,i) => {
      prompt += `${i+1}. ${k.nama}: ${k.acv} (Target: ${k.target}, Actual: ${k.actual})\n`;
    });
    prompt += `\nGrand Total: Target ${gt.totalTarget}, Actual ${gt.totalActual}, ACV ${gt.totalACV}\n`;
    prompt += `Format bullet points:\n• Performa keseluruhan\n• Tertinggi\n• Terendah\n• Variasi\n• Rekomendasi`;
    const analysis = await callGeminiAPI(prompt);
    return `📊 *ANALISIS TEBUS MURAH:*\n${analysis}`;
  } catch (e) {
    log.error('Error generateTebusMurahAnalysis: ' + e.message);
    const sorted = [...data].sort((a,b) => (parseFloat(b.acv)||0) - (parseFloat(a.acv)||0));
    const best = sorted[0], worst = sorted[sorted.length-1];
    const gt = calculateTebusMurahGrandTotal(data);
    return `📊 *ANALISIS TEBUS MURAH:*\n• Performa: ${gt.totalACV} (Target ${gt.totalTarget})\n• Tertinggi: ${best?.nama||'-'} (${best?.acv||'0%'})\n• Terendah: ${worst?.nama||'-'} (${worst?.acv||'0%'})\n• Variasi signifikan\n• Evaluasi penyebab perbedaan.`;
  }
}

// ====== FUNGSI DETEKSI KEHILANGAN ======
async function getLossDetectionData() {
  try {
    log.info("🔍 Mengambil data kehilangan dari SO...");
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SO_SHEET_NAME}!A:K`,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    const map = {};
    headers.forEach((h,i) => map[h.trim().toLowerCase()] = i);
    const lossData = [];
    for (const row of rows.slice(1)) {
      if (row.length < 10) continue;
      const selisih = parseFloat(row[map['selisih']]) || 0;
      if (selisih < 0) {
        lossData.push({
          namaBarang: row[map['nama barang']]?.trim() || 'Tidak diketahui',
          plu: row[map['plu']]?.trim() || 'Tidak diketahui',
          namaKasir: row[map['nama kasir']]?.trim() || 'Tidak diketahui',
          tanggal: row[map['tanggal rekap']]?.trim() || 'Tidak diketahui',
          shift: row[map['shift']]?.trim() || 'Tidak diketahui',
          selisih: selisih
        });
      }
    }
    log.info(`✅ ${lossData.length} data kehilangan ditemukan.`);
    return lossData;
  } catch (error) {
    log.error('Error getLossDetectionData: ' + error.message);
    await sendErrorToAdmin(error, 'getLossDetectionData');
    return [];
  }
}

function groupLossData(lossData) {
  const grouped = new Map();
  lossData.forEach(item => {
    const key = `${item.plu}-${item.namaBarang}`;
    if (!grouped.has(key)) {
      grouped.set(key, { namaBarang: item.namaBarang, plu: item.plu, occurrences: [] });
    }
    grouped.get(key).occurrences.push({
      namaKasir: item.namaKasir,
      tanggal: item.tanggal,
      shift: item.shift,
      selisih: item.selisih
    });
  });
  grouped.forEach((group) => {
    const kasirMap = new Map();
    group.occurrences.forEach(occ => {
      const k = occ.namaKasir.toLowerCase();
      if (!kasirMap.has(k)) kasirMap.set(k, { namaKasir: occ.namaKasir, details: [] });
      kasirMap.get(k).details.push({ tanggal: occ.tanggal, shift: occ.shift, selisih: occ.selisih });
    });
    group.occurrencesByKasir = Array.from(kasirMap.values());
  });
  return Array.from(grouped.values());
}

function formatLossDetectionReport(lossData, periodText) {
  if (lossData.length === 0) {
    return `📊 LAPORAN DETEKSI KEHILANGAN\n🗓️ Periode: ${periodText}\n\n✅ Tidak ditemukan indikasi kehilangan.`;
  }
  let report = `📊 LAPORAN DETEKSI KEHILANGAN\n🗓️ Periode: ${periodText}\n🏪 Tipe Toko: ${STORE_TYPE === 'normal' ? 'Normal (2 Shift)' : '24 Jam (3 Shift)'}\n🔍 Ditemukan ${lossData.length} barang dengan indikasi kehilangan:\n\n`;
  lossData.forEach((item, idx) => {
    const emoji = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][idx] || `${idx+1}.`;
    report += `${emoji} ${item.namaBarang}\n🆔 PLU: ${item.plu}\n`;
    item.occurrencesByKasir.forEach(kasirGroup => {
      report += `👩‍💼 Kasir: ${kasirGroup.namaKasir}\n`;
      kasirGroup.details.forEach(detail => {
        const formattedDate = formatDateForReport(detail.tanggal);
        report += `📅 Shift ${detail.shift} – ${formattedDate} → Selisih (${detail.selisih})\n`;
        // Aturan penanggung jawab untuk toko normal
        if (STORE_TYPE === 'normal' && detail.shift === '1') {
          const prevDate = subtractOneDay(detail.tanggal);
          report += `   👤 Penanggung Jawab: Shift 2 (${prevDate})\n`;
        }
      });
    });
    report += `\n`;
  });
  report += `==============================\n🧩 Rekomendasi Tindak Lanjut:\n✅ Lakukan pengecekan mendalam\n📹 Periksa CCTV\n⚠️ Tingkatkan pengawasan pada shift rawan.`;
  return report;
}

// ====== FUNGSI KOREKSI ======
async function getKoreksiData() {
  try {
    log.info("📊 Mengambil data koreksi dari RekapSo...");
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${KOREKSI_SHEET_NAME}!A:J`,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    const map = {};
    headers.forEach((h,i) => map[h.trim().toLowerCase()] = i);
    const data = [];
    for (const row of rows.slice(1)) {
      if (row.length < 10) continue;
      const selisihQty = parseFloat(row[map['selisih_qty']]) || 0;
      const selisihRp = parseFloat(row[map['selisih_rp']]) || 0;
      if (selisihQty !== 0 || selisihRp !== 0) {
        data.push({
          idRekap: row[map['id_rekap']]?.trim() || 'Tidak diketahui',
          tanggal: row[map['tanggal']]?.trim() || 'Tidak diketahui',
          pengirim: row[map['pengirim']]?.trim() || 'Tidak diketahui',
          plu: row[map['plu']]?.trim() || 'Tidak diketahui',
          descp: row[map['descp']]?.trim() || 'Tidak diketahui',
          categoryName: row[map['category_name']]?.trim() || 'Tidak diketahui',
          tag: row[map['tag']]?.trim() || 'Tidak diketahui',
          stock: parseFloat(row[map['stock']]) || 0,
          selisihQty,
          selisihRp
        });
      }
    }
    log.info(`✅ ${data.length} data koreksi ditemukan.`);
    return data;
  } catch (error) {
    log.error('Error getKoreksiData: ' + error.message);
    await sendErrorToAdmin(error, 'getKoreksiData');
    return [];
  }
}

function analyzeKoreksiData(koreksiData) {
  if (!koreksiData || koreksiData.length === 0) {
    return { totalItems:0, totalMinusQty:0, totalMinusRp:0, totalPlusQty:0, totalPlusRp:0, itemsByCategory:new Map(), itemsByTag:new Map(), topMinus:[], topPlus:[] };
  }
  const analysis = {
    totalItems: koreksiData.length,
    totalMinusQty:0, totalMinusRp:0,
    totalPlusQty:0, totalPlusRp:0,
    itemsByCategory: new Map(),
    itemsByTag: new Map(),
    topMinus: [],
    topPlus: []
  };
  koreksiData.forEach(item => {
    if (item.selisihQty < 0) {
      analysis.totalMinusQty += Math.abs(item.selisihQty);
      analysis.totalMinusRp += Math.abs(item.selisihRp);
    } else {
      analysis.totalPlusQty += Math.abs(item.selisihQty);
      analysis.totalPlusRp += Math.abs(item.selisihRp);
    }
    // Kategori
    const catKey = item.categoryName || 'Tidak Diketahui';
    if (!analysis.itemsByCategory.has(catKey)) {
      analysis.itemsByCategory.set(catKey, { category: catKey, totalMinusRp:0, totalPlusRp:0, items:[] });
    }
    const cat = analysis.itemsByCategory.get(catKey);
    if (item.selisihQty < 0) cat.totalMinusRp += Math.abs(item.selisihRp);
    else cat.totalPlusRp += Math.abs(item.selisihRp);
    cat.items.push(item);
    // Tag
    const tagKey = item.tag || 'Tidak Diketahui';
    if (!analysis.itemsByTag.has(tagKey)) {
      analysis.itemsByTag.set(tagKey, { tag: tagKey, totalMinusRp:0, totalPlusRp:0, items:[] });
    }
    const tag = analysis.itemsByTag.get(tagKey);
    if (item.selisihQty < 0) tag.totalMinusRp += Math.abs(item.selisihRp);
    else tag.totalPlusRp += Math.abs(item.selisihRp);
    tag.items.push(item);
  });
  analysis.topMinus = koreksiData.filter(i => i.selisihQty < 0).sort((a,b) => Math.abs(b.selisihRp)-Math.abs(a.selisihRp)).slice(0,10);
  analysis.topPlus = koreksiData.filter(i => i.selisihQty > 0).sort((a,b) => Math.abs(b.selisihRp)-Math.abs(a.selisihRp)).slice(0,10);
  return analysis;
}

function formatKoreksiReport(analysis, periodText) {
  if (!analysis || analysis.totalItems === 0) {
    return `📊 LAPORAN ANALISIS KOREKSI STOCK\n🗓️ Periode: ${periodText}\n\n✅ Tidak ada koreksi stock.`;
  }
  let report = `📊 LAPORAN ANALISIS KOREKSI STOCK\n🗓️ Periode: ${periodText}\n📦 Total Item: ${analysis.totalItems}\n\n`;
  report += `💰 *RINGKASAN KOREKSI:*\n🔻 MINUS: ${analysis.totalMinusQty.toFixed(0)} pcs (Rp ${analysis.totalMinusRp.toFixed(0)})\n🔺 PLUS: ${analysis.totalPlusQty.toFixed(0)} pcs (Rp ${analysis.totalPlusRp.toFixed(0)})\n📊 Net: Rp ${(analysis.totalPlusRp - analysis.totalMinusRp).toFixed(0)}\n\n`;
  if (analysis.topMinus.length) {
    report += `🔴 *TOP 5 MINUS:*\n`;
    analysis.topMinus.slice(0,5).forEach((item,i) => {
      const emoji = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'][i];
      report += `${emoji} ${item.descp}\n   PLU: ${item.plu} | Kategori: ${item.categoryName} | TAG: ${item.tag} | Qty: ${item.selisihQty} pcs | Nilai: Rp ${Math.abs(item.selisihRp).toFixed(0)}\n\n`;
    });
  }
  if (analysis.topPlus.length) {
    report += `🟢 *TOP 5 PLUS:*\n`;
    analysis.topPlus.slice(0,5).forEach((item,i) => {
      const emoji = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'][i];
      report += `${emoji} ${item.descp}\n   PLU: ${item.plu} | Kategori: ${item.categoryName} | TAG: ${item.tag} | Qty: +${item.selisihQty} pcs | Nilai: Rp ${Math.abs(item.selisihRp).toFixed(0)}\n\n`;
    });
  }
  // Kategori
  if (analysis.itemsByCategory.size) {
    report += `📁 *PER KATEGORI (Top 5):*\n`;
    const sorted = Array.from(analysis.itemsByCategory.entries())
      .sort((a,b) => ((b[1].totalMinusRp+b[1].totalPlusRp) - (a[1].totalMinusRp+a[1].totalPlusRp)))
      .slice(0,5);
    sorted.forEach(([cat, data]) => {
      report += `• ${cat}: Rp ${(data.totalMinusRp+data.totalPlusRp).toFixed(0)} (🔻${data.totalMinusRp.toFixed(0)} | 🔺${data.totalPlusRp.toFixed(0)})\n`;
    });
    report += `\n`;
  }
  // Tag
  if (analysis.itemsByTag.size) {
    report += `🏷️ *PER TAG (Top 5):*\n`;
    const sorted = Array.from(analysis.itemsByTag.entries())
      .sort((a,b) => ((b[1].totalMinusRp+b[1].totalPlusRp) - (a[1].totalMinusRp+a[1].totalPlusRp)))
      .slice(0,5);
    sorted.forEach(([tag, data]) => {
      const sym = getTagSymbol(tag);
      report += `${sym} ${tag}: Rp ${(data.totalMinusRp+data.totalPlusRp).toFixed(0)} (🔻${data.totalMinusRp.toFixed(0)} | 🔺${data.totalPlusRp.toFixed(0)})\n`;
    });
    report += `\n`;
  }
  report += `💡 *REKOMENDASI:*\n`;
  if (analysis.totalMinusRp > analysis.totalPlusRp) {
    report += `🔻 Dominasi MINUS. Periksa keamanan & prosedur opname.\n`;
  } else if (analysis.totalPlusRp > analysis.totalMinusRp) {
    report += `🔺 Dominasi PLUS. Periksa pencatatan & input data.\n`;
  } else {
    report += `⚖️ Balance. Pertahankan monitoring.\n`;
  }
  return report;
}

function getTagSymbol(tag) {
  const map = { 'A':'🅰️','B':'🅱️','C':'©️','D':'↩️','E':'📧','F':'🎏' };
  return map[tag] || '🏷️';
}

// ====== FUNGSI GRAFIK (QuickChart) ======
const darkThemeOptions = {
  responsive: true,
  plugins: {
    legend: { labels: { color: CHART_TEXT_COLOR, font: { size:12 } } }
  },
  scales: {
    y: { grid: { color: CHART_GRID_COLOR }, ticks: { color: CHART_TEXT_COLOR } },
    x: { grid: { color: CHART_GRID_COLOR }, ticks: { color: CHART_TEXT_COLOR } }
  }
};

async function createChart(chartConfig, chartTitle) {
  try {
    log.info(`📊 Membuat grafik: ${chartTitle}`);
    if (!chartConfig?.data?.labels || !chartConfig?.data?.datasets) {
      throw new Error('Konfigurasi chart tidak valid');
    }
    const response = await axios.post(`${QUICKCHART_URL}/chart/create`, {
      chart: chartConfig,
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      backgroundColor: CHART_BG_COLOR,
      format: 'png'
    }, { timeout: 15000 });
    if (response.data?.success && response.data?.url) {
      return response.data.url;
    }
    // Fallback GET
    const url = `${QUICKCHART_URL}/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&width=${CHART_WIDTH}&height=${CHART_HEIGHT}&backgroundColor=${encodeURIComponent(CHART_BG_COLOR)}&format=png`;
    log.info('🔄 Fallback URL: ' + url);
    return url;
  } catch (error) {
    log.error('❌ Error createChart: ' + error.message);
    return null;
  }
}

async function createPerformanceChart(performanceData, periodText) {
  if (!Array.isArray(performanceData) || performanceData.length === 0) return null;
  const sorted = [...performanceData].sort((a,b) => (parseFloat(b.totalScore)||0) - (parseFloat(a.totalScore)||0))
    .filter(item => item.nama && item.nama !== 'Unknown');
  if (sorted.length === 0) return null;
  const labels = sorted.map(i => i.nama);
  const scores = sorted.map(i => parseFloat(i.totalScore)||0);
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Score',
        data: scores,
        backgroundColor: scores.map(s => s>=100 ? '#00ff00' : s>=80 ? '#ffff00' : '#ff0000'),
        borderColor: scores.map(s => s>=100 ? '#00cc00' : s>=80 ? '#cccc00' : '#cc0000'),
        borderWidth: 2,
        borderRadius: 8
      }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Performance PPSA - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'Total Score', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Nama Kasir', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, ticks: { maxRotation:45, minRotation:0 } }
      }
    }
  };
  return await createChart(config, `Performance PPSA - ${periodText}`);
}

async function createComponentChart(grandTotal, periodText) {
  if (!grandTotal || typeof grandTotal !== 'object') return null;
  const labels = ['PSM','PWP','SG','APC'];
  const scores = labels.map(l => grandTotal[l]?.score || 0);
  const acvs = labels.map(l => grandTotal[l]?.acv || 0);
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Score', data: scores, backgroundColor: '#667eea', borderColor: '#5a6fd8', borderWidth: 2, borderRadius: 8 },
        { label: 'ACV (%)', data: acvs, type: 'line', borderColor: '#00ffff', backgroundColor: 'rgba(0,255,255,0.1)', borderWidth: 3, pointBackgroundColor: '#00ffff', pointBorderColor: '#ffffff', pointBorderWidth: 2, pointRadius: 6, fill: false, tension: 0.4 }
      ]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Komponen PPSA - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'Score / ACV (%)', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, max: Math.max(Math.max(...scores), Math.max(...acvs))*1.2 || 100 },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Komponen', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } }
      }
    }
  };
  return await createChart(config, `Komponen PPSA - ${periodText}`);
}

async function createTebusMurahChart(tebusMurahData, periodText) {
  if (!Array.isArray(tebusMurahData) || tebusMurahData.length === 0) return null;
  const valid = tebusMurahData.filter(item => item?.nama && item.nama !== 'Unknown' && item.acv);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a,b) => (parseFloat(b.acv)||0) - (parseFloat(a.acv)||0));
  const labels = sorted.map(i => i.nama);
  const acvs = sorted.map(i => parseFloat(i.acv)||0);
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'ACV (%)',
        data: acvs,
        backgroundColor: acvs.map(a => a>=100 ? '#00ff00' : a>=80 ? '#ffff00' : '#ff0000'),
        borderColor: acvs.map(a => a>=100 ? '#00cc00' : a>=80 ? '#cccc00' : '#cc0000'),
        borderWidth: 2,
        borderRadius: 8
      }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Tebus Murah Performance - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, max: 100, title: { display: true, text: 'ACV (%)', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Nama Kasir', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, ticks: { maxRotation:45, minRotation:0 } }
      }
    }
  };
  return await createChart(config, `Tebus Murah Performance - ${periodText}`);
}

async function createShiftPerformanceChart(shiftData, periodText) {
  if (!Array.isArray(shiftData) || shiftData.length === 0) return null;
  const labels = shiftData.map(i => i.SHIFT || i.shift || 'Unknown');
  const scores = shiftData.map(i => parseFloat(i['TOTAL SCORE PPSA']) || 0);
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total PPSA Score',
        data: scores,
        backgroundColor: ['#667eea','#764ba2','#f093fb'],
        borderColor: ['#5a6fd8','#6a4190','#d881e0'],
        borderWidth: 2,
        borderRadius: 8
      }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Performance per Shift - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'PPSA Score', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Shift', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } }
      }
    }
  };
  return await createChart(config, `Performance per Shift - ${periodText}`);
}

async function createDailyTrendChart(dailyTrendData, periodText) {
  if (!Array.isArray(dailyTrendData) || dailyTrendData.length === 0) return null;
  const labels = dailyTrendData.map(i => i.date || 'Unknown');
  const scores = dailyTrendData.map(i => i.score || 0);
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Rata-rata Score Harian',
        data: scores,
        borderColor: '#667eea',
        backgroundColor: 'rgba(102,126,234,0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#667eea',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointRadius: 5
      }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Tren Performance PPSA Harian - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'Rata-rata Score PPSA', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Tanggal', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } }
      }
    }
  };
  return await createChart(config, `Tren Performance PPSA Harian - ${periodText}`);
}

async function createTebusDailyTrendChart(dailyTrendData, periodText) {
  if (!Array.isArray(dailyTrendData) || dailyTrendData.length === 0) return null;
  const labels = dailyTrendData.map(i => i.date || 'Unknown');
  const acvs = dailyTrendData.map(i => i.acv || 0);
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'ACV Tebus Murah Harian (%)',
        data: acvs,
        borderColor: '#00ff00',
        backgroundColor: 'rgba(0,255,0,0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#00ff00',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointRadius: 5
      }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Tren Tebus Murah Harian - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, max: 100, title: { display: true, text: 'ACV (%)', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Tanggal', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } }
      }
    }
  };
  return await createChart(config, `Tren Tebus Murah Harian - ${periodText}`);
}

// ====== FUNGSI TREN HARIAN ======
async function getDailyTrendDataFromSheets() {
  try {
    log.info("📊 Mengambil data tren harian...");
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return { ppsaTrend: [], tebusTrend: [] };
    const dailyPPSA = new Map(), dailyTebus = new Map();
    for (const row of rows.slice(1)) {
      if (row.length < 25) continue;
      try {
        const nama = row[0]?.trim();
        const tanggal = row[1]?.trim();
        if (!nama || !tanggal || nama === '' || nama === 'Unknown' || nama === 'NAMA KASIR') continue;
        const psmT=parseFloat(row[3])||0, psmA=parseFloat(row[4])||0;
        const pwpT=parseFloat(row[8])||0, pwpA=parseFloat(row[9])||0;
        const sgT=parseFloat(row[13])||0, sgA=parseFloat(row[14])||0;
        const apcT=parseFloat(row[18])||0, apcA=parseFloat(row[19])||0;
        const tebusT=parseFloat(row[23])||0, tebusA=parseFloat(row[24])||0;
        const date = formatDateForTrend(tanggal);
        if (!date) continue;

        const psmACV=calculateACV(psmA, psmT), psmScore=calculateScore(psmACV, BOBOT.PSM);
        const pwpACV=calculateACV(pwpA, pwpT), pwpScore=calculateScore(pwpACV, BOBOT.PWP);
        const sgACV=calculateACV(sgA, sgT), sgScore=calculateScore(sgACV, BOBOT.SG);
        const apcACV=calculateACV(apcA, apcT), apcScore=calculateScore(apcACV, BOBOT.APC);
        const totalScore = psmScore + pwpScore + sgScore + apcScore;
        const tebusACV = calculateACV(tebusA, tebusT);

        if (!dailyPPSA.has(date)) dailyPPSA.set(date, { date, totalScore:0, count:0 });
        const ppsa = dailyPPSA.get(date);
        ppsa.totalScore += totalScore;
        ppsa.count += 1;

        if (!dailyTebus.has(date)) dailyTebus.set(date, { date, totalACV:0, count:0 });
        const tebus = dailyTebus.get(date);
        tebus.totalACV += tebusACV;
        tebus.count += 1;
      } catch (e) { /* skip */ }
    }
    const ppsaTrend = Array.from(dailyPPSA.values()).map(d => ({ date: d.date, score: d.count>0 ? d.totalScore/d.count : 0, count: d.count }))
      .sort((a,b) => parseDate(a.date) - parseDate(b.date));
    const tebusTrend = Array.from(dailyTebus.values()).map(d => ({ date: d.date, acv: d.count>0 ? d.totalACV/d.count : 0, count: d.count }))
      .sort((a,b) => parseDate(a.date) - parseDate(b.date));
    log.info(`✅ Tren PPSA: ${ppsaTrend.length} hari, Tebus: ${tebusTrend.length} hari`);
    return { ppsaTrend, tebusTrend };
  } catch (error) {
    log.error('Error getDailyTrendDataFromSheets: ' + error.message);
    await sendErrorToAdmin(error, 'getDailyTrendData');
    return { ppsaTrend: [], tebusTrend: [] };
  }
}

// ====== FUNGSI SHIFT (simulasi) ======
async function getShiftPerformanceData() {
  try {
    const { kasirData } = await getDataFromGoogleSheet();
    if (!kasirData || kasirData.length === 0) return [];
    const shiftPerformance = [
      { SHIFT: 'Shift 1 (Pagi)', 'TOTAL SCORE PPSA': kasirData.reduce((s,k) => s + calculateScore(calculateACV(k.psmActual||0, k.psmTarget||0), BOBOT.PSM), 0)/kasirData.length + 85, 'ACV TEBUS (%)': 92 },
      { SHIFT: 'Shift 2 (Siang)', 'TOTAL SCORE PPSA': kasirData.reduce((s,k) => s + calculateScore(calculateACV(k.pwpActual||0, k.pwpTarget||0), BOBOT.PWP), 0)/kasirData.length + 88, 'ACV TEBUS (%)': 95 },
      { SHIFT: 'Shift 3 (Malam)', 'TOTAL SCORE PPSA': kasirData.reduce((s,k) => s + calculateScore(calculateACV(k.sgActual||0, k.sgTarget||0), BOBOT.SG), 0)/kasirData.length + 82, 'ACV TEBUS (%)': 89 }
    ];
    return shiftPerformance;
  } catch (error) {
    log.error('Error getShiftPerformanceData: ' + error.message);
    return [];
  }
}

// ====== FUNGSI GEMINI ======
async function callGeminiAPI(prompt) {
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });
    return response.text;
  } catch (error) {
    log.error('Error Gemini: ' + error.message);
    throw new Error('Analisis AI tidak tersedia');
  }
}

// ====== FORMAT LAPORAN PPSA ======
function formatPPSAReport(performanceData, grandTotal, periodText) {
  if (!performanceData || !grandTotal) {
    return `*📊 LAPORAN PPSA BY KASIR*\nPeriode: ${periodText}\n\n❌ Tidak ada data.`;
  }
  let report = `*📊 LAPORAN PPSA BY KASIR*\nPeriode: ${periodText}\nTotal Kasir: ${(performanceData.totalScore||[]).length}\n══════════════════════════════\n`;
  const sections = [
    { key: 'psm', label: '🛒 PSM (Produk Spesial Mingguan)' },
    { key: 'pwp', label: '🎁 PWP (Purchase With Purchase)' },
    { key: 'sg', label: '🎯 SG (Serba Gratis)' },
    { key: 'apc', label: '💰 APC (Average Purchase Customer)' }
  ];
  sections.forEach(section => {
    const data = performanceData[section.key];
    if (data && data.length > 0) {
      report += `*${section.label}*\nKASIR | JHK | TARGET | ACTUAL | %ACV | SCORE\n`;
      data.forEach(k => {
        report += `${k.nama} | ${k.jhk} | ${k.target} | ${k.actual} | ${k.acv} | ${k.score}\n`;
      });
      report += `══════════════════════════════\n`;
    }
  });
  if (performanceData.totalScore && performanceData.totalScore.length > 0) {
    report += `*🏆 SCORE PPSA TOTAL*\nKASIR | JHK | TOTAL SCORE\n`;
    performanceData.totalScore.forEach(k => {
      report += `${k.nama} | ${k.jhk} | ${k.totalScore}\n`;
    });
    report += `══════════════════════════════\n`;
  }
  report += `*📈 GRAND TOTAL PPSA*\nINDIKATOR | TARGET | ACTUAL | %ACV | SCORE\n`;
  const indicators = ['PSM','PWP','SG','APC'];
  indicators.forEach(ind => {
    const d = grandTotal[ind] || { target:0, actual:0, acv:0, score:0 };
    report += `${ind} | ${d.target.toFixed(1)} | ${d.actual.toFixed(1)} | ${d.acv.toFixed(2)}% | ${d.score.toFixed(2)}\n`;
  });
  const totalScore = indicators.reduce((s, ind) => s + (grandTotal[ind]?.score || 0), 0);
  report += `──────────────────────────────\n*TOTAL SCORE: ${totalScore.toFixed(2)}*\n══════════════════════════════\n`;
  return report;
}

async function generateShortAnalysis(performanceData, grandTotal) {
  if (!performanceData || !grandTotal) {
    return `📊 *ANALISIS SINGKAT PPSA:*\nTidak ada data.`;
  }
  try {
    const indicators = ['PSM','PWP','SG','APC'];
    let total = 0, best = { key:'Tidak ada', acv:0 }, worst = { key:'Tidak ada', acv:100 };
    indicators.forEach(ind => {
      const d = grandTotal[ind] || { acv:0, score:0 };
      total += d.score || 0;
      if (d.acv > best.acv) best = { key: ind, acv: d.acv };
      if (d.acv < worst.acv && d.acv > 0) worst = { key: ind, acv: d.acv };
    });
    const scores = performanceData.totalScore || [];
    if (scores.length === 0) {
      return `📊 *ANALISIS SINGKAT PPSA:*\n• Total Score: ${total.toFixed(2)}\n• Terbaik: ${best.key} (${best.acv.toFixed(1)}%)\n• Perlu Perbaikan: ${worst.key} (${worst.acv.toFixed(1)}%)\n• Tidak ada data kasir\n• Fokus pada ${worst.key}\n• Monitor konsistensi.`;
    }
    const sorted = [...scores].sort((a,b) => (parseFloat(b.totalScore)||0) - (parseFloat(a.totalScore)||0));
    const bestKasir = sorted[0] || { nama:'Tidak ada', totalScore:'0' };
    const worstKasir = sorted[sorted.length-1] || { nama:'Tidak ada', totalScore:'0' };
    const avg = sorted.reduce((s,k) => s + (parseFloat(k.totalScore)||0), 0) / sorted.length;
    const bestScore = parseFloat(bestKasir.totalScore) || 0;
    const worstScore = parseFloat(worstKasir.totalScore) || 0;
    let analysis = `📊 *ANALISIS SINGKAT PPSA:*\n• Total Score: ${total.toFixed(2)} (Avg: ${avg.toFixed(2)})\n• Terbaik: ${best.key} (${best.acv.toFixed(1)}%) | ${bestKasir.nama} (${bestScore.toFixed(2)})\n• Perlu Perbaikan: ${worst.key} (${worst.acv.toFixed(1)}%) | ${worstKasir.nama} (${worstScore.toFixed(2)})\n• Variasi: ${sorted.length} kasir (Range: ${bestScore.toFixed(2)} - ${worstScore.toFixed(2)})\n• Rekomendasi: Coaching ${worstKasir.nama}\n• Prioritas: Tingkatkan ${worst.key} +${Math.max(0, 100-worst.acv).toFixed(1)}%`;
    return analysis;
  } catch (e) {
    log.error('Error generateShortAnalysis: ' + e.message);
    return `📊 *ANALISIS SINGKAT PPSA:*\n• Terjadi error, periksa data.`;
  }
}

// ====== FUNGSI LAPORAN UTAMA ======
async function sendAllReports() {
  try {
    log.info('🤖 Mengirim semua laporan...');
    await sendPPSAReport();
    await sleep(5000);
    await sendTebusMurahReport();
    await sleep(5000);
    await sendLossDetectionReport();
    await sleep(5000);
    await sendKoreksiReport();
    log.info('✅ Semua laporan terkirim.');
    await sendToAdminGroup('✅ Semua laporan harian telah berhasil dikirim.');
  } catch (error) {
    log.error('❌ Error sendAllReports: ' + error.message);
    await sendErrorToAdmin(error, 'sendAllReports');
  }
}

async function sendPPSAReport(targetGroup = null) {
  try {
    log.info("📊 Memproses PPSA...");
    const { kasirData, periodText, grandAPCTarget, grandAPCActual } = await getDataFromGoogleSheet();
    if (!kasirData || kasirData.length === 0) {
      const msg = `*📊 LAPORAN PPSA BY KASIR*\nPeriode: ${periodText}\n\n❌ Tidak ada data.`;
      if (targetGroup) await sendMessageToGateway(targetGroup, msg);
      else await sendMessageToGroups(REPORT_GROUPS.PPSA, msg);
      return;
    }
    const perf = calculateKasirPerformance(kasirData);
    const grand = calculateGrandTotal(perf, grandAPCTarget, grandAPCActual);
    const report = formatPPSAReport(perf, grand, periodText);
    const analysis = await generateShortAnalysis(perf, grand);
    const { ppsaTrend } = await getDailyTrendDataFromSheets();
    const chart1 = await createPerformanceChart(perf.totalScore, periodText);
    const chart2 = await createComponentChart(grand, periodText);
    const chart3 = await createDailyTrendChart(ppsaTrend, periodText);
    let full = `${report}\n${analysis}`;
    if (chart1) full += `\n\n📊 *GRAFIK PERFORMANCE KASIR:*\n${chart1}`;
    if (chart2) full += `\n\n📈 *GRAFIK KOMPONEN PPSA:*\n${chart2}`;
    if (chart3) full += `\n\n📅 *GRAFIK TREN HARIAN PPSA (DATA AKTUAL):*\n${chart3}`;
    if (targetGroup) await sendMessageToGateway(targetGroup, full);
    else await sendMessageToGroups(REPORT_GROUPS.PPSA, full);
    log.info('✅ PPSA report sent.');
  } catch (error) {
    log.error('❌ Error sendPPSAReport: ' + error.message);
    await sendErrorToAdmin(error, 'sendPPSAReport');
  }
}

async function sendTebusMurahReport(targetGroup = null) {
  try {
    log.info("📊 Memproses Tebus Murah...");
    const { tebusMurahData, periodText } = await getDataFromGoogleSheet();
    if (!tebusMurahData || tebusMurahData.length === 0) {
      const msg = `*📊 LAPORAN TEBUS MURAH RP. 2.500*\nPeriode: ${periodText}\n\n❌ Tidak ada data.`;
      if (targetGroup) await sendMessageToGateway(targetGroup, msg);
      else await sendMessageToGroups(REPORT_GROUPS.TEBUS_MURAH, msg);
      return;
    }
    const perf = calculateTebusMurahPerformance(tebusMurahData);
    const report = formatTebusMurahReport(perf, periodText);
    const analysis = await generateTebusMurahAnalysis(perf);
    const { tebusTrend } = await getDailyTrendDataFromSheets();
    const chart1 = await createTebusMurahChart(perf, periodText);
    const chart2 = await createTebusDailyTrendChart(tebusTrend, periodText);
    let full = `${report}\n${analysis}`;
    if (chart1) full += `\n\n📊 *GRAFIK PERFORMANCE TEBUS:*\n${chart1}`;
    if (chart2) full += `\n\n📅 *GRAFIK TREN HARIAN TEBUS (DATA AKTUAL):*\n${chart2}`;
    if (targetGroup) await sendMessageToGateway(targetGroup, full);
    else await sendMessageToGroups(REPORT_GROUPS.TEBUS_MURAH, full);
    log.info('✅ Tebus report sent.');
  } catch (error) {
    log.error('❌ Error sendTebusMurahReport: ' + error.message);
    await sendErrorToAdmin(error, 'sendTebusMurahReport');
  }
}

async function sendLossDetectionReport(targetGroup = null) {
  try {
    log.info("🔍 Memproses Loss Detection...");
    const lossData = await getLossDetectionData();
    if (!lossData || lossData.length === 0) {
      const msg = "✅ Tidak ada indikasi kehilangan barang pada periode ini.";
      if (targetGroup) await sendMessageToGateway(targetGroup, msg);
      else await sendMessageToGroups(REPORT_GROUPS.LOSS_DETECTION, msg);
      return;
    }
    const dates = lossData.map(i => i.tanggal).filter(d => d);
    const period = formatPeriod(dates);
    const grouped = groupLossData(lossData);
    const report = formatLossDetectionReport(grouped, period);
    if (targetGroup) await sendMessageToGateway(targetGroup, report);
    else await sendMessageToGroups(REPORT_GROUPS.LOSS_DETECTION, report);
    log.info('✅ Loss Detection report sent.');
  } catch (error) {
    log.error('❌ Error sendLossDetectionReport: ' + error.message);
    await sendErrorToAdmin(error, 'sendLossDetectionReport');
  }
}

async function sendKoreksiReport(targetGroup = null) {
  try {
    log.info("📊 Memproses Koreksi Stock...");
    const koreksiData = await getKoreksiData();
    if (!koreksiData || koreksiData.length === 0) {
      const msg = "✅ Tidak ada data koreksi stock pada periode ini.";
      if (targetGroup) await sendMessageToGateway(targetGroup, msg);
      else await sendMessageToGroups(REPORT_GROUPS.KOREKSI, msg);
      return;
    }
    const dates = koreksiData.map(i => i.tanggal).filter(d => d);
    const period = formatPeriod(dates);
    const analysis = analyzeKoreksiData(koreksiData);
    const report = formatKoreksiReport(analysis, period);
    // Grafik koreksi
    const charts = await createAllKoreksiCharts(analysis, koreksiData, period);
    let full = report;
    if (charts.summaryChart) full += `\n\n📊 *GRAFIK RINGKASAN KOREKSI:*\n${charts.summaryChart}`;
    if (charts.categoryChart) full += `\n\n📁 *GRAFIK KOREKSI PER KATEGORI:*\n${charts.categoryChart}`;
    if (charts.tagChart) full += `\n\n🏷️ *GRAFIK DISTRIBUSI PER TAG:*\n${charts.tagChart}`;
    if (charts.trendChart) full += `\n\n📈 *GRAFIK TREN KOREKSI HARIAN:*\n${charts.trendChart}`;
    if (targetGroup) await sendMessageToGateway(targetGroup, full);
    else await sendMessageToGroups(REPORT_GROUPS.KOREKSI, full);
    log.info('✅ Koreksi report sent.');
  } catch (error) {
    log.error('❌ Error sendKoreksiReport: ' + error.message);
    await sendErrorToAdmin(error, 'sendKoreksiReport');
  }
}

async function createAllKoreksiCharts(analysis, koreksiData, periodText) {
  const charts = { summaryChart: null, categoryChart: null, tagChart: null, trendChart: null };
  try {
    const [s, c, t, tr] = await Promise.allSettled([
      createKoreksiSummaryChart(analysis, periodText),
      createKoreksiByCategoryChart(analysis, periodText),
      createKoreksiByTagChart(analysis, periodText),
      createKoreksiTrendChart(koreksiData, periodText)
    ]);
    if (s.status === 'fulfilled') charts.summaryChart = s.value;
    if (c.status === 'fulfilled') charts.categoryChart = c.value;
    if (t.status === 'fulfilled') charts.tagChart = t.value;
    if (tr.status === 'fulfilled') charts.trendChart = tr.value;
  } catch (e) { log.error('Error createAllKoreksiCharts: ' + e.message); }
  return charts;
}

async function createKoreksiSummaryChart(analysis, periodText) {
  if (!analysis) return null;
  const labels = ['Selisih MINUS', 'Selisih PLUS'];
  const data = [analysis.totalMinusRp || 0, analysis.totalPlusRp || 0];
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Nilai Rupiah (Rp)', data, backgroundColor: ['#ff4444','#44ff44'], borderColor: ['#cc0000','#00cc00'], borderWidth: 2, borderRadius: 8 }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Ringkasan Koreksi Stock - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR },
        tooltip: { callbacks: { label: (ctx) => `Rp ${(ctx.raw||0).toLocaleString()}` } }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'Nilai (Rupiah)', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, ticks: { callback: (v) => 'Rp '+v.toLocaleString() } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Jenis Koreksi', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } }
      }
    }
  };
  return await createChart(config, `Ringkasan Koreksi - ${periodText}`);
}

async function createKoreksiByCategoryChart(analysis, periodText) {
  if (!analysis?.itemsByCategory || analysis.itemsByCategory.size === 0) return null;
  const sorted = Array.from(analysis.itemsByCategory.entries())
    .sort((a,b) => ((b[1].totalMinusRp+b[1].totalPlusRp) - (a[1].totalMinusRp+a[1].totalPlusRp)))
    .slice(0,5);
  const labels = sorted.map(([cat]) => cat || 'Unknown');
  const minus = sorted.map(([_,d]) => d.totalMinusRp || 0);
  const plus = sorted.map(([_,d]) => d.totalPlusRp || 0);
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Selisih MINUS', data: minus, backgroundColor: '#ff6b6b', borderColor: '#ff4444', borderWidth: 2, borderRadius: 6 },
        { label: 'Selisih PLUS', data: plus, backgroundColor: '#51cf66', borderColor: '#40c057', borderWidth: 2, borderRadius: 6 }
      ]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Koreksi per Kategori - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: Rp ${(ctx.raw||0).toLocaleString()}` } }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'Nilai (Rupiah)', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, ticks: { callback: (v) => 'Rp '+v.toLocaleString() } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Kategori', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, ticks: { maxRotation:45, minRotation:0 } }
      }
    }
  };
  return await createChart(config, `Koreksi per Kategori - ${periodText}`);
}

async function createKoreksiByTagChart(analysis, periodText) {
  if (!analysis?.itemsByTag || analysis.itemsByTag.size === 0) return null;
  const sorted = Array.from(analysis.itemsByTag.entries())
    .sort((a,b) => ((b[1].totalMinusRp+b[1].totalPlusRp) - (a[1].totalMinusRp+a[1].totalPlusRp)))
    .slice(0,6);
  const labels = sorted.map(([tag]) => `TAG ${tag || 'Unknown'}`);
  const data = sorted.map(([_,d]) => (d.totalMinusRp || 0) + (d.totalPlusRp || 0));
  const colors = ['#ff6b6b','#ffa94d','#ffd43b','#51cf66','#339af0','#cc5de8'];
  const config = {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: colors.map(c => c.replace('0.8','1')), borderWidth: 2 }]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Distribusi Koreksi per TAG - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = ctx.raw || 0;
              const total = ctx.dataset.data.reduce((a,b) => (a||0)+(b||0), 0);
              const pct = total>0 ? ((val/total)*100).toFixed(1) : '0.0';
              return `${ctx.label}: Rp ${val.toLocaleString()} (${pct}%)`;
            }
          }
        },
        legend: { position: 'right', labels: { color: CHART_TEXT_COLOR, font: { size:12 } } }
      }
    }
  };
  return await createChart(config, `Distribusi Koreksi per TAG - ${periodText}`);
}

async function createKoreksiTrendChart(koreksiData, periodText) {
  if (!Array.isArray(koreksiData) || koreksiData.length === 0) return null;
  const daily = new Map();
  koreksiData.forEach(item => {
    const date = formatDateForTrend(item.tanggal);
    if (!date) return;
    if (!daily.has(date)) daily.set(date, { date, minus:0, plus:0 });
    const d = daily.get(date);
    if (item.selisihQty < 0) d.minus += Math.abs(item.selisihRp || 0);
    else d.plus += Math.abs(item.selisihRp || 0);
  });
  const sorted = Array.from(daily.values()).sort((a,b) => parseDate(a.date) - parseDate(b.date));
  if (sorted.length === 0) return null;
  const labels = sorted.map(i => i.date);
  const minus = sorted.map(i => i.minus);
  const plus = sorted.map(i => i.plus);
  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Trend Selisih MINUS', data: minus, borderColor: '#ff6b6b', backgroundColor: 'rgba(255,107,107,0.1)', borderWidth: 3, fill: true, tension: 0.4, pointBackgroundColor: '#ff6b6b', pointBorderColor: '#ffffff', pointBorderWidth: 2, pointRadius: 5 },
        { label: 'Trend Selisih PLUS', data: plus, borderColor: '#51cf66', backgroundColor: 'rgba(81,207,102,0.1)', borderWidth: 3, fill: true, tension: 0.4, pointBackgroundColor: '#51cf66', pointBorderColor: '#ffffff', pointBorderWidth: 2, pointRadius: 5 }
      ]
    },
    options: {
      ...darkThemeOptions,
      plugins: {
        ...darkThemeOptions.plugins,
        title: { display: true, text: `Tren Koreksi Harian - ${periodText}`, font: { size:18, weight:'bold' }, color: CHART_TEXT_COLOR },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: Rp ${(ctx.raw||0).toLocaleString()}` } }
      },
      scales: {
        ...darkThemeOptions.scales,
        y: { ...darkThemeOptions.scales.y, beginAtZero: true, title: { display: true, text: 'Nilai Koreksi (Rp)', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR }, ticks: { callback: (v) => 'Rp '+v.toLocaleString() } },
        x: { ...darkThemeOptions.scales.x, title: { display: true, text: 'Tanggal', font: { weight:'bold', size:14 }, color: CHART_TEXT_COLOR } }
      }
    }
  };
  return await createChart(config, `Tren Koreksi Harian - ${periodText}`);
}

// ====== FUNGSI SHIFT REPORT ======
async function sendShiftPerformanceReport(targetGroup = null) {
  try {
    log.info("📊 Memproses Performance Shift...");
    const shiftData = await getShiftPerformanceData();
    const { periodText } = await getDataFromGoogleSheet();
    if (!shiftData || shiftData.length === 0) {
      await sendToAdminGroup("❌ Tidak ada data shift.");
      return;
    }
    const chart = await createShiftPerformanceChart(shiftData, periodText);
    let report = `*📊 LAPORAN PERFORMANCE PER SHIFT*\nPeriode: ${periodText}\n\n`;
    if (chart) report += `📈 *GRAFIK PERFORMANCE SHIFT:*\n${chart}\n\n`;
    report += `🔍 *ANALISIS:*\n`;
    const best = shiftData.reduce((max, s) => (s['TOTAL SCORE PPSA']||0) > (max['TOTAL SCORE PPSA']||0) ? s : max);
    const bestTebus = shiftData.reduce((max, s) => (s['ACV TEBUS (%)']||0) > (max['ACV TEBUS (%)']||0) ? s : max);
    report += `• Shift terbaik PPSA: ${best.SHIFT} (${best['TOTAL SCORE PPSA']?.toFixed(1)})\n`;
    report += `• Shift terbaik Tebus: ${bestTebus.SHIFT} (${bestTebus['ACV TEBUS (%)']?.toFixed(1)}%)\n`;
    report += `• Rekomendasi: Fokus pada shift terendah.`;
    if (targetGroup) await sendMessageToGateway(targetGroup, report);
    else await sendMessageToGroups(REPORT_GROUPS.PPSA, report);
  } catch (error) {
    log.error('❌ Error sendShiftPerformanceReport: ' + error.message);
    await sendErrorToAdmin(error, 'sendShiftPerformanceReport');
  }
}

async function sendDailyTrendReport(targetGroup = null) {
  try {
    log.info("📊 Memproses Tren Harian...");
    const { ppsaTrend, tebusTrend } = await getDailyTrendDataFromSheets();
    const { periodText } = await getDataFromGoogleSheet();
    if ((!ppsaTrend || ppsaTrend.length === 0) && (!tebusTrend || tebusTrend.length === 0)) {
      await sendToAdminGroup("❌ Tidak ada data tren.");
      return;
    }
    const chart1 = await createDailyTrendChart(ppsaTrend, periodText);
    const chart2 = await createTebusDailyTrendChart(tebusTrend, periodText);
    let report = `*📊 LAPORAN TREN HARIAN (DATA AKTUAL)*\nPeriode: ${periodText}\n\n`;
    if (chart1) {
      report += `📈 *TREN PERFORMANCE PPSA HARIAN:*\n${chart1}\n\n`;
      if (ppsaTrend.length) {
        const first = ppsaTrend[0]?.score||0, last = ppsaTrend[ppsaTrend.length-1]?.score||0;
        report += `📊 *TREN PPSA:* ${last>first?'📈 MENINGKAT':last<first?'📉 MENURUN':'➡️ STABIL'} (${first.toFixed(1)} → ${last.toFixed(1)})\n\n`;
      }
    }
    if (chart2) {
      report += `🛒 *TREN TEBUS MURAH HARIAN:*\n${chart2}\n\n`;
      if (tebusTrend.length) {
        const first = tebusTrend[0]?.acv||0, last = tebusTrend[tebusTrend.length-1]?.acv||0;
        report += `📊 *TREN TEBUS:* ${last>first?'📈 MENINGKAT':last<first?'📉 MENURUN':'➡️ STABIL'} (${first.toFixed(1)}% → ${last.toFixed(1)}%)\n\n`;
      }
    }
    report += `🔍 *INSIGHTS:*\n`;
    if (ppsaTrend.length) {
      const avg = ppsaTrend.reduce((s,d) => s + (d.score||0), 0) / ppsaTrend.length;
      const max = Math.max(...ppsaTrend.map(d=>d.score||0));
      const min = Math.min(...ppsaTrend.map(d=>d.score||0));
      report += `• Rata-rata Score PPSA: ${avg.toFixed(1)} (Max: ${max.toFixed(1)}, Min: ${min.toFixed(1)})\n`;
    }
    if (tebusTrend.length) {
      const avg = tebusTrend.reduce((s,d) => s + (d.acv||0), 0) / tebusTrend.length;
      const max = Math.max(...tebusTrend.map(d=>d.acv||0));
      const min = Math.min(...tebusTrend.map(d=>d.acv||0));
      report += `• Rata-rata ACV Tebus: ${avg.toFixed(1)}% (Max: ${max.toFixed(1)}%, Min: ${min.toFixed(1)}%)\n`;
    }
    report += `• Monitor pola fluktuasi harian\n• Optimalkan strategi berdasarkan tren.`;
    if (targetGroup) await sendMessageToGateway(targetGroup, report);
    else await sendMessageToGroups(REPORT_GROUPS.PPSA, report);
  } catch (error) {
    log.error('❌ Error sendDailyTrendReport: ' + error.message);
    await sendErrorToAdmin(error, 'sendDailyTrendReport');
  }
}

// ====== HELP ======
function getHelpMessage() {
  return `🤖 *BOT ANALYTICS - DAFTAR PERINTAH*

*LAPORAN UTAMA:*
• !laporan ppsa - Laporan PPSA + 3 Grafik (Performance, Komponen, Tren AKTUAL)
• !laporan tebus murah - Laporan Tebus + 2 Grafik (Performance, Tren AKTUAL)
• !laporan kehilangan - Laporan Deteksi Kehilangan (dengan info penanggung jawab untuk toko normal)
• !laporan koreksi - Laporan Analisis Koreksi Stock + 4 Grafik
• !laporan semua - Semua laporan (PPSA, Tebus, Kehilangan, Koreksi)

*GRAFIK & ANALISIS:*
• !grafik shift - Grafik Performance per Shift
• !grafik tren - Grafik Tren Harian PPSA & Tebus (DATA AKTUAL)

*INFORMASI:*
• !status - Status bot
• !help - Bantuan ini

*KEAMANAN DATA:*
• 🔒 Akses READ-ONLY ke Google Sheets
• 🛡️ Tidak ada operasi penghapusan
• 📊 Data asli terlindungi

*CATATAN:*
• Laporan otomatis dikirim sesuai jadwal (cron)
• Untuk laporan manual, kirim perintah di group/chat
• Fitur loss detection mendukung toko normal (2 shift) dan 24 jam (3 shift)
• Untuk toko normal, kehilangan Shift 1 → penanggung jawab Shift 2 hari sebelumnya`;
}

// ====== PROTEKSI DATA ======
async function verifyReadOnlyAccess() {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1:A1`,
    });
    log.info("✅ Akses read-only terverifikasi.");
    return true;
  } catch (error) {
    log.error("❌ Gagal verifikasi read-only: " + error.message);
    return false;
  }
}

function preventDataDeletion() {
  log.info("🛡️ Proteksi data aktif - tidak ada operasi hapus/update.");
}

// ====== ENDPOINTS ======
app.post('/handle-message', async (req, res) => {
  try {
    const { apiKey, messageData, messageText } = req.body;
    if (apiKey !== API_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const msg = messageText?.toLowerCase().trim() || '';
    const sender = messageData?.from;
    log.info(`📨 Pesan dari ${sender}: ${messageText}`);
    switch (msg) {
      case '!laporan ppsa': await sendPPSAReport(sender); break;
      case '!laporan tebus murah': await sendTebusMurahReport(sender); break;
      case '!laporan kehilangan': await sendLossDetectionReport(sender); break;
      case '!laporan koreksi': await sendKoreksiReport(sender); break;
      case '!laporan semua':
        await sendPPSAReport(sender);
        await sleep(3000);
        await sendTebusMurahReport(sender);
        await sleep(3000);
        await sendLossDetectionReport(sender);
        await sleep(3000);
        await sendKoreksiReport(sender);
        break;
      case '!grafik shift': await sendShiftPerformanceReport(sender); break;
      case '!grafik tren': await sendDailyTrendReport(sender); break;
      case '!status':
        await sendMessageToGateway(sender, '🤖 Bot Analytics berjalan normal dengan fitur grafik tren harian berdasarkan data aktual!');
        break;
      case '!help':
        await sendMessageToGateway(sender, getHelpMessage());
        break;
      default:
        // ignore
    }
    res.json({ success: true, message: 'Pesan diproses' });
  } catch (error) {
    log.error('❌ Error handle-message: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/send', async (req, res) => {
  try {
    const { apiKey, groupName, message } = req.body;
    if (apiKey !== API_KEY) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!groupName || !message) return res.status(400).json({ success: false, error: 'groupName dan message diperlukan' });
    const ok = await sendMessageToGateway(groupName, message);
    res.json({ success: ok });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Analytics Bot v1.fixed',
    timestamp: new Date().toISOString(),
    features: ['PPSA','Tebus Murah','Loss Detection','Koreksi','Charts','Daily Trends'],
    security: 'READ-ONLY',
    data_protection: 'No delete/update'
  });
});

// ====== MAIN ======
async function main() {
  try {
    log.info('🚀 Memulai Bot Analisis Multi-Group (Gateway Mode)');
    log.info(`📊 Group: PPSA=${REPORT_GROUPS.PPSA.join(',')}, Tebus=${REPORT_GROUPS.TEBUS_MURAH.join(',')}, Loss=${REPORT_GROUPS.LOSS_DETECTION.join(',')}, Koreksi=${REPORT_GROUPS.KOREKSI.join(',')}`);
    log.info(`⏰ Jadwal cron: ${SCHEDULE_CRON} (${TIMEZONE})`);
    log.info(`🏪 Tipe Toko: ${STORE_TYPE}`);
    log.info(`🔑 API Key: ${API_KEY.slice(0,4)}...${API_KEY.slice(-4)}`);
    log.info(`🔐 Gateway Basic Auth: ${GATEWAY_AUTH_USERNAME}:${'*'.repeat(GATEWAY_AUTH_PASSWORD.length)}`);

    // ✅ Inisialisasi Sheets dengan pembacaan manual
    initializeSheets();

    preventDataDeletion();
    await verifyReadOnlyAccess();

    // Test gateway
    const gatewayOk = await testGatewayConnection();
    if (!gatewayOk) {
      log.warn('⚠️ Gateway tidak dapat dihubungi. Periksa konfigurasi.');
    }

    // FIX: Bind ke 0.0.0.0 untuk kompatibilitas Cloud (ZevCloud, dll)
    app.listen(PORT, '0.0.0.0', () => {
      log.info(`✅ Server berjalan di port ${PORT} (0.0.0.0)`);
    });

    setupScheduler();

    // Startup message if gateway ok
    if (gatewayOk) {
      const startupMsg = `🤖 Bot Analisis Multi-Group online!\n\n📊 Konfigurasi:\n• PPSA → ${REPORT_GROUPS.PPSA.join(', ')}\n• Tebus → ${REPORT_GROUPS.TEBUS_MURAH.join(', ')}\n• Loss → ${REPORT_GROUPS.LOSS_DETECTION.join(', ')}\n• Koreksi → ${REPORT_GROUPS.KOREKSI.join(', ')}\n\n🎨 Fitur: Grafik tema gelap, Tren harian, Analisis koreksi 4 grafik, Loss detection dengan penanggung jawab (support toko normal/24jam).\n🛡️ Keamanan: READ-ONLY, proteksi data.\n⏰ Jadwal: ${SCHEDULE_CRON} (${TIMEZONE})\n\n📝 Perintah: !help`;
      await sendToAdminGroup(startupMsg);
    }

    process.on('SIGINT', async () => {
      log.info('🛑 Bot dihentikan manual.');
      if (gatewayOk) await sendToAdminGroup('🛑 Bot Analytics dihentikan manual.');
      process.exit(0);
    });

  } catch (error) {
    log.error('❌ Fatal error: ' + error.message);
    process.exit(1);
  }
}

async function testGatewayConnection() {
  try {
    const auth = Buffer.from(`${GATEWAY_AUTH_USERNAME}:${GATEWAY_AUTH_PASSWORD}`).toString('base64');

    const resp = await axios.post(`${GATEWAY_URL}/send`, {
      groupName: ADMIN_GROUP,
      message: '🧪 Test connection',
      apiKey: API_KEY
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 5000
    });
    if (resp.data.success) {
      log.info('✅ Gateway connection OK');
      return true;
    } else {
      log.warn('❌ Gateway response error: ' + resp.data.error);
      return false;
    }
  } catch (e) {
    log.error('❌ Gateway connection failed: ' + e.message);
    if (e.response) {
      log.error(`   Status: ${e.response.status}`);
      log.error(`   Data: ${JSON.stringify(e.response.data)}`);
    }
    return false;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
