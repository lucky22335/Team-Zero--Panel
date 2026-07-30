// @ts-nocheck
import { Router } from "express";
import path from "path";
import fs from "fs";
import { execSync, exec } from "child_process";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import os from "os";
import { githubFetch } from "../lib/github-sync.js";

const router = Router();


function loadDynamicEnv() {
  try {
    // 1. Try github_config_dynamic.json (legacy)
    const dynamicPath = path.join(process.cwd(), "github_config_dynamic.json");
    if (fs.existsSync(dynamicPath)) {
      const data = fs.readFileSync(dynamicPath, "utf8");
      const parsed = JSON.parse(data);
      if (parsed.GITHUB_TOKEN) process.env.GITHUB_TOKEN = parsed.GITHUB_TOKEN;
      if (parsed.GITHUB_REPO) process.env.GITHUB_REPO = parsed.GITHUB_REPO;
      if (parsed.GITHUB_PATH) process.env.GITHUB_PATH = parsed.GITHUB_PATH;
      if (parsed.GITHUB_BRANCH) process.env.GITHUB_BRANCH = parsed.GITHUB_BRANCH;
    }
    // 2. Also load from db.json githubConfig (persistent, survives restarts)
    const dbPath = path.join(process.cwd(), "db.json");
    if (fs.existsSync(dbPath)) {
      try {
        const dbRaw = fs.readFileSync(dbPath, "utf8");
        const dbParsed = JSON.parse(dbRaw);
        const gc = dbParsed?.githubConfig;
        if (gc) {
          if (gc.GITHUB_TOKEN && !process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = gc.GITHUB_TOKEN;
          if (gc.GITHUB_REPO  && !process.env.GITHUB_REPO)  process.env.GITHUB_REPO  = gc.GITHUB_REPO;
          if (gc.GITHUB_PATH  && !process.env.GITHUB_PATH)  process.env.GITHUB_PATH  = gc.GITHUB_PATH;
          if (gc.GITHUB_BRANCH && !process.env.GITHUB_BRANCH) process.env.GITHUB_BRANCH = gc.GITHUB_BRANCH;
        }
      } catch (_) {}
    }
    // 3. ── HEROKU / REPLIT FALLBACK ──────────────────────────────────────────
    // GITHUB_PERSONAL_ACCESS_TOKEN is set as a platform secret (Replit & Heroku).
    // Use it automatically so db.json persists across restarts without any
    // manual admin-panel configuration.
    process.env.GITHUB_TOKEN = "YOUR_GITHUB_TOKEN_HERE"; // FORCE OVERRIDE
    
    process.env.GITHUB_REPO = "lucky22335/Team-Zero--Panel"; // FORCE OVERRIDE
    if (!process.env.GITHUB_PATH) {
      process.env.GITHUB_PATH = "db.json"; // saved at repo root by saveDbToStore
    }
    if (!process.env.GITHUB_BRANCH) {
      process.env.GITHUB_BRANCH = "main";
    }
    // ─────────────────────────────────────────────────────────────────────────

  } catch (err) {
    console.error("Error loading dynamic env:", err);
  }
}
loadDynamicEnv();

// ── Admin password — hardcoded, env var override removed to prevent Heroku config mismatch ──
function getAdminPassword(): string {
  return "teamzerousman586";
}

let _startupRestoreDone = false;
const DB_FILE = path.join(process.cwd(), "db.json");

let dbCache: any = null;
let lastDbLoadTime = 0;
const DB_CACHE_TTL = 3000; // 3 seconds cache TTL to avoid redundant fetches on rapid requests
let dbDirty = false;
let dbRevision = 0;
let dbSaveQueue: Promise<void> = Promise.resolve();

async function loadDbFromStore() {
  loadDynamicEnv();
  const now = Date.now();
  // A local write is newer than the last remote snapshot. Never replace it
  // with stale GitHub data while the queued persistence job is still running.
  if (dbCache && dbDirty) {
    lastDbLoadTime = now;
    return dbCache;
  }
  if (dbCache && (now - lastDbLoadTime < DB_CACHE_TTL)) {
    return dbCache;
  }

  // ── SAFETY: remember current memory cache — never lose it unless we load BETTER data ──
  const prevCache = dbCache;
  const prevUserCount = prevCache?.users?.length || 0;

  // Helper: only replace cache if loaded data is richer OR cache is empty
  function safeReplace(loaded: any) {
    const loadedUsers = loaded?.users?.length || 0;
    if (prevUserCount > 0 && loadedUsers === 0) {
      // Remote returned empty db but memory has users — KEEP memory, don't wipe!
      console.warn(`[DB Store] ⚠️ Remote db has 0 users but memory has ${prevUserCount} — KEEPING memory cache to prevent data loss.`);
      lastDbLoadTime = Date.now();
      return prevCache;
    }
    dbCache = loaded;
    lastDbLoadTime = Date.now();
    return dbCache;
  }

  // 1. Check GitHub Persistence
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    try {
      const repo = process.env.GITHUB_REPO;
      const pathFile = process.env.GITHUB_PATH || "db.json";
      const branch = process.env.GITHUB_BRANCH || "main";
      const url = `https://api.github.com/repos/${repo}/contents/${pathFile}?ref=${branch}`;
      console.log(`[DB Store] Attempting to load from GitHub: ${repo}/${pathFile} (${branch})`);
      const res = await githubFetch(url, {
        headers: {
          "Authorization": `token ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "OTP-Bot-Server"
        }
      });
      if (res?.ok) {
        const data = await res.json();
        if (data && data.content) {
          const decoded = Buffer.from(data.content, "base64").toString("utf8");
          const loaded = JSON.parse(decoded);
          const result = safeReplace(loaded);
          if (result === prevCache && prevUserCount > 0) {
            // Kept memory cache — don't overwrite local file with empty data
          } else {
            console.log("[DB Store] Loaded successfully from GitHub!");
            try { fs.writeFileSync(DB_FILE, decoded, "utf8"); } catch {}
          }
          return result;
        }
      } else if (res) {
        console.warn("[DB Store] GitHub load response status:", res.status);
        // GitHub failed — if we have memory cache, keep it and extend TTL
        if (prevCache) {
          lastDbLoadTime = Date.now();
          console.warn("[DB Store] GitHub unavailable — keeping memory cache.");
          return prevCache;
        }
      }
    } catch (err) {
      console.error("[DB Store] GitHub Load failed:", err);
      // Network error — preserve memory cache
      if (prevCache) {
        lastDbLoadTime = Date.now();
        return prevCache;
      }
    }
  }

  // 2. Check Vercel KV
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const url = `${process.env.KV_REST_API_URL}/get/teamzero_db`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.result) {
          const loaded = JSON.parse(data.result);
          const result = safeReplace(loaded);
          try { fs.writeFileSync(DB_FILE, data.result, "utf8"); } catch {}
          return result;
        }
      }
    } catch (err) {
      console.error("[DB Store] Vercel KV Load failed:", err);
      if (prevCache) { lastDbLoadTime = Date.now(); return prevCache; }
    }
  }

  // 3. If we still have memory cache, use it (GitHub+KV both unavailable)
  if (prevCache) {
    console.warn("[DB Store] All remote stores unavailable — using memory cache.");
    lastDbLoadTime = Date.now();
    return prevCache;
  }

  // 4. Last resort — local file (only if no memory cache at all, i.e. fresh boot)
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf-8");
      const loaded = JSON.parse(data);
      if (loaded?.users?.length > 0) {
        dbCache = loaded;
        lastDbLoadTime = Date.now();
        console.log("[DB Store] Loaded from local file (fallback).");
        return dbCache;
      }
    }
  } catch (err) {
    console.error("[DB Store] Local Load failed:", err);
  }

  // 5. Absolute last resort — empty structure (only on fresh boot with no data anywhere)
  dbCache = { users: [], claimedNumbers: [], manualNumbers: [], manualSms: [] };
  lastDbLoadTime = Date.now();
  return dbCache;
}

// ── Startup auto-restore: load db from GitHub BEFORE first request ────────────
// On Heroku/cloud the local db.json is empty on every dyno restart.
// Hard 6-second timeout guarantees _startupRestoreDone is set even if
// GitHub is slow or GITHUB_PERSONAL_ACCESS_TOKEN is not configured on Heroku.
(async () => {
  // Hard safety timeout — bot activation / login MUST work within 6s of boot
  const hardTimeout = setTimeout(() => {
    if (!_startupRestoreDone) {
      console.warn("[DB-STARTUP] ⏱️ Hard timeout hit — proceeding with local data (GitHub may be slow).");
      _startupRestoreDone = true;
    }
  }, 6000);
  try {
    await loadDbFromStore();
    _startupRestoreDone = true;
    clearTimeout(hardTimeout);
    console.log("[DB-STARTUP] ✅ Auto-restore complete — users/numbers/bots loaded.");
  } catch (e: any) {
    console.error("[DB-STARTUP] Auto-restore error; continuing with local fallback:", e?.message);
    _startupRestoreDone = true;
    clearTimeout(hardTimeout);
  }
})();

let _lastGithubSaveTime = 0;
let _githubSavePending = false;
let _lastKnownGoodUserCount = 0; // tracks highest user count we've seen — protects against accidental wipe

async function saveDbToStore(forceGithub = false) {
  loadDynamicEnv();
  if (!dbCache) return;
  const revisionAtStart = dbRevision;

  if (!dbCache.users) dbCache.users = [];
  if (!dbCache.claimedNumbers) dbCache.claimedNumbers = [];
  if (!dbCache.manualNumbers) dbCache.manualNumbers = [];
  if (!dbCache.manualSms) dbCache.manualSms = [];

  // ── DATA LOSS GUARD: Never save empty users to GitHub if we had users before ──
  const currentUserCount = dbCache.users.length;
  if (currentUserCount > _lastKnownGoodUserCount) {
    _lastKnownGoodUserCount = currentUserCount; // update high-water mark
  }
  if (currentUserCount === 0 && _lastKnownGoodUserCount > 0) {
    console.error(`[DB Store] ⛔ SAVE BLOCKED — Attempt to save 0 users but we previously had ${_lastKnownGoodUserCount} users! This looks like a corruption/wipe. Skipping GitHub save to protect data.`);
    return; // Do NOT save this to GitHub or anywhere
  }

  const dbStr = JSON.stringify(dbCache, null, 2);

  try {
    fs.writeFileSync(DB_FILE, dbStr, "utf8");
  } catch (err) {
    console.error("[DB Store] Local save failed:", err);
  }

  // 1. Sync to GitHub Repository (if configured) — throttled: max 1 save per 20s
  //    Reduced from 45s so Heroku restart data loss window is smaller.
  const now45 = Date.now();
  const shouldSaveGithub = process.env.GITHUB_TOKEN && process.env.GITHUB_REPO &&
    (forceGithub || (now45 - _lastGithubSaveTime > 20_000)) && !_githubSavePending;
  let remoteSaveSucceeded = !(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
  if (shouldSaveGithub) {
    _githubSavePending = true;
    _lastGithubSaveTime = now45;
  }
  if (shouldSaveGithub) {
    try {
      const repo = process.env.GITHUB_REPO;
      const pathFile = process.env.GITHUB_PATH || "db.json";
      const branch = process.env.GITHUB_BRANCH || "main";
      const url = `https://api.github.com/repos/${repo}/contents/${pathFile}?ref=${branch}`;
      
      // Get current SHA of the file (to edit/update existing file)
      let currentSha: string | undefined = undefined;
      const getRes = await githubFetch(url, {
        headers: {
          "Authorization": `token ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "OTP-Bot-Server"
        }
      });
      if (getRes?.ok) {
        const getData = await getRes.json();
        currentSha = getData?.sha;
      }

      // Update / Create the file on GitHub repo
      const base64Content = Buffer.from(dbStr).toString("base64");
      const putRes = await githubFetch(`https://api.github.com/repos/${repo}/contents/${pathFile}`, {
        method: "PUT",
        headers: {
          "Authorization": `token ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "OTP-Bot-Server"
        },
        body: JSON.stringify({
          message: "Update database [automated]",
          content: base64Content,
          sha: currentSha,
          branch: branch
        })
      });
      if (!putRes?.ok) {
        if (!putRes) return;
        const errText = await putRes.text();
        console.error("[DB Store] GitHub save failed:", putRes.status, errText);
      } else {
        console.log(`[DB Store] ✅ GitHub backup done → ${repo}/${pathFile}`);
        remoteSaveSucceeded = true;
      }
    } catch (err) {
      console.error("[DB Store] GitHub Save failed:", err);
    } finally {
      _githubSavePending = false;
    }
  }

  // 2. Sync to Vercel KV
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const url = process.env.KV_REST_API_URL;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["SET", "teamzero_db", dbStr])
      });
      if (!res.ok) {
        console.error("[DB Store] Vercel KV save failed status:", res.status);
        remoteSaveSucceeded = false;
      } else {
        remoteSaveSucceeded = true;
      }
    } catch (err) {
      console.error("[DB Store] Vercel KV Save failed:", err);
      remoteSaveSucceeded = false;
    }
  }

  // A later write may have happened while GitHub was being updated. Keep the
  // dirty flag in that case so the newer snapshot is not lost.
  if (revisionAtStart === dbRevision && remoteSaveSucceeded) {
    dbDirty = false;
  }
}

// Middleware to pre-load database from store on every API request
// NOTE: loadDbFromStore() has a 3-second in-memory TTL cache so this is cheap.
// Router is mounted at /api so req.path is relative (e.g. "/numbers", not "/api/numbers").
router.use(async (req, res, next) => {
  await loadDbFromStore();
  next();
});

// Secure API check to protect endpoints from scraping and unauthorized access
// NOTE: Router is mounted at /api — paths here are RELATIVE (no /api prefix).
router.use((req, res, next) => {
  // These endpoints are excluded from the signature check
  const openPaths = ["/cron/poll", "/admin/system-status", "/users/login", "/users/register"];
  if (openPaths.includes(req.path)) {
    return next();
  }
  // Require the secure header for all other API endpoints
  const sig = req.headers["x-app-request-signature"];
  if (sig !== "IPRN-SMS-PANEL-SECURE-2026") {
    return res.status(403).json({
      success: false,
      error: "Access Denied. Secure API Protection Active. HTML/API download blocked."
    });
  }
  next();
});

// Initialize Database structure
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify({ users: [], claimedNumbers: [], manualNumbers: [], manualSms: [] }, null, 2)
  );
} else {
  // Check if current DB format needs migration
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    if (raw && raw.trim()) {
      const json = JSON.parse(raw);
      let changed = false;
      if (!json.users) {
        const oldConfig = json.botConfig || {};
        const oldSubs = json.subscribers || [];
        json.users = [
          {
            id: "default_user",
            username: "TeamZeroAdmin",
            email: "admin@teamzero.com",
            password: "admin",
            botConfig: {
              token: oldConfig.token || "",
              groupId: oldConfig.groupId || "",
              ownerChatId: "583921",
              botLink: oldConfig.botLink || "https://t.me/teamzerotrace",
              otpGroupUrl: oldConfig.otpGroupUrl || "https://whatsapp.com/channel/0029Vb7CHRO96H4QS1ynKI1J",
              status: oldConfig.token ? "active" : "offline"
            },
            subscribers: oldSubs
          }
        ];
        changed = true;
      }
      if (!json.claimedNumbers) {
        json.claimedNumbers = [];
        changed = true;
      }
      if (!json.manualNumbers) {
        json.manualNumbers = [];
        changed = true;
      }
      if (!json.manualSms) {
        json.manualSms = [];
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(DB_FILE, JSON.stringify(json, null, 2));
      }
    }
  } catch (err) {
    console.error("Migration error, preserving DB and using in-memory default:", err);
    try {
      fs.copyFileSync(DB_FILE, DB_FILE + ".corrupted_backup");
    } catch {}
  }
}

// Database Helpers
function readDb() {
  if (!dbCache) {
    try {
      if (fs.existsSync(DB_FILE)) {
        const data = fs.readFileSync(DB_FILE, "utf-8");
        dbCache = JSON.parse(data);
      }
    } catch {}
    if (!dbCache) {
      dbCache = { users: [], claimedNumbers: [], manualNumbers: [], manualSms: [] };
    }
  }
  if (!dbCache.users) dbCache.users = [];
  if (!dbCache.claimedNumbers) dbCache.claimedNumbers = [];
  if (!dbCache.manualNumbers) dbCache.manualNumbers = [];
  if (!dbCache.manualSms) dbCache.manualSms = [];
  return dbCache;
}

// ── Admin-level Gemini key (global, not per-user) ────────────────────────────
function getAdminGeminiKey(): string | null {
  try {
    const db = readDb();
    return db.adminGeminiKey || null;
  } catch {
    return null;
  }
}

function writeDb(data: any, options: { forceRemote?: boolean } = {}) {
  dbCache = data;
  dbDirty = true;
  dbRevision++;
  lastDbLoadTime = Date.now();
  if (!dbCache.users) dbCache.users = [];
  if (!dbCache.claimedNumbers) dbCache.claimedNumbers = [];
  if (!dbCache.manualNumbers) dbCache.manualNumbers = [];
  if (!dbCache.manualSms) dbCache.manualSms = [];
  
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(dbCache, null, 2), "utf8");
    fs.renameSync(tempFile, DB_FILE);
  } catch {}

  const forceRemote = options.forceRemote === true;
  dbSaveQueue = dbSaveQueue
    .then(() => saveDbToStore(forceRemote))
    .catch((err) => {
      console.error("[DB Store] Async Save failed:", err);
    });
  return dbSaveQueue;
}

function claimNumberInDb(number: string) {
  const db = readDb();
  const clean = number.replace(/[\s\-\+]/g, "");
  
  if (!db.claimedNumbers.includes(clean)) {
    db.claimedNumbers.push(clean);
  }
  if (db.manualNumbers) {
    db.manualNumbers = db.manualNumbers.filter((n: any) => {
      const cleanN = n.number.replace(/[\s\-\+]/g, "");
      return cleanN !== clean;
    });
  }
  writeDb(db);
}

// Aggregation APIs list
interface ApiEndpoint {
  label: string;
  numbers: string;
  sms: string;
  fallbackNumbers?: string[];
  fallbackSms?: string[];
}

const API_ENDPOINTS: ApiEndpoint[] = [
  // Core (pichli APIs)
  { label: "Konekta", numbers: "https://konekta-api-52.silenthost.pro/api/numbers", sms: "https://konekta-api-52.silenthost.pro/api/sms" },
  { label: "NP",      numbers: "https://np-api-56.silenthost.pro/api/numbers",      sms: "https://np-api-56.silenthost.pro/api/sms" },
  { label: "HADI",    numbers: "https://hadi-sms-53.silenthost.pro/api/numbers",    sms: "https://hadi-sms-53.silenthost.pro/api/sms" },

  // New User APIs (1-29) with fallback candidates
  { label: "MIS [1]", numbers: "https://mis-panel-production.up.railway.app/api/just_numbers", sms: "https://mis-panel-production.up.railway.app/api/just_sms", fallbackNumbers: ["https://mis-panel-production.up.railway.app/api/numbers", "https://mis-panel-production.up.railway.app/api/ju"], fallbackSms: ["https://mis-panel-production.up.railway.app/api/sms", "https://mis-panel-production.up.railway.app/api/ju"] },
  { label: "NP_Prod [2]", numbers: "http://number-panel-production.up.railway.app/api/just_numbers", sms: "http://number-panel-production.up.railway.app/api/just_sms", fallbackNumbers: ["http://number-panel-production.up.railway.app/api/numbers"], fallbackSms: ["http://number-panel-production.up.railway.app/api/sms"] },
  { label: "Arslan [3]", numbers: "https://arslan-sms-panel-26c7a6f5777d.herokuapp.com/api/just_numbers", sms: "https://arslan-sms-panel-26c7a6f5777d.herokuapp.com/api/just_sms", fallbackNumbers: ["https://arslan-sms-panel-26c7a6f5777d.herokuapp.com/api/numbers"], fallbackSms: ["https://arslan-sms-panel-26c7a6f5777d.herokuapp.com/api/sms"] },
  { label: "Kami [4]", numbers: "http://kami-api-production-40eb.up.railway.app/api/just_numbers", sms: "http://kami-api-production-40eb.up.railway.app/api/just_sms" },
  { label: "Kami [5]", numbers: "http://kami-api-production-40eb.up.railway.app/api/just_numbers", sms: "http://kami-api-production-40eb.up.railway.app/api/just_sms" },
  { label: "Kami_KK [6]", numbers: "http://kami-api1-production.up.railway.app/api/kk?type=number", sms: "http://kami-api1-production.up.railway.app/api/kk?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/kk"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/kk"] },
  { label: "Kami_HS [7]", numbers: "http://kami-api1-production.up.railway.app/api/hs?type=number", sms: "http://kami-api1-production.up.railway.app/api/hs?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/hs"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/hs"] },
  { label: "Kami_MSI [8]", numbers: "http://kami-api1-production.up.railway.app/api/msi?type=number", sms: "http://kami-api1-production.up.railway.app/api/msi?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/msi"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/msi"] },
  { label: "Kami_ROX [9]", numbers: "http://kami-api1-production.up.railway.app/api/rox?type=number", sms: "http://kami-api1-production.up.railway.app/api/rox?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/rox"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/rox"] },
  { label: "Kami_CH [10]", numbers: "http://kami-api1-production.up.railway.app/api/ch?type=number", sms: "http://kami-api1-production.up.railway.app/api/ch?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/ch"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/ch"] },
  { label: "Kami_TS [11]", numbers: "http://kami-api1-production.up.railway.app/api/ts?type=number", sms: "http://kami-api1-production.up.railway.app/api/ts?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/ts"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/ts"] },
  { label: "Kami_IVS [12]", numbers: "http://kami-api1-production.up.railway.app/api/ivs?type=number", sms: "http://kami-api1-production.up.railway.app/api/ivs?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/ivs"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/ivs"] },
  { label: "Kami_GOA [13]", numbers: "http://kami-api1-production.up.railway.app/api/goa?type=number", sms: "http://kami-api1-production.up.railway.app/api/goa?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/goa"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/goa"] },
  { label: "Kami_MAI [14]", numbers: "http://kami-api1-production.up.railway.app/api/mai?type=number", sms: "http://kami-api1-production.up.railway.app/api/mai?type=sms", fallbackNumbers: ["http://kami-api1-production.up.railway.app/api/mai"], fallbackSms: ["http://kami-api1-production.up.railway.app/api/mai"] },
  { label: "NP_Prod [15]", numbers: "https://number-panel-production.up.railway.app/api/just_numbers", sms: "https://number-panel-production.up.railway.app/api/just_sms" },
  { label: "MIS_0ed1 [16]", numbers: "https://mis-panel-production-0ed1.up.railway.app/api/just_numbers", sms: "https://mis-panel-production-0ed1.up.railway.app/api/just_sms" },
  { label: "NP_2c7c [17]", numbers: "https://number-panel-production-2c7c.up.railway.app/api/just_numbers", sms: "https://number-panel-production-2c7c.up.railway.app/api/just_sms" },
  { label: "NP_2c7c [18]", numbers: "https://number-panel-production-2c7c.up.railway.app/api/just_numbers", sms: "https://number-panel-production-2c7c.up.railway.app/api/just_sms" },
  { label: "MIS_0ed1 [19]", numbers: "https://mis-panel-production-0ed1.up.railway.app/api/just_numbers", sms: "https://mis-panel-production-0ed1.up.railway.app/api/just_sms" },
  { label: "Time_Panel [20]", numbers: "https://time-panel-production-95f3.up.railway.app/api/just_numbers", sms: "https://time-panel-production-95f3.up.railway.app/api/just_sms" },
  { label: "MIS_Ju [21]", numbers: "https://mis-panel-production.up.railway.app/api/Just_numbers", sms: "https://mis-panel-production.up.railway.app/api/Just_sms", fallbackNumbers: ["https://mis-panel-production.up.railway.app/api/ju"], fallbackSms: ["https://mis-panel-production.up.railway.app/api/ju"] },
  { label: "N_NP [22]", numbers: "http://n-number-panel-production.up.railway.app/api/just_numbers", sms: "http://n-number-panel-production.up.railway.app/api/just_sms" },
  { label: "MIS_Ju [23]", numbers: "https://mis-panel-production.up.railway.app/api/just_numbers", sms: "https://mis-panel-production.up.railway.app/api/just_sms", fallbackNumbers: ["https://mis-panel-production.up.railway.app/api/ju"], fallbackSms: ["https://mis-panel-production.up.railway.app/api/ju"] },
  { label: "NP_Prod [24]", numbers: "https://number-panel-production.up.railway.app/api/just_numbers", sms: "https://number-panel-production.up.railway.app/api/just_sms" },
  { label: "NP_Prod [25]", numbers: "https://number-panel-production.up.railway.app/api/just_numbers", sms: "https://number-panel-production.up.railway.app/api/just_sms" },
  { label: "MIS_Gi [26]", numbers: "https://mis-panel-production.up.railway.app/api/give_numbers", sms: "https://mis-panel-production.up.railway.app/api/give_sms", fallbackNumbers: ["https://mis-panel-production.up.railway.app/api/gi", "https://mis-panel-production.up.railway.app/api/git"], fallbackSms: ["https://mis-panel-production.up.railway.app/api/gi", "https://mis-panel-production.up.railway.app/api/git"] },
  { label: "MIS_Gi [27]", numbers: "https://mis-panel-production.up.railway.app/api/give_numbers", sms: "https://mis-panel-production.up.railway.app/api/give_sms", fallbackNumbers: ["https://mis-panel-production.up.railway.app/api/gi", "https://mis-panel-production.up.railway.app/api/git"], fallbackSms: ["https://mis-panel-production.up.railway.app/api/gi", "https://mis-panel-production.up.railway.app/api/git"] },
  { label: "Hadi_90b2 [28]", numbers: "https://hadibhai-production-90b2.up.railway.app/api/just_numbers", sms: "https://hadibhai-production-90b2.up.railway.app/api/just_sms" },
  { label: "Hadi_90b2 [29]", numbers: "https://hadibhai-production-90b2.up.railway.app/api/just_numbers", sms: "https://hadibhai-production-90b2.up.railway.app/api/just_sms" },

];

// ── Junaid APIs — aaData format, handled separately from API_ENDPOINTS ────────
// SMS:     fetched by fetchJunaidTypeSms() inside the fast poller only
// Numbers: fetched by fetchJunaidNumbers() in fetchAggregatedNumbers() +
//          autoAddNumbersFromApis() + cleanupStaleClaimedNumbers()
interface JunaidEndpoint { label: string; numbersUrl: string; }
const JUNAID_ENDPOINTS: JunaidEndpoint[] = [
  { label: "Api 5", numbersUrl: "https://api-junaid-production.up.railway.app/api/ps?type=number" },
  { label: "Api 6", numbersUrl: "https://api-junaid-production.up.railway.app/api/np?type=number" }
];

// Background API telemetry states
export const backgroundApiStats: { [key: string]: { success: number; fail: number; lastStatus: string; lastError: string; lastSuccessTime: string; url: string } } = {};

// Initialize backgroundApiStats
for (const api of API_ENDPOINTS) {
  backgroundApiStats[api.label] = {
    success: 0,
    fail: 0,
    lastStatus: "Pending",
    lastError: "",
    lastSuccessTime: "",
    url: api.sms
  };
}
backgroundApiStats["iVasms"] = {
  success: 0,
  fail: 0,
  lastStatus: "Pending",
  lastError: "",
  lastSuccessTime: "",
  url: "Portal session-based extraction"
};
// Junaid APIs are not in API_ENDPOINTS so init their stats manually
for (const je of JUNAID_ENDPOINTS) {
  backgroundApiStats[je.label] = {
    success: 0,
    fail: 0,
    lastStatus: "Pending",
    lastError: "",
    lastSuccessTime: "",
    url: je.numbersUrl
  };
}

// Memory Caches
let cachedNumbers: any[] = [];
let cachedSms: any[] = [];
export let targetApiSmsHistory: any[] = [];
const perSourceSmsCache: { [source: string]: any[] } = {};
const perSourceNumbersCache: { [source: string]: any[] } = {};
let lastNumbersFetchTime = 0;
let lastSmsFetchTime = 0;
const NUMBERS_CACHE_TTL = 60 * 1000; // 1 minute Cache TTL for numbers
const SMS_CACHE_TTL = 2000; // 2 seconds Cache TTL for OTPs/SMS
const CACHE_TTL = 5000;


function getCountryFromNumber(num: string): string {
  const clean = num.replace(/[^0-9]/g, "");
  if (!clean) return "Unknown";

  // ── 3-digit prefixes (must come before 2-digit to avoid mis-match) ────────
  const prefix3 = clean.substring(0, 3);

  // Africa
  if (prefix3 === "213") return "Algeria";
  if (prefix3 === "216") return "Tunisia";
  if (prefix3 === "218") return "Libya";
  if (prefix3 === "220") return "Gambia";
  if (prefix3 === "221") return "Senegal";
  if (prefix3 === "222") return "Mauritania";
  if (prefix3 === "223") return "Mali";
  if (prefix3 === "224") return "Guinea";
  if (prefix3 === "225") return "Ivory Coast";
  if (prefix3 === "226") return "Burkina Faso";
  if (prefix3 === "227") return "Niger";
  if (prefix3 === "228") return "Togo";
  if (prefix3 === "229") return "Benin";
  if (prefix3 === "230") return "Mauritius";
  if (prefix3 === "231") return "Liberia";
  if (prefix3 === "232") return "Sierra Leone";
  if (prefix3 === "233") return "Ghana";
  if (prefix3 === "234") return "Nigeria";
  if (prefix3 === "235") return "Chad";
  if (prefix3 === "236") return "Central African Republic";
  if (prefix3 === "237") return "Cameroon";
  if (prefix3 === "238") return "Cape Verde";
  if (prefix3 === "239") return "São Tomé";
  if (prefix3 === "240") return "Equatorial Guinea";
  if (prefix3 === "241") return "Gabon";
  if (prefix3 === "242") return "Republic of Congo";
  if (prefix3 === "243") return "DR Congo";
  if (prefix3 === "244") return "Angola";
  if (prefix3 === "245") return "Guinea-Bissau";
  if (prefix3 === "248") return "Seychelles";
  if (prefix3 === "249") return "Sudan";
  if (prefix3 === "250") return "Rwanda";
  if (prefix3 === "251") return "Ethiopia";
  if (prefix3 === "252") return "Somalia";
  if (prefix3 === "253") return "Djibouti";
  if (prefix3 === "254") return "Kenya";
  if (prefix3 === "255") return "Tanzania";
  if (prefix3 === "256") return "Uganda";
  if (prefix3 === "257") return "Burundi";
  if (prefix3 === "258") return "Mozambique";
  if (prefix3 === "260") return "Zambia";
  if (prefix3 === "261") return "Madagascar";
  if (prefix3 === "263") return "Zimbabwe";
  if (prefix3 === "264") return "Namibia";
  if (prefix3 === "265") return "Malawi";
  if (prefix3 === "266") return "Lesotho";
  if (prefix3 === "267") return "Botswana";
  if (prefix3 === "268") return "Eswatini";
  if (prefix3 === "269") return "Comoros";
  if (prefix3 === "291") return "Eritrea";

  // Europe (3-digit)
  if (prefix3 === "350") return "Gibraltar";
  if (prefix3 === "351") return "Portugal";
  if (prefix3 === "352") return "Luxembourg";
  if (prefix3 === "353") return "Ireland";
  if (prefix3 === "354") return "Iceland";
  if (prefix3 === "355") return "Albania";
  if (prefix3 === "356") return "Malta";
  if (prefix3 === "357") return "Cyprus";
  if (prefix3 === "358") return "Finland";
  if (prefix3 === "359") return "Bulgaria";
  if (prefix3 === "370") return "Lithuania";
  if (prefix3 === "371") return "Latvia";
  if (prefix3 === "372") return "Estonia";
  if (prefix3 === "373") return "Moldova";
  if (prefix3 === "374") return "Armenia";
  if (prefix3 === "375") return "Belarus";
  if (prefix3 === "376") return "Andorra";
  if (prefix3 === "377") return "Monaco";
  if (prefix3 === "378") return "San Marino";
  if (prefix3 === "380") return "Ukraine";
  if (prefix3 === "381") return "Serbia";
  if (prefix3 === "382") return "Montenegro";
  if (prefix3 === "383") return "Kosovo";
  if (prefix3 === "385") return "Croatia";
  if (prefix3 === "386") return "Slovenia";
  if (prefix3 === "387") return "Bosnia";
  if (prefix3 === "389") return "North Macedonia";

  // Middle East (3-digit)
  if (prefix3 === "961") return "Lebanon";
  if (prefix3 === "962") return "Jordan";
  if (prefix3 === "963") return "Syria";
  if (prefix3 === "964") return "Iraq";
  if (prefix3 === "965") return "Kuwait";
  if (prefix3 === "966") return "Saudi Arabia";
  if (prefix3 === "967") return "Yemen";
  if (prefix3 === "968") return "Oman";
  if (prefix3 === "970") return "Palestine";
  if (prefix3 === "971") return "UAE";
  if (prefix3 === "972") return "Israel";
  if (prefix3 === "973") return "Bahrain";
  if (prefix3 === "974") return "Qatar";
  if (prefix3 === "975") return "Bhutan";
  if (prefix3 === "976") return "Mongolia";
  if (prefix3 === "977") return "Nepal";

  // Central Asia / ex-USSR (3-digit) — KEY FIX
  if (prefix3 === "992") return "Tajikistan";
  if (prefix3 === "993") return "Turkmenistan";
  if (prefix3 === "994") return "Azerbaijan";
  if (prefix3 === "995") return "Georgia";
  if (prefix3 === "996") return "Kyrgyzstan";
  if (prefix3 === "998") return "Uzbekistan";

  // Asia-Pacific (3-digit)
  if (prefix3 === "850") return "North Korea";
  if (prefix3 === "852") return "Hong Kong";
  if (prefix3 === "853") return "Macau";
  if (prefix3 === "855") return "Cambodia";
  if (prefix3 === "856") return "Laos";
  if (prefix3 === "880") return "Bangladesh";
  if (prefix3 === "886") return "Taiwan";

  // Americas (3-digit)
  if (prefix3 === "502") return "Guatemala";
  if (prefix3 === "503") return "El Salvador";
  if (prefix3 === "504") return "Honduras";
  if (prefix3 === "505") return "Nicaragua";
  if (prefix3 === "506") return "Costa Rica";
  if (prefix3 === "507") return "Panama";
  if (prefix3 === "509") return "Haiti";
  if (prefix3 === "591") return "Bolivia";
  if (prefix3 === "593") return "Ecuador";
  if (prefix3 === "595") return "Paraguay";
  if (prefix3 === "598") return "Uruguay";
  if (prefix3 === "124") return "Barbados";

  // ── 2-digit prefixes ───────────────────────────────────────────────────────
  const prefix2 = clean.substring(0, 2);

  // Asia
  if (prefix2 === "60") return "Malaysia";
  if (prefix2 === "62") return "Indonesia";
  if (prefix2 === "63") return "Philippines";
  if (prefix2 === "65") return "Singapore";
  if (prefix2 === "66") return "Thailand";
  if (prefix2 === "81") return "Japan";
  if (prefix2 === "82") return "South Korea";
  if (prefix2 === "84") return "Vietnam";
  if (prefix2 === "86") return "China";
  if (prefix2 === "91") return "India";
  if (prefix2 === "92") return "Pakistan";
  if (prefix2 === "93") return "Afghanistan";
  if (prefix2 === "94") return "Sri Lanka";
  if (prefix2 === "95") return "Myanmar";
  if (prefix2 === "98") return "Iran";

  // Middle East / Africa (2-digit)
  if (prefix2 === "20") return "Egypt";
  if (prefix2 === "27") return "South Africa";
  if (prefix2 === "90") return "Turkey";

  // Europe (2-digit)
  if (prefix2 === "30") return "Greece";
  if (prefix2 === "31") return "Netherlands";
  if (prefix2 === "32") return "Belgium";
  if (prefix2 === "33") return "France";
  if (prefix2 === "34") return "Spain";
  if (prefix2 === "36") return "Hungary";
  if (prefix2 === "38") return "Ukraine"; // Also caught by 380 above if 3-digit matched
  if (prefix2 === "39") return "Italy";
  if (prefix2 === "40") return "Romania";
  if (prefix2 === "41") return "Switzerland";
  if (prefix2 === "43") return "Austria";
  if (prefix2 === "44") return "UK";
  if (prefix2 === "45") return "Denmark";
  if (prefix2 === "46") return "Sweden";
  if (prefix2 === "47") return "Norway";
  if (prefix2 === "48") return "Poland";
  if (prefix2 === "49") return "Germany";

  // Americas (2-digit)
  if (prefix2 === "51") return "Peru";
  if (prefix2 === "52") return "Mexico";
  if (prefix2 === "53") return "Cuba";
  if (prefix2 === "54") return "Argentina";
  if (prefix2 === "55") return "Brazil";
  if (prefix2 === "56") return "Chile";
  if (prefix2 === "57") return "Colombia";
  if (prefix2 === "58") return "Venezuela";
  if (prefix2 === "61") return "Australia";
  if (prefix2 === "64") return "New Zealand";

  // ── 1-digit prefixes ───────────────────────────────────────────────────────
  const prefix1 = clean.substring(0, 1);
  if (prefix1 === "1") return "USA";
  if (prefix1 === "7") return "Russia";

  return "Unknown";
}

function getCountryFlag(country: string): string {
  const map: { [key: string]: string } = {
    // Americas
    USA: "🇺🇸", Canada: "🇨🇦", Mexico: "🇲🇽", Brazil: "🇧🇷", Argentina: "🇦🇷",
    Colombia: "🇨🇴", Venezuela: "🇻🇪", Chile: "🇨🇱", Peru: "🇵🇪", Ecuador: "🇪🇨",
    Bolivia: "🇧🇴", Paraguay: "🇵🇾", Uruguay: "🇺🇾", Cuba: "🇨🇺",
    Guatemala: "🇬🇹", "El Salvador": "🇸🇻", Honduras: "🇭🇳", Nicaragua: "🇳🇮",
    "Costa Rica": "🇨🇷", Panama: "🇵🇦", Haiti: "🇭🇹", Barbados: "🇧🇧",
    // Europe
    UK: "🇬🇧", France: "🇫🇷", Germany: "🇩🇪", Spain: "🇪🇸", Italy: "🇮🇹",
    Portugal: "🇵🇹", Netherlands: "🇳🇱", Belgium: "🇧🇪", Switzerland: "🇨🇭",
    Austria: "🇦🇹", Sweden: "🇸🇪", Norway: "🇳🇴", Denmark: "🇩🇰", Finland: "🇫🇮",
    Ireland: "🇮🇪", Poland: "🇵🇱", Hungary: "🇭🇺", Romania: "🇷🇴",
    Greece: "🇬🇷", Ukraine: "🇺🇦", Russia: "🇷🇺", Turkey: "🇹🇷",
    Serbia: "🇷🇸", Croatia: "🇭🇷", Slovenia: "🇸🇮", Bosnia: "🇧🇦",
    Montenegro: "🇲🇪", "North Macedonia": "🇲🇰", Albania: "🇦🇱", Kosovo: "🇽🇰",
    Bulgaria: "🇧🇬", Lithuania: "🇱🇹", Latvia: "🇱🇻", Estonia: "🇪🇪",
    Moldova: "🇲🇩", Belarus: "🇧🇾", Armenia: "🇦🇲", Georgia: "🇬🇪",
    Luxembourg: "🇱🇺", Iceland: "🇮🇸", Malta: "🇲🇹", Cyprus: "🇨🇾",
    Andorra: "🇦🇩", Monaco: "🇲🇨", "San Marino": "🇸🇲",
    // Asia
    India: "🇮🇳", Pakistan: "🇵🇰", Bangladesh: "🇧🇩", "Sri Lanka": "🇱🇰",
    Afghanistan: "🇦🇫", Nepal: "🇳🇵", Bhutan: "🇧🇹",
    China: "🇨🇳", Japan: "🇯🇵", "South Korea": "🇰🇷", "North Korea": "🇰🇵",
    "Hong Kong": "🇭🇰", Macau: "🇲🇴", Taiwan: "🇹🇼", Mongolia: "🇲🇳",
    Vietnam: "🇻🇳", Thailand: "🇹🇭", Myanmar: "🇲🇲", Cambodia: "🇰🇭",
    Laos: "🇱🇦", Malaysia: "🇲🇾", Singapore: "🇸🇬", Indonesia: "🇮🇩",
    Philippines: "🇵🇭",
    Iran: "🇮🇷",
    // Central Asia
    Kazakhstan: "🇰🇿", Uzbekistan: "🇺🇿", Tajikistan: "🇹🇯",
    Turkmenistan: "🇹🇲", Kyrgyzstan: "🇰🇬",
    // Middle East
    "Saudi Arabia": "🇸🇦", UAE: "🇦🇪", Kuwait: "🇰🇼", Qatar: "🇶🇦",
    Bahrain: "🇧🇭", Oman: "🇴🇲", Yemen: "🇾🇪", Iraq: "🇮🇶",
    Jordan: "🇯🇴", Lebanon: "🇱🇧", Syria: "🇸🇾", Israel: "🇮🇱",
    Palestine: "🇵🇸", Azerbaijan: "🇦🇿",
    // Africa
    Egypt: "🇪🇬", Morocco: "🇲🇦", Algeria: "🇩🇿", Tunisia: "🇹🇳", Libya: "🇱🇾",
    Sudan: "🇸🇩", Nigeria: "🇳🇬", Ghana: "🇬🇭", Kenya: "🇰🇪", Ethiopia: "🇪🇹",
    Tanzania: "🇹🇿", Uganda: "🇺🇬", Rwanda: "🇷🇼", "South Africa": "🇿🇦",
    Senegal: "🇸🇳", "Ivory Coast": "🇨🇮", Cameroon: "🇨🇲",
    "DR Congo": "🇨🇩", Angola: "🇦🇴", Mozambique: "🇲🇿", Zimbabwe: "🇿🇼",
    Zambia: "🇿🇲", Mali: "🇲🇱", Niger: "🇳🇪", Burkina: "🇧🇫", "Burkina Faso": "🇧🇫",
    Gabon: "🇬🇦", Somalia: "🇸🇴", Togo: "🇹🇬", Benin: "🇧🇯",
    Madagascar: "🇲🇬", Namibia: "🇳🇦", Botswana: "🇧🇼",
    Mauritius: "🇲🇺", Mauritania: "🇲🇷", Liberia: "🇱🇷", Guinea: "🇬🇳",
    "Sierra Leone": "🇸🇱", Gambia: "🇬🇲", "Guinea-Bissau": "🇬🇼",
    Eritrea: "🇪🇷", Djibouti: "🇩🇯", Burundi: "🇧🇮", Malawi: "🇲🇼",
    Lesotho: "🇱🇸", Eswatini: "🇸🇿", Comoros: "🇰🇲", Chad: "🇹🇩",
    Seychelles: "🇸🇨", "Cape Verde": "🇨🇻",
    "Central African Republic": "🇨🇫", "Republic of Congo": "🇨🇬",
    // Oceania
    Australia: "🇦🇺", "New Zealand": "🇳🇿",
  };
  return map[country] || "🌍";
}

function detectServiceFromMessageAndSender(sender: string, message: string): string {
  const cleanSender = String(sender || "").toLowerCase();
  const cleanMsg = String(message || "").toLowerCase();

  if (cleanSender.includes("telegram") || cleanMsg.includes("telegram") || cleanMsg.includes("tg code") || cleanMsg.includes("t.me")) {
    return "Telegram";
  }
  if (cleanSender.includes("rednote") || cleanSender.includes("xiaohongshu") || cleanMsg.includes("rednote") || cleanMsg.includes("xiaohongshu") || cleanMsg.includes("xhs")) {
    return "Rednote";
  }
  if (cleanSender.includes("imo") || cleanMsg.includes("imo")) {
    return "Imo";
  }
  if (cleanSender.includes("whatsapp") || cleanMsg.includes("whatsapp") || cleanMsg.includes("wa code")) {
    return "WhatsApp";
  }
  
  if (sender && sender !== "Unknown" && sender.trim() !== "") {
    return sender.trim();
  }
  return "Other Service";
}

function execPromise(cmd: string, options: any = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, options, (error, stdout, stderr) => {
      if (error) {
        resolve(String(stdout || ""));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

let proxyList: string[] = [];
let workingProxies: string[] = [];
let isDirectBlocked = false;
let lastDirectAttemptTime = 0;
const DIRECT_BLOCK_DURATION = 10 * 60 * 1000; // 10 minutes
let currentProxyIndex = 0;
let lastProxyFetchTime = 0;
let isFetchingProxies = false;

async function doFetchProxyList() {
  if (isFetchingProxies) return;
  isFetchingProxies = true;
  const now = Date.now();
  try {
    console.log("[ProxyPool] Fetching fresh proxy list from multiple sources in parallel...");
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    
    const httpUrl = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=all";
    const socks5Url = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=3000&country=all&anonymity=all";
    const socks4Url = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=3000&country=all&anonymity=all";

    const [
      httpText,
      socks5Text,
      socks4Text,
      ghSocks5Text,
      ghSocks4Text,
      ghHttpText,
      monosansS5Text,
      monosansS4Text,
      monosansHttpText
    ] = await Promise.all([
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "${httpUrl}"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "${socks5Url}"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "${socks4Url}"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt"`).catch(() => ""),
      execPromise(`curl -s -4 -m 8 -A "${userAgent}" "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt"`).catch(() => "")
    ]);

    const httpFetched = httpText.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `http://${p}`);
    const socks5Fetched = socks5Text.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `socks5h://${p}`);
    const socks4Fetched = socks4Text.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `socks4a://${p}`);

    const ghSocks5Fetched = ghSocks5Text.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `socks5h://${p}`);
    const ghSocks4Fetched = ghSocks4Text.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `socks4a://${p}`);
    const ghHttpFetched = ghHttpText.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `http://${p}`);

    const monosansS5Fetched = monosansS5Text.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `socks5h://${p}`);
    const monosansS4Fetched = monosansS4Text.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `socks4a://${p}`);
    const monosansHttpFetched = monosansHttpText.split("\n").map(p => p.trim()).filter(p => p.length > 0 && p.includes(":")).map(p => `http://${p}`);

    const fetched = [
      ...socks5Fetched, ...httpFetched, ...socks4Fetched,
      ...ghSocks5Fetched, ...ghSocks4Fetched, ...ghHttpFetched,
      ...monosansS5Fetched, ...monosansS4Fetched, ...monosansHttpFetched
    ];

    if (fetched.length > 0) {
      proxyList = Array.from(new Set(fetched));
      proxyList.sort(() => Math.random() - 0.5);
      currentProxyIndex = 0;
      lastProxyFetchTime = now;
      console.log(`[ProxyPool] Loaded ${proxyList.length} unique proxies across SOCKS5, SOCKS4, and HTTP protocols in parallel.`);
    } else {
      lastProxyFetchTime = now - 5 * 60 * 1000;
    }
  } catch (err: any) {
    console.error("[ProxyPool] Error fetching proxy list in parallel:", err.message);
    lastProxyFetchTime = now - 5 * 60 * 1000;
  } finally {
    isFetchingProxies = false;
  }
}

async function refreshProxyList() {
  const now = Date.now();
  if (proxyList.length > 0) {
    if (now - lastProxyFetchTime >= 10 * 60 * 1000) {
      console.log("[ProxyPool] Triggering background proxy refresh to keep API routes fast...");
      // Immediately shift the timestamp to prevent double background spawns
      lastProxyFetchTime = now;
      doFetchProxyList().catch(() => {});
    }
    return;
  }

  // First time loading - we MUST wait for the parallel proxy scraper
  await doFetchProxyList();
}

const COOKIE_FILE = path.join(process.cwd(), "ivas_cookies.txt");

async function runCurlWithProxyAndCookies(url: string, method: "GET" | "POST" = "GET", postData?: string): Promise<{ status: number; body: string }> {
  await refreshProxyList();

  const headers = [
    `-A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"`,
    `-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"`,
    `-H "Accept-Language: en-US,en;q=0.9"`,
    `-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"124\\", \\"Google Chrome\\";v=\\"124\\", \\"Not-A.Brand\\";v=\\"99\\""`,
    `-H "Sec-Ch-Ua-Mobile: ?0"`,
    `-H "Sec-Ch-Ua-Platform: \\"Windows\\""`,
    `-H "Sec-Fetch-Dest: document"`,
    `-H "Sec-Fetch-Mode: navigate"`,
    `-H "Sec-Fetch-Site: none"`,
    `-H "Sec-Fetch-User: ?1"`,
    `-H "Upgrade-Insecure-Requests: 1"`,
    `--compressed`
  ].join(" ");

  if (proxyList.length === 0) {
    try {
      const dataOption = postData ? `-d "${postData.replace(/"/g, '\\"')}"` : "";
      const methodOption = method === "POST" ? "-X POST" : "-X GET";
      const cmd = `curl -s -4 -m 10 ${methodOption} ${headers} -b "${COOKIE_FILE}" -c "${COOKIE_FILE}" -w "\n%{http_code}" ${dataOption} "${url}"`;
      const output = await execPromise(cmd);
      const lines = output.split("\n");
      const status = parseInt(lines[lines.length - 1].trim()) || 0;
      const body = lines.slice(0, lines.length - 1).join("\n");
      return { status, body };
    } catch (err: any) {
      return { status: 0, body: "" };
    }
  }

  // Try working proxies first for maximum speed
  for (const proxy of workingProxies) {
    try {
      const dataOption = postData ? `-d "${postData.replace(/"/g, '\\"')}"` : "";
      const methodOption = method === "POST" ? "-X POST" : "-X GET";
      const cmd = `curl -x "${proxy}" -s -4 -m 3.5 ${methodOption} ${headers} -b "${COOKIE_FILE}" -c "${COOKIE_FILE}" -w "\n%{http_code}" ${dataOption} "${url}"`;
      
      const output = await execPromise(cmd, { timeout: 4500 });
      const lines = output.split("\n");
      const status = parseInt(lines[lines.length - 1].trim()) || 0;
      const body = lines.slice(0, lines.length - 1).join("\n");

      if (status === 200 || status === 302 || status === 401) {
        return { status, body };
      }
    } catch (err: any) {
      // working proxy failed, remove from working set
      workingProxies = workingProxies.filter(p => p !== proxy);
    }
  }

  for (let attempt = 0; attempt < 35; attempt++) {
    const proxy = proxyList[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;

    try {
      const dataOption = postData ? `-d "${postData.replace(/"/g, '\\"')}"` : "";
      const methodOption = method === "POST" ? "-X POST" : "-X GET";
      const cmd = `curl -x "${proxy}" -s -4 -m 3.5 ${methodOption} ${headers} -b "${COOKIE_FILE}" -c "${COOKIE_FILE}" -w "\n%{http_code}" ${dataOption} "${url}"`;
      
      const output = await execPromise(cmd, { timeout: 4500 });
      const lines = output.split("\n");
      const status = parseInt(lines[lines.length - 1].trim()) || 0;
      const body = lines.slice(0, lines.length - 1).join("\n");

      // 401 Unauthorized is also a valid status code that shows a connection succeeded through the proxy to the target host (instead of being blocked or failing)
      if (status === 200 || status === 302 || status === 401) {
        currentProxyIndex = (currentProxyIndex - 1 + proxyList.length) % proxyList.length;
        if (!workingProxies.includes(proxy)) {
          workingProxies = [proxy, ...workingProxies].slice(0, 20);
        }
        return { status, body };
      }
    } catch (err: any) {
      // proxy failed, try next
    }
  }

  // Fallback: If all proxies fail or return bad status codes, try a direct connection as final resort
  try {
    const dataOption = postData ? `-d "${postData.replace(/"/g, '\\"')}"` : "";
    const methodOption = method === "POST" ? "-X POST" : "-X GET";
    const cmd = `curl -s -4 -m 10 ${methodOption} ${headers} -b "${COOKIE_FILE}" -c "${COOKIE_FILE}" -w "\n%{http_code}" ${dataOption} "${url}"`;
    const output = await execPromise(cmd);
    const lines = output.split("\n");
    const status = parseInt(lines[lines.length - 1].trim()) || 0;
    const body = lines.slice(0, lines.length - 1).join("\n");
    return { status, body };
  } catch (err: any) {
    return { status: 0, body: "" };
  }
}

function extractCsrfToken(html: string): string {
  let match = html.match(/name=["']_token["']\s+value=["']([^"']+)["']/i);
  if (match) return match[1];

  match = html.match(/value=["']([^"']+)["']\s+name=["']_token["']/i);
  if (match) return match[1];

  match = html.match(/content=["']([^"']+)["']\s+name=["']csrf-token["']/i);
  if (match) return match[1];

  match = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
  if (match) return match[1];

  return "";
}

interface IvasmsSession {
  isLoggedIn: boolean;
  lastLoginTry: number;
}

const ivasmsSession: IvasmsSession = {
  isLoggedIn: false,
  lastLoginTry: 0
};

async function loginToIvasms(): Promise<boolean> {
  const now = Date.now();
  if (now - ivasmsSession.lastLoginTry < 30000) {
    return ivasmsSession.isLoggedIn;
  }
  ivasmsSession.lastLoginTry = now;

  try {
    console.log("[iVasms] Attempting login to portal...");
    
    if (fs.existsSync(COOKIE_FILE)) {
      try { fs.unlinkSync(COOKIE_FILE); } catch {}
    }

    const loginPageUrl = "https://ivas.tempnum.qzz.io/login";
    const getRes = await runCurlWithProxyAndCookies(loginPageUrl, "GET");

    if (getRes.status !== 200) {
      console.log(`[iVasms] Initial check response: ${getRes.status}`);
      return false;
    }

    const token = extractCsrfToken(getRes.body);
    if (!token) {
      console.log("[iVasms] Token empty on login page");
      return false;
    }

    const params = new URLSearchParams();
    params.append("_token", token);
    params.append("username", "MAFYA123");
    params.append("email", "MAFYA123");
    params.append("password", "Bn_1411");

    const postRes = await runCurlWithProxyAndCookies(loginPageUrl, "POST", params.toString());

    if (postRes.status === 302 || postRes.status === 200) {
      console.log("[iVasms] Login successful.");
      ivasmsSession.isLoggedIn = true;
      return true;
    } else {
      console.log(`[iVasms] Status update: ${postRes.status}`);
      return false;
    }
  } catch (err: any) {
    console.log("[iVasms] Login update:", err.message);
    return false;
  }
}

function parseIvasmsResponse(text: string): any[] {
  if (!text) return [];
  
  try {
    const data = JSON.parse(text);
    let list: any[] = [];
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.data)) list = data.data;
    else if (data && Array.isArray(data.result)) list = data.result;
    
    if (list.length > 0) {
      return list.map((item: any) => {
        const number = String(item.number || item.num || item.to || "").trim();
        const sender = String(item.sender || item.cli || item.from || "Unknown");
        const message = String(item.message || item.sms || item.text || "");
        const dateStr = String(item.date || item.timestamp || item.created_at || "");
        const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
        return {
          timestamp,
          number,
          service: detectServiceFromMessageAndSender(sender, message),
          message,
          country: getCountryFromNumber(number),
          source: "iVasms"
        };
      }).filter((o: any) => o && o.number);
    }
  } catch {
    // Treat as HTML
  }

  const otps: any[] = [];
  const phoneRegex = /\+?[0-9]{9,15}/g;
  const rows = text.split(/<\/tr>|<\/div>/i);
  for (const row of rows) {
    const numbers = row.match(phoneRegex);
    if (numbers && numbers.length > 0) {
      const number = numbers[0];
      const cleanRow = row.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (cleanRow.length > number.length + 10) {
        const message = cleanRow.replace(number, "").trim();
        const service = detectServiceFromMessageAndSender("Unknown", message);
        otps.push({
          timestamp: new Date().toISOString(),
          number,
          service,
          message,
          country: getCountryFromNumber(number),
          source: "iVasms"
        });
      }
    }
  }
  return otps;
}

let cachedIvasSms: any[] = [];
let lastIvasSmsFetchTime = 0;
const IVAS_SMS_CACHE_TTL = 30 * 1000; // 30 seconds

async function fetchIvasmsSms(): Promise<any[]> {
  const now = Date.now();
  if (cachedIvasSms.length > 0 && now - lastIvasSmsFetchTime < IVAS_SMS_CACHE_TTL) {
    return cachedIvasSms;
  }

  try {
    if (!ivasmsSession.isLoggedIn) {
      const loggedIn = await loginToIvasms();
      if (!loggedIn) {
        return cachedIvasSms.length > 0 && now - lastIvasSmsFetchTime < 5 * 60 * 1000 ? cachedIvasSms : [];
      }
    }

    const getsmsUrl = "https://ivas.tempnum.qzz.io/portal/sms/received/getsms";
    const res = await runCurlWithProxyAndCookies(getsmsUrl, "GET");

    if (res.status === 401 || res.status === 403 || res.body.includes("/login") || res.body.includes("Redirecting to")) {
      console.log("[iVasms] Session expired or redirected. Re-logging in...");
      ivasmsSession.isLoggedIn = false;
      const loggedIn = await loginToIvasms();
      if (!loggedIn) {
        return cachedIvasSms.length > 0 && now - lastIvasSmsFetchTime < 5 * 60 * 1000 ? cachedIvasSms : [];
      }
      
      const retryRes = await runCurlWithProxyAndCookies(getsmsUrl, "GET");
      const parsed = parseIvasmsResponse(retryRes.body);
      if (parsed && parsed.length > 0) {
        cachedIvasSms = parsed;
        lastIvasSmsFetchTime = Date.now();
        return parsed;
      }
    } else {
      const parsed = parseIvasmsResponse(res.body);
      if (parsed && parsed.length > 0) {
        cachedIvasSms = parsed;
        lastIvasSmsFetchTime = Date.now();
        return parsed;
      }
    }

    if (cachedIvasSms.length > 0 && now - lastIvasSmsFetchTime < 5 * 60 * 1000) {
      return cachedIvasSms;
    }
    return [];
  } catch (err: any) {
    console.log("[iVasms] Fetch update:", err.message);
    if (cachedIvasSms.length > 0 && now - lastIvasSmsFetchTime < 5 * 60 * 1000) {
      return cachedIvasSms;
    }
    return [];
  }
}

async function fetchWithTimeout(url: string, options: any = {}, timeout = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function fetchNewApiSms(url: string, token: string, label: string): Promise<any[]> {
  try {
    const finalUrl = `${url}?token=${encodeURIComponent(token)}&key=${encodeURIComponent(token)}`;
    const response = await fetchWithTimeout(finalUrl, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Token": token,
        "Key": token,
        "X-API-KEY": token
      }
    });
    if (!response.ok) {
      console.log(`[${label}] Response not OK: ${response.status}`);
      return perSourceSmsCache[label] || [];
    }
    
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      console.log(`[${label}] Response is not valid JSON: ${text.slice(0, 100)}`);
      return perSourceSmsCache[label] || [];
    }
    
    let list: any[] = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.data)) {
      list = data.data;
    } else if (data && Array.isArray(data.result)) {
      list = data.result;
    } else if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) {
        if (Array.isArray(data[k])) {
          list = data[k];
          break;
        }
      }
    }
    
    const mapped = list.map((item: any) => {
      if (Array.isArray(item)) {
        const sender = String(item[0] || "Unknown");
        const number = String(item[1] || "").trim();
        const message = String(item[2] || "");
        const dateStr = String(item[3] || "");
        const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
        return {
          timestamp,
          number,
          service: detectServiceFromMessageAndSender(sender, message),
          message,
          country: getCountryFromNumber(number),
          source: label
        };
      } else if (item && typeof item === 'object') {
        const number = String(item.num || item.number || item.to || "").trim();
        const sender = String(item.cli || item.sender || item.from || "Unknown");
        const message = String(item.sms || item.message || item.text || "");
        const dateStr = String(item.dateadded || item.date || item.timestamp || item.created_at || "");
        const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
        return {
          timestamp,
          number,
          service: detectServiceFromMessageAndSender(sender, message),
          message,
          country: getCountryFromNumber(number),
          source: label
        };
      }
      return null;
    }).filter((o: any) => o && o.number);
    
    perSourceSmsCache[label] = mapped;
    return mapped;
  } catch (err) {
    console.log(`Error fetching from ${label}:`, err);
    return perSourceSmsCache[label] || [];
  }
}

async function fetchApi3Sms(): Promise<any[]> {
  try {
    const url = "https://pscall.net/restapi/smsreport";
    const key = "SFNYSj1SS16DgYdyf4KIgA==";
    const finalUrl = `${url}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(key)}`;
    const response = await fetchWithTimeout(finalUrl, {
      headers: {
        "Authorization": `Bearer ${key}`,
        "X-API-KEY": key,
        "Key": key,
        "Token": key
      }
    });
    if (!response.ok) {
      console.log(`[API 3] Response not OK: ${response.status}`);
      return perSourceSmsCache["API 3"] || [];
    }
    
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      console.log(`[API 3] Response is not valid JSON: ${text.slice(0, 100)}`);
      return perSourceSmsCache["API 3"] || [];
    }
    
    let list: any[] = [];
    if (data && Array.isArray(data.data)) {
      list = data.data;
    } else if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.result)) {
      list = data.result;
    }
    
    const mapped = list.map((item: any) => {
      const number = String(item.num || item.number || "").trim();
      const sender = String(item.cli || item.sender || "Unknown");
      const message = String(item.sms || item.message || "");
      const dateStr = String(item.dateadded || item.date || "");
      const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
      return {
        timestamp,
        number,
        service: detectServiceFromMessageAndSender(sender, message),
        message,
        country: getCountryFromNumber(number),
        source: "API 3"
      };
    }).filter(o => o.number);
    
    perSourceSmsCache["API 3"] = mapped;
    return mapped;
  } catch (err) {
    console.log("Error fetching from API 3:", err);
    return perSourceSmsCache["API 3"] || [];
  }
}

const FALLBACK_AUTO_NUMBERS: any[] = [];

// Helper to get all active subscriber numbers currently waiting for OTP
function getActiveSubscribersNumbers(): string[] {
  const db = readDb();
  const active: string[] = [];
  db.users.forEach((user: any) => {
    (user.subscribers || []).forEach((sub: any) => {
      (sub.numbers || []).forEach((numObj: any) => {
        const rawNum = String(numObj.number || numObj.num || "").trim();
        if (rawNum) {
          active.push(rawNum);
        }
      });
    });
  });
  return Array.from(new Set(active));
}

// Helper to parse numbers list from API response
// Parse aaData-format numbers response (Junaid API shape)
// Row layout: [timestamp, country, phone, service, message, ...]
function parseJunaidNumbers(text: string, label: string): any[] {
  try {
    const data = JSON.parse(text);
    const list: any[] = (data && Array.isArray(data.aaData)) ? data.aaData : [];
    const results: any[] = [];
    for (const item of list) {
      if (!Array.isArray(item)) continue;
      const country = String(item[1] || "Unknown");
      const number  = String(item[2] || "").trim();
      // Only accept purely numeric strings of ≥7 digits (phone numbers)
      if (!number || !/^\d{7,}$/.test(number)) continue;
      results.push({
        number,
        raw: number,
        e164: number,
        country: country === "Unknown" ? getCountryFromNumber(number) : country,
        source: label
      });
    }
    return results;
  } catch {
    return [];
  }
}

function parseNumbersList(text: string, label: string): any[] {
  try {
    const data = JSON.parse(text);
    let list: any[] = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.numbers)) {
      list = data.numbers;
    } else if (data && Array.isArray(data.data)) {
      list = data.data;
    } else if (data && typeof data === "object") {
      for (const k of Object.keys(data)) {
        if (Array.isArray(data[k])) {
          list = data[k];
          break;
        }
      }
    }

    return list.map((item: any) => {
      let numStr = "";
      let country = "";
      if (typeof item === "string") {
        numStr = item.trim();
        country = getCountryFromNumber(numStr);
      } else if (item && typeof item === "object") {
        numStr = String(item.number || item.num || item.phone || "").trim();
        country = String(item.country || getCountryFromNumber(numStr));
      }
      if (!numStr) return null;

      return {
        number: numStr,
        raw: numStr,
        e164: numStr,
        country: country === "Unknown" ? getCountryFromNumber(numStr) : country,
        source: label
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// Helper to parse SMS list from API response
function parseSmsList(text: string, label: string): any[] {
  try {
    const data = JSON.parse(text);
    let list: any[] = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.sms)) {
      list = data.sms;
    } else if (data && Array.isArray(data.data)) {
      list = data.data;
    } else if (data && Array.isArray(data.result)) {
      list = data.result;
    } else if (data && typeof data === "object") {
      for (const k of Object.keys(data)) {
        if (Array.isArray(data[k])) {
          list = data[k];
          break;
        }
      }
    }

    return list.map((item: any) => {
      if (!item) return null;
      let number = "";
      let sender = "Unknown";
      let message = "";
      let dateStr = "";

      if (Array.isArray(item)) {
        sender = String(item[0] || "Unknown");
        number = String(item[1] || "").trim();
        message = String(item[2] || "");
        dateStr = String(item[3] || "");
      } else if (typeof item === "object") {
        number = String(item.number || item.num || item.to || "").trim();
        sender = String(item.sender || item.cli || item.from || "Unknown");
        message = String(item.message || item.sms || item.text || "");
        dateStr = String(item.date || item.timestamp || item.created_at || item.dateadded || "");
      }

      if (!number) return null;

      const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
      return {
        timestamp,
        number,
        service: detectServiceFromMessageAndSender(sender, message),
        message,
        country: getCountryFromNumber(number),
        source: label
      };
    }).filter((o: any) => o && o.number);
  } catch {
    return [];
  }
}

async function fetchAggregatedNumbers(targetCountry?: string, force = false) {
  const db = readDb();
  const claimed = db.claimedNumbers || [];
  const manual = db.manualNumbers || [];
  
  const now = Date.now();
  const shouldFetchExt = force || cachedNumbers.length === 0 || (now - lastNumbersFetchTime > NUMBERS_CACHE_TTL) || !!targetCountry;
  if (shouldFetchExt) {
    const apiLists: any[] = [];
    
    // Process each API endpoint configuration in parallel
    const promises = API_ENDPOINTS.map(async (api) => {
      if (!backgroundApiStats[api.label]) {
        backgroundApiStats[api.label] = { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "", url: api.sms };
      }
      const endpointsToTry = [api.numbers, ...(api.fallbackNumbers || [])];
      let numbersSuccess = false;
      let lastErrMessage = "";
      const currentApiLists: any[] = [];

      for (const url of endpointsToTry) {
        if (numbersSuccess) break;
        try {
          const res = await fetchWithTimeout(url, {}, 3000);
          if (res.ok) {
            const text = await res.text();
            const parsed = parseNumbersList(text, api.label);
            if (parsed && parsed.length > 0) {
              currentApiLists.push(...parsed);
              numbersSuccess = true;
            } else {
              lastErrMessage = "Empty or invalid response format";
            }
          } else {
            lastErrMessage = `HTTP ${res.status}`;
          }
        } catch (err: any) {
          lastErrMessage = err.message || "Timeout";
        }
      }

      if (numbersSuccess) {
        backgroundApiStats[api.label].success++;
        backgroundApiStats[api.label].lastStatus = "Online";
        backgroundApiStats[api.label].lastSuccessTime = new Date().toISOString();
        backgroundApiStats[api.label].lastError = "";
      } else {
        backgroundApiStats[api.label].fail++;
        backgroundApiStats[api.label].lastStatus = "Offline";
        backgroundApiStats[api.label].lastError = lastErrMessage || "Failed to fetch numbers";
      }

      // 2. Fetch target country specific numbers by appending country or querying country in parallel
      if (targetCountry) {
        const formatsToTry = Array.from(new Set([targetCountry, targetCountry.toLowerCase()]));
        const countryUrls: string[] = [];
        for (const baseUrl of endpointsToTry) {
          const urlWithoutQuery = baseUrl.split("?")[0];
          for (const countryVal of formatsToTry) {
            countryUrls.push(`${urlWithoutQuery}/${encodeURIComponent(countryVal)}`);
            countryUrls.push(`${baseUrl}${baseUrl.includes("?") ? "&" : "?"}country=${encodeURIComponent(countryVal)}`);
          }
        }

        const uniqueCountryUrls = Array.from(new Set(countryUrls));
        const countryPromises = uniqueCountryUrls.slice(0, 5).map(async (url) => {
          try {
            const res = await fetchWithTimeout(url, {}, 2500);
            if (res.ok) {
              const text = await res.text();
              return parseNumbersList(text, api.label);
            }
          } catch {}
          return [];
        });

        try {
          const countryResults = await Promise.all(countryPromises);
          for (const list of countryResults) {
            if (list && list.length > 0) {
              currentApiLists.push(...list);
            }
          }
        } catch {}
      }

      return currentApiLists;
    });

    const results = await Promise.all(promises);
    for (const list of results) {
      if (list && list.length > 0) {
        apiLists.push(...list);
      }
    }

    // 3. Extract active numbers from iVasms portal messages to populate virtual numbers pool automatically
    try {
      console.log("[iVasms] Extracting active numbers from portal messages...");
      const ivasSms = await fetchIvasmsSms();
      const ivasNumbers = ivasSms.map((s: any) => ({
        number: s.number,
        raw: s.number,
        e164: s.number,
        country: s.country,
        source: "iVasms"
      }));
      for (const n of ivasNumbers) {
        if (!apiLists.some((item: any) => item.number.replace(/[\s\-\+]/g, "") === n.number.replace(/[\s\-\+]/g, ""))) {
          apiLists.push(n);
        }
      }
    } catch (err: any) {
      console.log("iVasms numbers check:", err.message);
    }
    
    // 4. Fetch numbers from Junaid APIs (aaData format — separate from API_ENDPOINTS)
    for (const je of JUNAID_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(je.numbersUrl, {}, 4000);
        if (res.ok) {
          const text = await res.text();
          const parsed = parseJunaidNumbers(text, je.label);
          for (const n of parsed) {
            if (!apiLists.some((item: any) => item.number.replace(/[\s\-\+]/g, "") === n.number.replace(/[\s\-\+]/g, ""))) {
              apiLists.push(n);
            }
          }
          if (backgroundApiStats[je.label]) {
            backgroundApiStats[je.label].success++;
            backgroundApiStats[je.label].lastStatus = "Online";
            backgroundApiStats[je.label].lastSuccessTime = new Date().toISOString();
          }
        }
      } catch (err: any) {
        if (backgroundApiStats[je.label]) {
          backgroundApiStats[je.label].fail++;
          backgroundApiStats[je.label].lastStatus = "Offline";
          backgroundApiStats[je.label].lastError = err.message || "Timeout";
        }
      }
    }

    // Always combine fallback auto numbers so there are always options available
    const mappedFallbacks = FALLBACK_AUTO_NUMBERS.map(f => ({
      number: f.number,
      raw: f.number,
      e164: f.number,
      country: f.country,
      source: "System Automatic"
    }));

    cachedNumbers = [...apiLists, ...mappedFallbacks];
    lastNumbersFetchTime = now;
  }

  // Combine manual numbers from db and cached API numbers
  const combined = [
    ...manual.map((n: any) => ({
      number: n.number,
      raw: n.number,
      e164: n.number,
      country: n.country || getCountryFromNumber(n.number),
      source: n.server || "Manual"
    })),
    ...cachedNumbers
  ];

  // Filter out claimed/deleted numbers
  const filtered = combined.filter((n: any) => {
    const cleanNum = n.number.replace(/[\s\-\+]/g, "");
    return !claimed.includes(cleanNum);
  });

  return filtered;
}

async function fetchAggregatedSms(force = false) {
  const now = Date.now();
  
  if (force || cachedSms.length === 0 || now - lastSmsFetchTime > SMS_CACHE_TTL) {
    const db = readDb();
    // Tag every stored-db entry so forwarding loops can identify and block them.
    // These entries are kept in cache for display only — they must never be
    // re-forwarded to Telegram/WhatsApp as they are already stored history.
    let allOtps = (db.manualSms || []).map((s: any) => ({ ...s, _fromStoredDb: true }));
    allOtps = [...allOtps];

    const activeNumbers = getActiveSubscribersNumbers();

    // Fetch from all API endpoints in parallel
    const promises = API_ENDPOINTS.map(async (api) => {
      if (!backgroundApiStats[api.label]) {
        backgroundApiStats[api.label] = { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "", url: api.sms };
      }
      const smsEndpoints = [api.sms, ...(api.fallbackSms || [])];
      let smsSuccess = false;
      let lastErrMessage = "";
      const currentOtps: any[] = [];
  
      // 1. General fetch
      for (const url of smsEndpoints) {
        if (smsSuccess) break;
        try {
          const res = await fetchWithTimeout(url, {}, 3000);
          if (res.ok) {
            const text = await res.text();
            const parsed = parseSmsList(text, api.label);
            if (parsed && parsed.length > 0) {
              currentOtps.push(...parsed);
              smsSuccess = true;
            } else {
              lastErrMessage = "Empty or invalid response format";
            }
          } else {
            lastErrMessage = `HTTP ${res.status}`;
          }
        } catch (err: any) {
          lastErrMessage = err.message || "Timeout";
        }
      }

      if (smsSuccess) {
        backgroundApiStats[api.label].success++;
        backgroundApiStats[api.label].lastStatus = "Online";
        backgroundApiStats[api.label].lastSuccessTime = new Date().toISOString();
        backgroundApiStats[api.label].lastError = "";
      } else {
        backgroundApiStats[api.label].fail++;
        backgroundApiStats[api.label].lastStatus = "Offline";
        backgroundApiStats[api.label].lastError = lastErrMessage || "Failed to fetch SMS";
      }

      // 2. Fetch specifically for active/claimed subscriber numbers in parallel
      if (activeNumbers.length > 0) {
        const urlsToFetch: string[] = [];
        for (const rawNum of activeNumbers) {
          const cleanNum = rawNum.replace(/[\s\-\+]/g, "");
          const formattedWithPlus = rawNum.startsWith("+") ? rawNum : `+${rawNum}`;
          const formatsToTry = Array.from(new Set([cleanNum, formattedWithPlus, rawNum]));

          for (const numToQuery of formatsToTry) {
            for (const baseUrl of smsEndpoints) {
              const urlWithoutQuery = baseUrl.split("?")[0];
              urlsToFetch.push(`${urlWithoutQuery}/${encodeURIComponent(numToQuery)}`);
              urlsToFetch.push(`${baseUrl}${baseUrl.includes("?") ? "&" : "?"}number=${encodeURIComponent(numToQuery)}`);
              urlsToFetch.push(`${baseUrl}${baseUrl.includes("?") ? "&" : "?"}num=${encodeURIComponent(numToQuery)}`);
            }
          }
        }

        const uniqueUrls = Array.from(new Set(urlsToFetch));
        // Limit unique candidate requests per iteration to prevent too many parallel fetches
        const fetchPromises = uniqueUrls.slice(0, 5).map(async (url) => {
          try {
            const res = await fetchWithTimeout(url, {}, 2500);
            if (res.ok) {
              const text = await res.text();
              return parseSmsList(text, api.label);
            }
          } catch {
            // Ignore sub-query timeouts/errors silently
          }
          return [];
        });

        try {
          const results = await Promise.all(fetchPromises);
          for (const list of results) {
            if (list && list.length > 0) {
              currentOtps.push(...list);
            }
          }
        } catch {}
      }

      return currentOtps;
    });

    const results = await Promise.all(promises);
    for (const list of results) {
      if (list && list.length > 0) {
        allOtps.push(...list);
      }
    }

    // 3. Fetch from iVasms session-based portal
    try {
      console.log("[iVasms] Querying active SMS from portal...");
      const ivasSms = await fetchIvasmsSms();
      if (!backgroundApiStats["iVasms"]) {
        backgroundApiStats["iVasms"] = { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "", url: "Portal session-based extraction" };
      }
      if (ivasSms && ivasSms.length > 0) {
        allOtps.push(...ivasSms);
        backgroundApiStats["iVasms"].success++;
        backgroundApiStats["iVasms"].lastStatus = "Online";
        backgroundApiStats["iVasms"].lastSuccessTime = new Date().toISOString();
        backgroundApiStats["iVasms"].lastError = "";
      } else {
        backgroundApiStats["iVasms"].fail++;
        backgroundApiStats["iVasms"].lastStatus = "Offline";
        backgroundApiStats["iVasms"].lastError = "No active SMS found";
      }
    } catch (err: any) {
      console.log("iVasms SMS check:", err.message);
      if (!backgroundApiStats["iVasms"]) {
        backgroundApiStats["iVasms"] = { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "", url: "Portal session-based extraction" };
      }
      backgroundApiStats["iVasms"].fail++;
      backgroundApiStats["iVasms"].lastStatus = "Offline";
      backgroundApiStats["iVasms"].lastError = err.message || "Failed to fetch portal SMS";
    }

    // 4. Include Api 5 / Api 6 cached SMS (Junaid format — fetched by fast poller)
    //    API 7 results are already merged into cachedSms by the fast poller,
    //    so no separate include needed here. Only add these labeled caches for
    //    display purposes — the worker skips them via FAST_POLLER_SOURCES guard.
    for (const label of ["Api 5", "Api 6"]) {
      const cached = perSourceSmsCache[label];
      if (cached && cached.length > 0) {
        allOtps.push(...cached);
      }
    }

    // Sort by timestamp desc and de-duplicate by message text + number
    allOtps.sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
    
    const uniqueOtps: any[] = [];
    const seen = new Set<string>();
    for (const o of allOtps) {
      const key = `${o.number}_${o.message.slice(0, 30)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueOtps.push(o);
      }
    }

    cachedSms = uniqueOtps.slice(0, 100);
    lastSmsFetchTime = now;
  }

  return cachedSms;
}

// Bot offsets map
const botOffsets: { [token: string]: number } = {};
const BOT_OFFSETS_FILE = path.join(process.cwd(), "bot_offsets.json");

// Load persisted offsets on startup so restarts don't re-process old updates
try {
  if (fs.existsSync(BOT_OFFSETS_FILE)) {
    const raw = fs.readFileSync(BOT_OFFSETS_FILE, "utf8");
    const loaded = JSON.parse(raw);
    Object.assign(botOffsets, loaded);
    console.log("[BotOffsets] Loaded persisted offsets:", Object.keys(botOffsets).length, "bots");
  }
} catch (_) {}

function saveBotOffsets() {
  try { fs.writeFileSync(BOT_OFFSETS_FILE, JSON.stringify(botOffsets), "utf8"); } catch (_) {}
}
// ── Persistent forwarded-IDs: survive server restarts ─────────────────────────
// Stores the exact same key strings used during forwarding so no SMS is ever
// re-delivered after a restart (in-memory Set alone resets on every restart).
const FORWARDED_IDS_FILE = path.join(process.cwd(), "forwarded_ids.json");

function loadForwardedIds(): Set<string> {
  try {
    const raw = fs.readFileSync(FORWARDED_IDS_FILE, "utf8");
    const arr: string[] = JSON.parse(raw);
    return new Set(arr);
  } catch (_) {
    return new Set<string>();
  }
}

function saveForwardedIds(set: Set<string>) {
  try {
    // Keep only the newest 2000 entries to cap file size
    const arr = Array.from(set);
    const trimmed = arr.length > 2000 ? arr.slice(arr.length - 2000) : arr;
    fs.writeFileSync(FORWARDED_IDS_FILE, JSON.stringify(trimmed), "utf8");
  } catch (_) {}
}

let lastForwardedSmsIds = loadForwardedIds();
console.log(`[SMS-INIT] Loaded ${lastForwardedSmsIds.size} forwarded-ID entries from disk — restart-safe duplicate guard active`);

// Dynamic URL fallback helpers to isolate reseller bot branding from super-admin
function getPanelUrl(user: any) {
  if (user.botConfig?.botLink && user.botConfig.botLink.startsWith("http")) {
    return user.botConfig.botLink;
  }
  // Default fallback to applet's live preview URL
  return "https://ais-dev-rcchkwwyf6ddcladrjglj4-18318808268.asia-southeast1.run.app";
}

function getOtpUrl(user: any) {
  if (user.botConfig?.otpGroupUrl && user.botConfig.otpGroupUrl.startsWith("http")) {
    return user.botConfig.otpGroupUrl;
  }
  return "https://ais-dev-rcchkwwyf6ddcladrjglj4-18318808268.asia-southeast1.run.app";
}

// Keyboard Generator Helpers
function getMainKeyboard(user: any, targetChatId?: string | number) {
  const isChannelOrGroup = targetChatId ? String(targetChatId).startsWith("-") : false;

  const botLink = user?.botConfig?.botLink ? formatTelegramUrl(user.botConfig.botLink) : "";
  const otpGroupUrl = user?.botConfig?.otpGroupUrl ? formatTelegramUrl(user.botConfig.otpGroupUrl) : "";

  const keyboard: any[][] = [];

  if (isChannelOrGroup) {
    // For groups/channels, callback_data buttons are invalid/confusing.
    // Convert them to deep links if botLink is available, or omit them.
    const row1: any[] = [];
    if (botLink && botLink.startsWith("http")) {
      const cleanBotLink = botLink.split("?")[0];
      row1.push({ text: "📱 Get Number", url: `${cleanBotLink}?start=get_number` });
      row1.push({ text: "📦 My Numbers", url: `${cleanBotLink}?start=my_numbers` });
    }
    if (row1.length > 0) {
      keyboard.push(row1);
    }
    
    const extraRow: any[] = [];
    if (botLink && botLink.startsWith("http")) {
      extraRow.push({ text: "🤖 Panel Bot", url: botLink });
    }
    if (otpGroupUrl && otpGroupUrl.startsWith("http")) {
      extraRow.push({ text: "👁️ See OTP", url: otpGroupUrl });
    }
    if (extraRow.length > 0) {
      keyboard.push(extraRow);
    }
  } else {
    // Private chat, use standard callback buttons
    keyboard.push([
      { text: "📱 Get Number", callback_data: "btn_get_number" },
      { text: "📦 My Numbers", callback_data: "btn_my_numbers" }
    ]);
    keyboard.push([
      { text: "❓ Help", callback_data: "btn_help" }
    ]);

    const extraRow: any[] = [];
    if (botLink && botLink.startsWith("http")) {
      extraRow.push({ text: "🤖 Panel Bot", url: botLink });
    }
    if (otpGroupUrl && otpGroupUrl.startsWith("http")) {
      extraRow.push({ text: "👁️ See OTP", url: otpGroupUrl });
    }
    if (extraRow.length > 0) {
      keyboard.push(extraRow);
    }
  }

  return { inline_keyboard: keyboard };
}

function isSmsDuplicateForUser(user: any, numberClean: string, messageText: string): boolean {
  if (!user || !user.otpHistory || !Array.isArray(user.otpHistory)) {
    return false;
  }
  const now = Date.now();
  const normalizedMsg = messageText.trim().toLowerCase();

  return user.otpHistory.some((h: any) => {
    const hNumClean = (h.number || "").replace(/[\s\-\+]/g, "");
    const hMsg = (h.message || "").trim().toLowerCase();
    
    if (hNumClean === numberClean && hMsg === normalizedMsg) {
      const hTime = new Date(h.timestamp).getTime();
      if (!isNaN(hTime)) {
        const ageMs = now - hTime;
        // Check if duplicate is within 1 hour (3,600,000 ms)
        if (ageMs < 60 * 60 * 1000) {
          return true;
        }
      } else {
        return true; // Treat as duplicate if invalid timestamp to be safe
      }
    }
    return false;
  });
}

function maskPhoneNumber(num: string): string {
  const clean = num.replace(/[\s\-\+]/g, "");
  if (clean.length <= 6) return num;
  const start = clean.substring(0, 3);
  const end = clean.substring(clean.length - 4);
  return `${start}****${end}`;
}

function extractOtp(message: string): string {
  // 1. Hyphen-format OTP codes (e.g. 523-946, 478-714) — always real OTP
  const hyphenMatch = message.match(/\b\d{3}[-\s]\d{3,4}\b/);
  if (hyphenMatch) return hyphenMatch[0];
  // 2. G-format codes (Google: G-123456) — always real OTP
  const gMatch = message.match(/\b[Gg]-\d{5,8}\b/);
  if (gMatch) return gMatch[0];
  
  // 3. Fallback: Find any 4 to 8 digit number
  // If there are multiple, pick the first one that doesn't look like a year
  const digitMatches = message.match(/\b\d{4,8}\b/g);
  if (digitMatches) {
    const valid = digitMatches.filter(m => !/^(19|20)\d{2}$/.test(m));
    if (valid.length > 0) return valid[0];
  }
  
  // 4. Sometimes it's just alphanumeric code like A8F93J
  const alphaNumMatch = message.match(/\b[A-Z0-9]{5,8}\b/i);
  if (alphaNumMatch && /\d/.test(alphaNumMatch[0]) && /[a-zA-Z]/.test(alphaNumMatch[0])) {
    return alphaNumMatch[0];
  }
  
  return "PENDING";
}

function escapeTelegramHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramOtpMessage(otp: any, msg: string, service: string, country: string): string {
  const flag = getCountryFlag(country);
  const maskedNum = maskPhoneNumber(otp.number);
  const extractedOtp = extractOtp(msg);

  const escCountry = escapeTelegramHtml(country);
  const escService = escapeTelegramHtml(service);
  const escOtp = extractedOtp === "PENDING" ? "😺" : escapeTelegramHtml(extractedOtp);

  let text = `╭━━━━━━━━━━━━━━━━━━━━╮\n`;
  text += `┃ ${flag} ${escCountry} ${escService}\n`;
  text += `┃━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `┃☎ Number :  <code>${maskedNum}</code>\n`;
  text += `┃🔒 OTP :  <code>${escOtp}</code>\n`;
  text += `┃━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `┃📝 :\n`;
  
  const lines = msg.split("\n");
  for (const line of lines) {
    if (line.trim()) {
      const escapedLine = escapeTelegramHtml(line.trim());
      text += `┃ ${escapedLine}\n`;
    }
  }
  
  text += `╰━━━━━━━━━━━━━━━━━━━━╯`;
  return text;
}


async function getCountryKeyboard() {
  const activeNumbers = await fetchAggregatedNumbers();
  
  if (activeNumbers.length === 0) {
    return {
      inline_keyboard: [
        [{ text: "⚠️ No Countries Available", callback_data: "btn_main_menu" }],
        [{ text: "🏠 Main Menu", callback_data: "btn_main_menu" }]
      ]
    };
  }

  // Get unique countries and counts
  const counts: { [key: string]: number } = {};
  activeNumbers.forEach((n: any) => {
    const c = String(n.country || "Indonesia");
    counts[c] = (counts[c] || 0) + 1;
  });

  const uniqueCountries = Object.keys(counts);
  uniqueCountries.sort();

  const buttons: any[] = [];
  uniqueCountries.forEach((country) => {
    const flag = getCountryFlag(country);
    const count = counts[country];
    buttons.push({
      text: `${flag} ${country} [${count}]`,
      callback_data: `btn_country_${country}`
    });
  });

  const keyboard: any[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    const row: any[] = [buttons[i]];
    if (i + 1 < buttons.length) {
      row.push(buttons[i + 1]);
    }
    keyboard.push(row);
  }
  
  keyboard.push([{ text: "🏠 Main Menu", callback_data: "btn_main_menu" }]);
  
  return { inline_keyboard: keyboard };
}

function getNumberSessionKeyboard(user: any, country: string, number: string) {
  const keyboard: any[][] = [
    [
      { text: "🔄 Change Number", callback_data: `btn_country_${country}` },
      { text: "🌍 Change Country", callback_data: "btn_get_number" }
    ],
    [
      { text: "📋 Copy Number", callback_data: `btn_copy_${number}` }
    ],
    [
      { text: "📱 Get New Number", callback_data: "btn_get_number" },
      { text: "🏠 Main Menu", callback_data: "btn_main_menu" }
    ]
  ];

  const botLink = user?.botConfig?.botLink ? formatTelegramUrl(user.botConfig.botLink) : "";
  const otpGroupUrl = user?.botConfig?.otpGroupUrl ? formatTelegramUrl(user.botConfig.otpGroupUrl) : "";

  const extraRow: any[] = [];
  if (botLink && botLink.startsWith("http")) {
    extraRow.push({ text: "🤖 Panel Bot", url: botLink });
  }
  if (otpGroupUrl && otpGroupUrl.startsWith("http")) {
    extraRow.push({ text: "👁️ See OTP", url: otpGroupUrl });
  }
  if (extraRow.length > 0) {
    keyboard.push(extraRow);
  }

  return { inline_keyboard: keyboard };
}

function getHelpKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📱 Get Number", callback_data: "btn_get_number" },
        { text: "📦 My Numbers", callback_data: "btn_my_numbers" }
      ],
      [
        { text: "🏠 Main Menu", callback_data: "btn_main_menu" }
      ]
    ]
  };
}

// Centralized Telegram Request Executor with robust native fetch, retries and rate limit handling
async function runTelegramRequest(token: string, apiMethod: string, payload?: any): Promise<{ ok: boolean; result?: any }> {
  const cleanToken = (token || "").trim();
  const url = `https://api.telegram.org/bot${cleanToken}/${apiMethod}`;

  let lastParsedResponse: any = { ok: false };

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout

    try {
      const options: RequestInit = {
        method: payload !== undefined ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      };

      if (payload !== undefined) {
        options.body = JSON.stringify(payload);
      }

      const response = await fetch(url, options);
      clearTimeout(timeoutId);

      const text = await response.text();
      if (text && text.trim()) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.ok !== undefined) {
          // Handle rate limiting (429)
          if (parsed.ok === false && parsed.error_code === 429) {
            const retryAfter = parsed.parameters?.retry_after || 5;
            console.warn(`[Telegram API 429] Rate limited. Waiting ${retryAfter}s before retrying (attempt ${attempt + 1}/3)...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            lastParsedResponse = parsed;
            continue;
          }
          return parsed;
        }
      } else {
        console.warn(`[Telegram API] Direct attempt ${attempt + 1}/3 returned empty response body.`);
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isAbort = err.name === "AbortError";
      console.warn(`[Telegram API] Direct attempt ${attempt + 1}/3 failed or ${isAbort ? "timed out" : "errored"}: ${err.message || err}`);
      
      if (attempt < 2) {
        const delay = (attempt + 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Fallback log to help debug
  console.warn(`[Telegram API] All direct connection attempts failed. Returning last parsed response: ${JSON.stringify(lastParsedResponse)}`);
  return lastParsedResponse;
}

// Returns candidate chat IDs to try in order — handles missing - prefix for Telegram groups.
// Telegram supergroup IDs start with -100, regular groups with -.
// Users often forget the - prefix when pasting from Telegram.
function getTelegramChatIdCandidates(chatId: string | number): Array<string | number> {
  const id = String(chatId).trim();
  const candidates: Array<string | number> = [chatId];
  if (!id.startsWith("-")) {
    // Try -id (regular group) and -100id (supergroup) as fallbacks
    candidates.push(`-${id}`);
    candidates.push(`-100${id}`);
  } else if (id.startsWith("-") && !id.startsWith("-100") && id.length > 1) {
    // Has minus but no -100 prefix — try -100 variant (supergroup)
    candidates.push(`-100${id.slice(1)}`);
  }
  return candidates;
}

// Helper to send message via Telegram API
async function sendCustomTelegramMessage(token: string, chatId: string | number, text: string) {
  if (!token) return false;
  try {
    // Step 1: Try with HTML on the original chat ID first.
    const res = await runTelegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    });
    if (res && res.ok) {
      return res.result?.message_id || true;
    }

    const desc = (res?.description || "").toLowerCase();
    // Step 2: Only try alternate chat IDs for explicit chat-ID-resolution errors.
    // "Bad Request" alone is NOT a chat-ID error — it can indicate HTML parse failures,
    // text length issues, etc. Widening this causes valid messages to fail silently.
    const isChatIdError = desc.includes("chat not found") || desc.includes("chat_id_invalid");
    if (isChatIdError) {
      const candidates = getTelegramChatIdCandidates(chatId).slice(1); // skip original (already tried)
      for (const candidateId of candidates) {
        const altRes = await runTelegramRequest(token, "sendMessage", {
          chat_id: candidateId,
          text,
          parse_mode: "HTML"
        });
        if (altRes && altRes.ok) {
          return altRes.result?.message_id || true;
        }
        const altDesc = (altRes?.description || "").toLowerCase();
        if (!altDesc.includes("chat not found") && !altDesc.includes("chat_id_invalid")) {
          break; // Non-chat-ID error — stop trying alternate IDs
        }
      }
    }

    // Step 3: Plain-text fallback always targets the ORIGINAL chatId.
    // HTML parse errors must not route to a different (unverified) ID.
    console.warn(`HTML message failed to send to ${chatId} on token ${token.substring(0, 8)}. Retrying as plain text.`);
    const resRetry = await runTelegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: text.replace(/<[^>]*>/g, "")
    });
    if (resRetry && resRetry.ok) {
      return resRetry.result?.message_id || true;
    }
    return false;
  } catch (err: any) {
    console.error(`Error sending message on token ${token.substring(0, 8)} to ${chatId}:`, err);
    return false;
  }
}

// Helper to send message with custom Inline Keyboard Markup
function cleanReplyMarkup(replyMarkup: any) {
  if (!replyMarkup) return undefined;
  if (replyMarkup.inline_keyboard && Array.isArray(replyMarkup.inline_keyboard)) {
    const activeRows = replyMarkup.inline_keyboard.map((row: any) => {
      if (!Array.isArray(row)) return [];
      return row.filter((btn: any) => {
        if (!btn || typeof btn !== "object" || !btn.text) return false;
        // MUST have either url, callback_data, or other valid button action fields
        const hasUrl = btn.url && typeof btn.url === "string" && btn.url.trim().length > 0;
        const hasCallback = btn.callback_data !== undefined && btn.callback_data !== null && String(btn.callback_data).trim().length > 0;
        const hasWebApp = btn.web_app && typeof btn.web_app === "object";
        const hasLoginUrl = btn.login_url && typeof btn.login_url === "object";
        const hasSwitchInline = btn.switch_inline_query !== undefined;
        const hasSwitchInlineCurrent = btn.switch_inline_query_current_chat !== undefined;
        return hasUrl || hasCallback || hasWebApp || hasLoginUrl || hasSwitchInline || hasSwitchInlineCurrent;
      });
    }).filter((row: any) => row.length > 0);
    
    if (activeRows.length === 0) {
      return undefined;
    }
    return { inline_keyboard: activeRows };
  }
  return replyMarkup;
}

async function sendCustomTelegramMessageWithKeyboard(token: string, chatId: string | number, text: string, replyMarkup?: any) {
  if (!token) return false;
  try {
    const cleaned = cleanReplyMarkup(replyMarkup);

    // Step 1: Try with HTML + keyboard on the original chat ID.
    const body: any = { chat_id: chatId, text, parse_mode: "HTML" };
    if (cleaned) body.reply_markup = cleaned;
    let res = await runTelegramRequest(token, "sendMessage", body);
    if (res && res.ok) {
      return res.result?.message_id || true;
    }

    const desc = (res?.description || "").toLowerCase();
    // Step 2: Only try alternate chat IDs for explicit chat-ID-resolution errors.
    const isChatIdError = desc.includes("chat not found") || desc.includes("chat_id_invalid");
    if (isChatIdError) {
      const candidates = getTelegramChatIdCandidates(chatId).slice(1);
      for (const candidateId of candidates) {
        const altBody: any = { chat_id: candidateId, text, parse_mode: "HTML" };
        if (cleaned) altBody.reply_markup = cleaned;
        const altRes = await runTelegramRequest(token, "sendMessage", altBody);
        if (altRes && altRes.ok) {
          return altRes.result?.message_id || true;
        }
        const altDesc = (altRes?.description || "").toLowerCase();
        if (!altDesc.includes("chat not found") && !altDesc.includes("chat_id_invalid")) {
          break;
        }
      }
    }

    // Step 3: Plain-text fallback (no keyboard) always targets the ORIGINAL chatId.
    console.warn(`HTML message with keyboard failed to send to ${chatId}. Reason: ${JSON.stringify(res)}. Retrying as plain text with no keyboard fallback.`);
    const cleanText = text.replace(/<[^>]*>/g, "");
    const resRetry = await runTelegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: cleanText
    });
    if (resRetry && resRetry.ok) {
      return resRetry.result?.message_id || true;
    }
    return false;
  } catch (err: any) {
    console.error(`Error sending keyboard message on token ${token.substring(0, 8)} to ${chatId}:`, err);
    return false;
  }
}

// Helper to answer Telegram Callback Query popups
async function answerBotCallbackQuery(token: string, callbackQueryId: string, text?: string) {
  try {
    await runTelegramRequest(token, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || "",
      show_alert: text ? true : false
    });
  } catch (err) {
    console.error("Error answering callback query:", err);
  }
}

// Helper to update / edit existing message inline in real-time
async function editBotMessageText(token: string, chatId: string | number, messageId: number, text: string, replyMarkup?: any) {
  try {
    const body: any = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML"
    };
    const cleaned = cleanReplyMarkup(replyMarkup);
    if (cleaned) {
      body.reply_markup = cleaned;
    }
    let res = await runTelegramRequest(token, "editMessageText", body);
    if (res && res.ok) {
      return;
    }
    
    console.warn(`HTML message edit failed for ${chatId} / message ${messageId}. Retrying as plain text.`);
    body.text = text.replace(/<[^>]*>/g, "");
    delete body.parse_mode;
    await runTelegramRequest(token, "editMessageText", body);
  } catch (err) {
    console.error("Error editing message text:", err);
  }
}

function getServiceForSms(sms: any, user: any) {
  const numberClean = (sms.number || "").replace(/[\s\-\+]/g, "");
  const db = readDb();
  const manualNum = (db.manualNumbers || []).find((n: any) => n.number.replace(/[\s\-\+]/g, "") === numberClean);
  if (manualNum && manualNum.server) {
    return manualNum.server;
  }
  return sms.service || "All Services";
}

// Subscriber binder helper
function registerNumberForSubInDb(userId: string, chatId: number, number: string, country: string, messageId?: number, service?: string) {
  const db = readDb();
  const userIdx = db.users.findIndex((u: any) => u.id === userId);
  if (userIdx === -1) return;

  const user = db.users[userIdx];
  if (!user.subscribers) user.subscribers = [];

  const subIdx = user.subscribers.findIndex((s: any) => s.chatId === chatId);
  const now = new Date().toISOString();
  const formattedNum = number.replace(/[\s\-]/g, "");

  if (subIdx !== -1) {
    const hasNum = user.subscribers[subIdx].numbers.some(
      (n: any) => n.number.replace(/[\s\-]/g, "") === formattedNum
    );
    if (!hasNum) {
      if (!user.subscribers[subIdx].numbers) user.subscribers[subIdx].numbers = [];
      user.subscribers[subIdx].numbers.push({ number, country, service, registeredAt: now, messageId });
    }
  } else {
    user.subscribers.push({
      chatId,
      username: "Simulated_User",
      firstName: "User_" + chatId,
      registeredAt: now,
      numbers: [{ number, country, service, registeredAt: now, messageId }]
    });
  }
  writeDb(db);
}

// Handle Bot Commands and Button Interactions (Inline & Text)
async function handleBotUpdate(userId: string, token: string, update: any) {
  const db = readDb();
  const userIdx = db.users.findIndex((u: any) => u.id === userId);
  if (userIdx === -1) return;

  const user = db.users[userIdx];
  if (!user.subscribers) user.subscribers = [];

  // 1. HANDLE BUTTON CALLBACKS (Inline Interactive Mode)
  if (update.callback_query) {
    const cbQuery = update.callback_query;
    const chatId = cbQuery.message?.chat?.id;
    const messageId = cbQuery.message?.message_id;
    const data = cbQuery.data || "";
    const username = cbQuery.from.username || "";
    const firstName = cbQuery.from.first_name || "User";

    // Register active subscriber session
    let subIdx = user.subscribers.findIndex((s: any) => s.chatId === chatId);
    if (subIdx === -1) {
      user.subscribers.push({
        chatId,
        username: username || "",
        firstName,
        registeredAt: new Date().toISOString(),
        numbers: []
      });
      writeDb(db);
    }

    // Acknowledge the callback immediately to clear the loading spinner
    await answerBotCallbackQuery(token, cbQuery.id);

    // Handle button routing
    if (data === "btn_main_menu") {
      const textMsg = `🤖 TEAM ZERO SMS PANEL\n\n👋 Welcome, ${firstName}!\n\nGet virtual numbers and receive OTPs instantly.\n\nChoose an option:`;
      await editBotMessageText(token, chatId, messageId, textMsg, getMainKeyboard(user, chatId));
      return;
    }

    if (data === "btn_get_number") {
      const textMsg = `🌍 SELECT COUNTRY\n\nChoose a country:`;
      await editBotMessageText(token, chatId, messageId, textMsg, await getCountryKeyboard());
      return;
    }

    if (data.startsWith("btn_country_")) {
      const country = data.substring(12);
      // Cached numbers use karo (no forced fresh fetch) — fast response ensures
      // Telegram callback doesn't timeout. Background workers refresh cache regularly.
      const numbersList = await fetchAggregatedNumbers();
      const countryLines = numbersList.filter((n: any) => 
        String(n.country || "").trim().toLowerCase() === country.trim().toLowerCase()
      );

      if (countryLines.length === 0) {
        await editBotMessageText(token, chatId, messageId, `⚠️ No active lines available for ${country} in our pipeline. Tap below to choose another country.`, {
          inline_keyboard: [
            [{ text: "🌍 Select Another Country", callback_data: "btn_get_number" }],
            [{ text: "🏠 Main Menu", callback_data: "btn_main_menu" }]
          ]
        });
        return;
      }

      const randomLine = countryLines[Math.floor(Math.random() * countryLines.length)];
      const displayNum = randomLine.number;
      const actualService = randomLine.server || randomLine.source || "All Services";

      // Register the number with the subscriber and immediately claim/delete it
      registerNumberForSubInDb(userId, chatId, displayNum, country, messageId, actualService);
      claimNumberInDb(displayNum);

      const flag = getCountryFlag(country);
      const serviceName = actualService;

      const textMsg = `🌍 <b>Country:</b> ${country} ${flag}\n🔌 <b>Service:</b> ${serviceName}\n\n☎ <b>Number:</b> <code>${displayNum}</code>\n\n⌛ <b>Waiting for OTP...</b>`;
      await editBotMessageText(token, chatId, messageId, textMsg, getNumberSessionKeyboard(user, country, displayNum));
      return;
    }

    if (data.startsWith("btn_num_")) {
      const numId = data.substring(8);
      const db = readDb();
      const manual = db.manualNumbers || [];
      const selectedLine = manual.find((n: any) => n.id === numId);

      if (!selectedLine) {
        await editBotMessageText(token, chatId, messageId, `⚠️ This line is no longer available. Tap below to choose another.`, {
          inline_keyboard: [
            [{ text: "🌍 Select Country", callback_data: "btn_get_number" }],
            [{ text: "🏠 Main Menu", callback_data: "btn_main_menu" }]
          ]
        });
        return;
      }

      const displayNum = selectedLine.number;
      const country = selectedLine.country || "Indonesia";
      const actualService = selectedLine.server || selectedLine.source || "All Services";

      // Register the number with the subscriber and immediately claim/delete it
      registerNumberForSubInDb(userId, chatId, displayNum, country, messageId, actualService);
      claimNumberInDb(displayNum);

      const flag = getCountryFlag(country);
      const serviceName = actualService;

      const textMsg = `🌍 <b>Country:</b> ${country} ${flag}\n🔌 <b>Service:</b> ${serviceName}\n\n☎ <b>Number:</b> <code>${displayNum}</code>\n\n⌛ <b>Waiting for OTP...</b>`;
      await editBotMessageText(token, chatId, messageId, textMsg, getNumberSessionKeyboard(user, country, displayNum));
      return;
    }

    if (data.startsWith("btn_copy_")) {
      const numToCopy = data.substring(9);
      await answerBotCallbackQuery(token, cbQuery.id, `📋 Copied Number: ${numToCopy}`);
      return;
    }

    if (data === "btn_my_numbers") {
      const subObj = user.subscribers.find((s: any) => s.chatId === chatId);
      const activeLines = subObj ? (subObj.numbers || []) : [];

      if (activeLines.length === 0) {
        const textMsg = `📦 Your Active Numbers\n\nYou do not have any virtual lines registered yet. Click "Get Number" to obtain one!`;
        await editBotMessageText(token, chatId, messageId, textMsg, {
          inline_keyboard: [
            [{ text: "📱 Get Number", callback_data: "btn_get_number" }],
            [{ text: "🏠 Main Menu", callback_data: "btn_main_menu" }]
          ]
        });
      } else {
        let textMsg = `📦 Your Active Numbers & OTP Records\n\n`;
        activeLines.slice(-5).forEach((n: any, idx: number) => {
          textMsg += `🔹 ${idx + 1}. \`${n.number}\` (${n.country}) - Registered: ${new Date(n.registeredAt).toLocaleTimeString()}\n`;
        });
        textMsg += `\nIncoming messages will automatically trigger instant flash-alerts here!`;
        await editBotMessageText(token, chatId, messageId, textMsg, {
          inline_keyboard: [
            [{ text: "📱 Get New Number", callback_data: "btn_get_number" }],
            [{ text: "🏠 Main Menu", callback_data: "btn_main_menu" }]
          ]
        });
      }
      return;
    }

    if (data === "btn_help") {
      const textMsg = `❓ COMMANDS & HELP\n\n` +
        `• \`/get_number\` — Request virtual number\n` +
        `• \`/info\` — Contact owners\n\n` +
        `How it works:\n` +
        `1️⃣ Tap Get Number below\n` +
        `2️⃣ Choose a country queue\n` +
        `3️⃣ Register with the provided temp number\n` +
        `4️⃣ Incoming OTP arrives here automatically! ⚡`;
      await editBotMessageText(token, chatId, messageId, textMsg, getHelpKeyboard());
      return;
    }

    return;
  }

  // 2. HANDLE RAW TEXT COMMANDS (Standard Keyboard / CLI Mode)
  if (!update.message) return;
  const chatId = update.message.chat.id;
  const text = (update.message.text || "").trim();
  const username = update.message.from.username || "";
  const firstName = update.message.from.first_name || "User";

  // Ensure subscriber session is registered
  let subIdx = user.subscribers.findIndex((s: any) => s.chatId === chatId);
  if (subIdx === -1) {
    user.subscribers.push({
      chatId,
      username: username || "",
      firstName,
      registeredAt: new Date().toISOString(),
      numbers: []
    });
    writeDb(db);
  } else {
    user.subscribers[subIdx].username = username || user.subscribers[subIdx].username;
    user.subscribers[subIdx].firstName = firstName || user.subscribers[subIdx].firstName;
    writeDb(db);
  }

  const cleanText = text.toLowerCase();
  const ownerIdStr = String(user.botConfig?.ownerChatId || "").trim();
  const isOwner = String(chatId).trim() === ownerIdStr;

  // Owner broadcast command
  if (cleanText.startsWith("/broadcast")) {
    if (!isOwner) {
      await sendCustomTelegramMessage(token, chatId, "⚠️ You are not authorized to run the /broadcast command on this bot.");
      return;
    }
    const messageToBroadcast = text.substring(10).trim();
    if (!messageToBroadcast) {
      await sendCustomTelegramMessage(token, chatId, "⚠️ Usage: /broadcast <your message>");
      return;
    }

    let successCount = 0;
    const subs = user.subscribers || [];
    for (const sub of subs) {
      const ok = await sendCustomTelegramMessage(token, sub.chatId, `📢 Announcement from Bot Admin:\n\n${messageToBroadcast}`);
      if (ok) successCount++;
    }

    await sendCustomTelegramMessage(token, chatId, `✅ Broadcast complete!\nSent to ${successCount} of ${subs.length} subscribers.`);
    return;
  }

  // Command handlers
  if (cleanText.startsWith("/start")) {
    const textMsg = `🤖 TEAM ZERO SMS PANEL\n\n👋 Welcome, ${firstName}!\n\nGet virtual numbers and receive OTPs instantly.\n\nChoose an option:`;
    await sendCustomTelegramMessageWithKeyboard(token, chatId, textMsg, getMainKeyboard(user, chatId));
  } else if (cleanText.startsWith("/info")) {
    const contactOwner = user.botConfig?.botLink ? `🌐 Owner Contact: ${user.botConfig.botLink}\n` : "";
    const officialChan = user.botConfig?.otpGroupUrl ? `📢 Official Channel: ${user.botConfig.otpGroupUrl}\n` : "";
    
    await sendCustomTelegramMessage(
      token,
      chatId,
      `ℹ️ Information & Links\n\n` +
      contactOwner +
      officialChan +
      `Contact us for premium virtual lines and support.`
    );
  } else if (cleanText.startsWith("/get_number") || cleanText.startsWith("/getnumber")) {
    const numbersList = await fetchAggregatedNumbers();
    if (numbersList.length === 0) {
      await sendCustomTelegramMessage(
        token,
        chatId,
        `⚠️ Sorry! No numbers are currently available in the aggregation queue. Try again later.`
      );
      return;
    }
    const random = numbersList[Math.floor(Math.random() * numbersList.length)];
    const displayNum = random.number;
    const flag = getCountryFlag(random.country);
    const serviceName = "All Services";

    const textMsg = `🌍 <b>Country:</b> ${random.country} ${flag}\n🔌 <b>Service:</b> ${serviceName}\n\n☎ <b>Number:</b> <code>${displayNum}</code>\n\n⌛ <b>Waiting for OTP...</b>`;

    const sentMessageId = await sendCustomTelegramMessage(
      token,
      chatId,
      textMsg
    );

    // Register the number with the subscriber (with message ID) and immediately claim/delete it
    registerNumberForSubInDb(userId, chatId, displayNum, random.country, typeof sentMessageId === "number" ? sentMessageId : undefined);
    claimNumberInDb(displayNum);

  } else {
    const textMsg = `🤖 TEAM ZERO SMS PANEL\n\n👋 Welcome, ${firstName}!\n\nGet virtual numbers and receive OTPs instantly.\n\nChoose an option:`;
    await sendCustomTelegramMessageWithKeyboard(token, chatId, textMsg, getMainKeyboard(user, chatId));
  }
}

const activeBotPollers = new Set<string>();

async function pollSingleTelegramBot(userId: string, token: string) {
  if (isPollingPaused) {
    setTimeout(() => pollSingleTelegramBot(userId, token), 2000);
    return;
  }

  let hasUpdates = false;
  let continuePolling = true;

  try {
    // Reload DB to get freshest configurations
    const db = readDb();
    const user = db.users.find((u: any) => u.id === userId);
    
    // If user doesn't exist, botConfig has changed or status is paused/inactive, stop polling for this token
    if (!user || !user.botConfig || user.botConfig.token !== token || user.botConfig.status === "paused") {
      activeBotPollers.delete(token);
      continuePolling = false;
      return;
    }

    const lastUpdateId = botOffsets[token] || 0;
    const data = await runTelegramRequest(token, "getUpdates", {
      offset: lastUpdateId + 1,
      // Telegram long polling is instant for new messages but avoids a tight
      // 250ms request loop that causes 429s and makes tokens appear unstable.
      timeout: 10,
      allowed_updates: ["message", "callback_query"]
    });
    if (data?.error_code === 401) {
      // Invalid/revoked tokens must not be hammered every 250ms. Keep the
      // saved token visible so the owner can replace it from the panel.
      console.warn(`[TG] Token rejected for user ${userId}; pausing this bot until its config changes.`);
      user.botConfig.status = "paused";
      writeDb(db);
      activeBotPollers.delete(token);
      continuePolling = false;
    } else if (data && data.ok && data.result && Array.isArray(data.result)) {
      if (data.result.length > 0) {
        hasUpdates = true;
        for (const update of data.result) {
          botOffsets[token] = update.update_id;
          await handleBotUpdate(userId, token, update);
        }
        // Persist offsets after every batch so restarts don't duplicate messages
        saveBotOffsets();
      }
    }
  } catch (err) {
    console.error(`Error polling telegram bot for user ${userId}:`, err);
  } finally {
    if (continuePolling) {
      // Minimum 150ms delay even with updates — prevents 429 rate-limit hammering.
      // Long-poll timeout=10 already handles instant delivery on new messages.
      const delay = hasUpdates ? 150 : 500;
      setTimeout(() => pollSingleTelegramBot(userId, token), delay);
    }
  }
}

// Delete any existing Telegram webhook so getUpdates (polling) can work.
// If a webhook is set, getUpdates returns 409 Conflict and no messages arrive.
async function deleteWebhookForBot(token: string): Promise<void> {
  try {
    const res = await runTelegramRequest(token, "deleteWebhook", { drop_pending_updates: false });
    if (res && res.ok) {
      console.log(`[TG-WEBHOOK] ✅ Webhook deleted for bot ...${token.slice(-8)} — polling mode active`);
    }
  } catch (err: any) {
    console.warn(`[TG-WEBHOOK] Could not delete webhook for bot ...${token.slice(-8)}:`, err?.message);
  }
}

// Telegram Worker: Multi-bot polling coordinator supporting independent parallel pollers
async function pollAllTelegramBots() {
  if (isPollingPaused) {
    if (!process.env.VERCEL) {
      setTimeout(pollAllTelegramBots, 5000);
    }
    return;
  }

  try {
    const db = readDb();
    const users = db.users || [];

    for (const user of users) {
      const token = user.botConfig?.token;
      if (token && user.botConfig?.status !== "paused") {
        if (!activeBotPollers.has(token)) {
          activeBotPollers.add(token);
          // ── Delete any existing webhook FIRST so polling works properly ──────
          // Webhook + polling cannot coexist; if webhook is set, getUpdates
          // returns 409 Conflict and NO messages are received via polling.
          deleteWebhookForBot(token).then(() => {
            // Spin up independent fast polling loop for this bot
            pollSingleTelegramBot(user.id, token);
          }).catch(() => {
            pollSingleTelegramBot(user.id, token);
          });
        }
      }
    }
  } catch (err) {
    console.error("Error coordinating telegram bot pollers:", err);
  }

  // Keep coordinating periodically to discover any newly added bots
  if (!process.env.VERCEL) {
    setTimeout(pollAllTelegramBots, 10000);
  }
}

function formatTelegramUrl(url: string): string {
  if (!url) return "";
  let clean = url.replace(/\s+/g, ""); // Strip all spaces robustly
  if (clean.startsWith("@")) {
    return `https://t.me/${clean.substring(1)}`;
  }
  if (clean.startsWith("t.me/")) {
    return `https://${clean}`;
  }
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    if (clean.includes("/") || clean.includes(".")) {
      return `https://${clean}`;
    }
    return `https://t.me/${clean}`;
  }
  return clean;
}

function getOtpInlineKeyboard(botConfig: any) {
  const keyboard: any[][] = [];
  const row: any[] = [];
  
  const b1Text = botConfig?.btn1Text || "🤖 Bot Panel";
  const b1Url = formatTelegramUrl(botConfig?.btn1Url || botConfig?.botLink || "");
  
  const b2Text = botConfig?.btn2Text || "⚡ See OTP";
  const b2Url = formatTelegramUrl(botConfig?.btn2Url || botConfig?.otpGroupUrl || "");

  const b3Text = botConfig?.btn3Text || "📢 Main Channel";
  const b3Url = formatTelegramUrl(botConfig?.btn3Url || "");

  const hasAnyLink = (b1Url && b1Url.startsWith("http")) ||
                     (b2Url && b2Url.startsWith("http")) ||
                     (b3Url && b3Url.startsWith("http"));

  if (!hasAnyLink) {
    return undefined;
  }

  if (b1Url && b1Url.startsWith("http")) {
    row.push({ text: b1Text, url: b1Url });
  }
  
  if (b2Url && b2Url.startsWith("http")) {
    row.push({ text: b2Text, url: b2Url });
  }

  if (row.length > 0) {
    keyboard.push(row);
  }

  if (b3Url && b3Url.startsWith("http")) {
    keyboard.push([{ text: b3Text, url: b3Url }]);
  }

  return keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
}

function getOtpInlineKeyboardWithOtp(botConfig: any, extractedOtp: string, targetChatId?: string | number) {
  const keyboard: any[][] = [];
  const isPending = !extractedOtp || extractedOtp === "PENDING";

  const b1Text = botConfig?.btn1Text || "🤖 Bot Panel";
  const b1Url = formatTelegramUrl(botConfig?.btn1Url || botConfig?.botLink || "");
  
  const b2Text = botConfig?.btn2Text || "⚡ See OTP";
  const b2Url = formatTelegramUrl(botConfig?.btn2Url || botConfig?.otpGroupUrl || "");
  
  const b3Text = botConfig?.btn3Text || "📢 Main Channel";
  const b3Url = formatTelegramUrl(botConfig?.btn3Url || "");

  const isChannelOrGroup = targetChatId ? String(targetChatId).startsWith("-") : false;

  if (isChannelOrGroup) {
    // For groups/channels, callback_data buttons are invalid.
    // Show the custom link buttons when SMS is active!
    const row1: any[] = [];
    if (b1Text && b1Url && b1Url.startsWith("http")) {
      row1.push({ text: b1Text, url: b1Url });
    }
    if (row1.length > 0) {
      keyboard.push(row1);
    }

    const row2: any[] = [];
    if (b2Text && b2Url && b2Url.startsWith("http")) {
      row2.push({ text: b2Text, url: b2Url });
    }
    if (b3Text && b3Url && b3Url.startsWith("http")) {
      row2.push({ text: b3Text, url: b3Url });
    }
    if (row2.length > 0) {
      keyboard.push(row2);
    }
  } else {
    // Private chat, include the Copy OTP callback button if NOT pending, and custom link buttons!
    const row1: any[] = [];
    if (!isPending) {
      row1.push({ text: `🔒 ${extractedOtp}`, callback_data: `btn_copy_${extractedOtp}` });
    }
    
    if (b1Text && b1Url && b1Url.startsWith("http")) {
      row1.push({ text: b1Text, url: b1Url });
    }
    if (row1.length > 0) {
      keyboard.push(row1);
    }

    const row2: any[] = [];
    if (b2Text && b2Url && b2Url.startsWith("http")) {
      row2.push({ text: b2Text, url: b2Url });
    }
    if (b3Text && b3Url && b3Url.startsWith("http")) {
      row2.push({ text: b3Text, url: b3Url });
    }
    if (row2.length > 0) {
      keyboard.push(row2);
    }
  }

  if (keyboard.length === 0) {
    return undefined;
  }

  return { inline_keyboard: keyboard };
}

// Fast user target APIs configuration and stats
export const apiStats: { [key: string]: { success: number; fail: number; lastStatus: string; lastError: string; lastSuccessTime: string } } = {
  "API 1": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" },
  "API 2": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" },
  "API 3": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" },
  "API 4": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" },
  "Api 5": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" },
  "Api 6": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" },
  "API 7": { success: 0, fail: 0, lastStatus: "Pending", lastError: "", lastSuccessTime: "" }
};

// ── Fast-poller source labels — used to skip re-forwarding in the worker ──
// These sources are EXCLUSIVELY handled by runFastUserApiPoller.
// pollIncomingSms (worker) must skip them to prevent double Telegram delivery.
const FAST_POLLER_SOURCES = new Set(["API 1", "API 2", "API 3", "API 4", "Api 5", "Api 6", "API 7"]);

export let isPollingPaused = false;
let isFastPolling = false;

// ── Auto-Number-Add Config ─────────────────────────────────────────────────
// Admin panel se control hota hai — kaunsi API ON hai aur auto-add enabled hai?
export let autoAddConfig: { enabled: boolean; apis: string[] } = { enabled: false, apis: ["all"] };
// Startup par db.json se load karo
try {
  const _startupDb = readDb();
  if (_startupDb.autoAddConfig) {
    autoAddConfig = _startupDb.autoAddConfig;
    console.log("[AutoAdd] Loaded config from db:", JSON.stringify(autoAddConfig));
  }
} catch (_e: any) {
  console.warn("[AutoAdd] Could not load config from db on startup:", _e?.message);
}
// ──────────────────────────────────────────────────────────────────────────

async function fetchUserTargetApi(label: string, url: string, token: string, format: "array" | "pscall"): Promise<any[]> {
  try {
    let finalUrl = url;
    if (format === "pscall") {
      finalUrl = `${url}?key=${encodeURIComponent(token)}&token=${encodeURIComponent(token)}`;
    } else {
      finalUrl = `${url}?token=${encodeURIComponent(token)}&key=${encodeURIComponent(token)}`;
    }

    let text = "";
    let success = false;
    let lastErrMessage = "";

    // 1. Try direct fetch first
    try {
      const response = await fetchWithTimeout(finalUrl, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Token": token,
          "Key": token,
          "X-API-KEY": token
        }
      }, 3500);
      if (response.ok) {
        text = await response.text();
        success = true;
      } else {
        lastErrMessage = `HTTP ${response.status}`;
      }
    } catch (err: any) {
      lastErrMessage = err.message || "Timeout";
    }

    // 2. If direct fetch fails, immediately try via proxy curl (multi-proxy rotation)
    if (!success) {
      await refreshProxyList();
      const headersOption = [
        `-H "Authorization: Bearer ${token}"`,
        `-H "Token: ${token}"`,
        `-H "Key: ${token}"`,
        `-H "X-API-KEY: ${token}"`
      ].join(" ");

      // Try up to 5 proxies max — fewer attempts = faster cycle = less OTP delay
      for (let attempt = 0; attempt < 5; attempt++) {
        if (proxyList.length === 0) break;
        const proxy = proxyList[currentProxyIndex];
        currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;

        try {
          const cmd = `curl -x "${proxy}" -s -4 -m 2 -X GET ${headersOption} -w "\\n%{http_code}" "${finalUrl}"`;
          const output = await execPromise(cmd, { timeout: 3000 });
          if (output && output.trim()) {
            const lines = output.split("\n");
            const status = parseInt(lines[lines.length - 1].trim()) || 0;
            const body = lines.slice(0, lines.length - 1).join("\n");
            if (status === 200 || status === 302 || status === 401) {
              text = body;
              success = true;
              currentProxyIndex = (currentProxyIndex - 1 + proxyList.length) % proxyList.length;
              break;
            } else {
              lastErrMessage = `Proxy HTTP ${status}`;
            }
          }
        } catch (err: any) {
          lastErrMessage = err.message || "Proxy timeout";
        }
      }
    }

    if (!success) {
      throw new Error(lastErrMessage || "Fetch failed");
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON response");
    }

    let list: any[] = [];
    if (format === "pscall") {
      if (data && Array.isArray(data.data)) {
        list = data.data;
      } else if (Array.isArray(data)) {
        list = data;
      } else if (data && Array.isArray(data.result)) {
        list = data.result;
      }
    } else {
      if (Array.isArray(data)) {
        list = data;
      } else if (data && Array.isArray(data.data)) {
        list = data.data;
      } else if (data && Array.isArray(data.result)) {
        list = data.result;
      } else if (data && typeof data === "object") {
        for (const k of Object.keys(data)) {
          if (Array.isArray(data[k])) {
            list = data[k];
            break;
          }
        }
      }
    }

    const mapped = list.map((item: any) => {
      let number = "";
      let sender = "Unknown";
      let message = "";
      let dateStr = "";

      if (Array.isArray(item)) {
        sender = String(item[0] || "Unknown");
        number = String(item[1] || "").trim();
        message = String(item[2] || "");
        dateStr = String(item[3] || "");
      } else if (item && typeof item === "object") {
        number = String(item.num || item.number || "").trim();
        sender = String(item.cli || item.sender || "Unknown");
        message = String(item.sms || item.message || "");
        dateStr = String(item.dateadded || item.date || "");
      }

      if (!number) return null;

      const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
      return {
        timestamp,
        number,
        service: detectServiceFromMessageAndSender(sender, message),
        message,
        country: getCountryFromNumber(number),
        source: label
      };
    }).filter((o: any) => o && o.number);

    apiStats[label].success++;
    apiStats[label].lastStatus = "Online";
    apiStats[label].lastError = "";
    apiStats[label].lastSuccessTime = new Date().toISOString();

    return mapped;
  } catch (err: any) {
    apiStats[label].fail++;
    apiStats[label].lastStatus = "Offline";
    apiStats[label].lastError = err.message || "Timeout or network error";
    return [];
  }
}

// ── Junaid-format API fetch (no token, uses ?type=sms directly) ───────────────
// Response shape (verified against live API):
//   { sEcho, iTotalRecords, aaData: [ [timestamp, country, phone, service, message, ...], ... ] }
// Indices: [0]=dateStr  [1]=country  [2]=phone  [3]=service  [4]=message
async function fetchJunaidTypeSms(label: string, smsUrl: string): Promise<any[]> {
  try {
    let text = "";
    let success = false;
    let lastErrMessage = "";

    try {
      const response = await fetchWithTimeout(smsUrl, {
        headers: { "Accept": "application/json" }
      }, 4000);
      if (response.ok) {
        text = await response.text();
        success = true;
      } else {
        lastErrMessage = `HTTP ${response.status}`;
      }
    } catch (err: any) {
      lastErrMessage = err.message || "Timeout";
    }

    if (!success) {
      apiStats[label].fail++;
      apiStats[label].lastStatus = "Offline";
      apiStats[label].lastError = lastErrMessage;
      return perSourceSmsCache[label] || [];
    }

    let data: any;
    try { data = JSON.parse(text); } catch { data = null; }

    // aaData is the array of rows for this API format
    const list: any[] = (data && Array.isArray(data.aaData)) ? data.aaData : [];

    const mapped = list.map((item: any) => {
      if (!Array.isArray(item)) return null;

      // Junaid API row layout: [timestamp, country, phone, service, message, ...]
      const dateStr  = String(item[0] || "");
      const country  = String(item[1] || "Unknown");
      const number   = String(item[2] || "").trim();
      const service  = String(item[3] || "");
      const message  = String(item[4] || "");

      // Reject rows where phone is not a numeric string (at least 7 digits)
      if (!number || !/^\d{7,}$/.test(number)) return null;

      const timestamp = isNaN(Date.parse(dateStr)) ? new Date().toISOString() : new Date(dateStr).toISOString();
      return {
        timestamp,
        number,
        service: service || detectServiceFromMessageAndSender("Unknown", message),
        message,
        country,
        source: label
      };
    }).filter((o: any) => o && o.number);

    perSourceSmsCache[label] = mapped;
    apiStats[label].success++;
    apiStats[label].lastStatus = "Online";
    apiStats[label].lastError = "";
    apiStats[label].lastSuccessTime = new Date().toISOString();
    return mapped;
  } catch (err: any) {
    apiStats[label].fail++;
    apiStats[label].lastStatus = "Offline";
    apiStats[label].lastError = err.message || "Timeout";
    return perSourceSmsCache[label] || [];
  }
}
// ──────────────────────────────────────────────────────────────────────────────

async function runFastUserApiPoller() {
  // Wait for GitHub db.json restore before first poll — prevents re-forwarding
  // old SMS that are already in db.manualSms (duplicate guard needs db loaded first)
  if (!_startupRestoreDone) {
    setTimeout(runFastUserApiPoller, 1000);
    return;
  }
  if (isFastPolling) {
    setTimeout(runFastUserApiPoller, 1000);
    return;
  }
  if (isPollingPaused) {
    setTimeout(runFastUserApiPoller, 2000);
    return;
  }
  isFastPolling = true;

  try {
    const api1Logs = await fetchUserTargetApi("API 1", "http://147.135.212.197/crapi/st/viewstats", "SE5XREZBUzRfTpVnX2dQh3NQcYB2dZBWQ4JpXVxmblp2alCDi25oZg==", "array");
    const api2Logs = await fetchUserTargetApi("API 2", "http://147.135.212.197/crapi/st/viewstats", "RVdWRElBUzRGcW9WeneNcmd2cGV9ZJd8e29PVlyPcFxeamxSgWVXfw==", "array");
    const api3Logs = await fetchUserTargetApi("API 3", "https://pscall.net/restapi/smsreport", "SFNYSj1SS16DgYdyf4KIgA==", "pscall");
    const api4Logs = await fetchUserTargetApi("API 4", "http://147.135.212.197/crapi/time/viewstats", "RldRNEVBYIFbkYpaY19udX53hX1DZnZhiI9iRkGEjGGFdXZKfmw", "array");
    const api5Logs = await fetchJunaidTypeSms("Api 5", "https://api-junaid-production.up.railway.app/api/ps?type=sms");
    const api6Logs = await fetchJunaidTypeSms("Api 6", "https://api-junaid-production.up.railway.app/api/np?type=sms");
    // ── API 7 (hadiAPI) — crapi/had endpoint ─────────────────────────────────
    const api7Logs = await fetchUserTargetApi("API 7", "http://147.135.212.197/crapi/had/viewstats", "SlJSQjRSQldcko9XYX9Yh4p4eX5kl2tlRGKHYWhgWEhGgph7Undu", "array");
    // ─────────────────────────────────────────────────────────────────────────

    const allNewSms = [...api1Logs, ...api2Logs, ...api3Logs, ...api4Logs, ...api5Logs, ...api6Logs, ...api7Logs];

    if (allNewSms.length > 0) {
      // Prepend to targetApiSmsHistory for visual logs in Admin Panel
      for (const sms of allNewSms) {
        const isDuplicate = targetApiSmsHistory.some(
          (s: any) => s.number === sms.number && s.message === sms.message && s.timestamp === sms.timestamp
        );
        if (!isDuplicate) {
          targetApiSmsHistory.unshift(sms);
        }
      }
      if (targetApiSmsHistory.length > 100) {
        targetApiSmsHistory = targetApiSmsHistory.slice(0, 100);
      }

      const db = readDb();
      let dbUpdated = false;

      // Merge into cachedSms
      const mergedList = [...allNewSms, ...cachedSms];
      mergedList.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const seen = new Set<string>();
      const uniqueList: any[] = [];
      for (const sms of mergedList) {
        const key = `${sms.number}_${sms.message.slice(0, 30)}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueList.push(sms);
        }
      }
      cachedSms = uniqueList.slice(0, 100);

      // Look for NEW unforwarded ones to trigger instant Telegram delivery!
      // NOTE: allNewSms comes DIRECTLY from live API calls — never from db.json
      // or cache. Source validation is inherently satisfied here. We still log
      // every forwarded SMS for audit trail.
      for (const sms of allNewSms) {
        const numberClean = sms.number.replace(/[\s\-\+]/g, "");
        const msg = sms.message;
        const service = sms.service;
        const timestamp = sms.timestamp;
        const country = sms.country;
        const smsSourceFast = sms.source || "API (Fast Poller)";

        // (no pre-filter needed — fast poller IS the panel live stream)

        // Auto claim in DB
        if (!db.claimedNumbers.includes(numberClean)) {
          db.claimedNumbers.push(numberClean);
          dbUpdated = true;
        }
        if (db.manualNumbers) {
          const originalLength = db.manualNumbers.length;
          db.manualNumbers = db.manualNumbers.filter(
            (n: any) => n.number.replace(/[\s\-\+]/g, "") !== numberClean
          );
          if (db.manualNumbers.length !== originalLength) {
            dbUpdated = true;
          }
        }

        // ─────────────────────────────────────────────────────────────────────

        const smsId = `${numberClean}_${msg.trim()}`;
        const userSmsKeyBase = `${numberClean}_${msg.trim()}`;

        // Auto add to db.manualSms so any API OTPs are permanently stored
        if (!db.manualSms) db.manualSms = [];
        const smsNumClean2 = sms.number.replace(/[\s\-\+]/g, "");
        const isDuplicateManual = db.manualSms.some(
          (s: any) => s.number.replace(/[\s\-\+]/g, "") === smsNumClean2 && s.message === sms.message
        );

        // ── RESTART-SAFE DUPLICATE GUARD ──────────────────────────────────
        // If this SMS is already in db.manualSms it was forwarded in a
        // previous server session. lastForwardedSmsIds resets on restart so
        // without this check the same SMS would be re-sent every time the
        // server restarts while the API still returns it.
        if (isDuplicateManual) {
          // Pre-fill in-memory set so the per-user loop also skips it fast.
          for (const user of db.users) {
            lastForwardedSmsIds.add(`${user.id}_${userSmsKeyBase}`);
          }
          continue; // Skip forwarding — already done in a past session
        }
        // ─────────────────────────────────────────────────────────────────

        // Brand-new SMS — save it and log before forwarding
        db.manualSms.unshift(sms);
        if (db.manualSms.length > 500) {
          db.manualSms = db.manualSms.slice(0, 500);
        }
        dbUpdated = true;
        console.log(`[SMS-FAST] FORWARDING | Source: ${smsSourceFast} | ${sms.number} | ${(sms.message || "").slice(0, 50)}`);

        // ── PER-SMS GROUP DEDUP ────────────────────────────────────────────────
        // Ek SMS ke liye sirf ek baar per unique groupId send hoga.
        // Agar 5 users ka same groupId hai, sirf pehli baar jayega — baaki
        // "already sent" skip honge. Ye woh bug tha jis se 4-5 duplicate
        // OTPs same group mein aa rahe the.
        const groupsSentThisSms = new Set<string>();
        // ──────────────────────────────────────────────────────────────────────

        for (const user of db.users) {
          // Telegram pause must never stop an independently configured
          // WhatsApp OTP bot.
          if (user.botConfig?.status === "paused") continue;
          const userSmsKey = `${user.id}_${userSmsKeyBase}`;
          if (lastForwardedSmsIds.has(userSmsKey)) continue;
          if (isSmsDuplicateForUser(user, numberClean, msg)) {
            lastForwardedSmsIds.add(userSmsKey);
            continue;
          }
          lastForwardedSmsIds.add(userSmsKey);

          if (lastForwardedSmsIds.size > 1000) {
            const arr = Array.from(lastForwardedSmsIds);
            lastForwardedSmsIds = new Set(arr.slice(200));
          }

          const token = user.botConfig?.token;
          const telegramEnabled = Boolean(token) && user.botConfig?.status !== "paused";
          let extOtp = extractOtp(msg);
          // If regex can't find OTP, try user's Gemini key as fallback
          if (extOtp === "PENDING" && user.botConfig?.geminiApiKey) {
            extOtp = await extractOtpWithGemini(msg, user.botConfig.geminiApiKey);
          }
          const userSpecificService = getServiceForSms(sms, user);
          const customMsgText = formatTelegramOtpMessage(sms, msg, userSpecificService, country);

          const matchedSubs = (user.subscribers || []).filter((s: any) =>
            (s.numbers || []).some((n: any) => n.number.replace(/[\s\-\+]/g, "") === numberClean)
          );

          if (telegramEnabled) {
            for (const sub of matchedSubs) {
              if (sub.chatId === 0) continue;
              
              // Find if this number has an active session with a messageId
              const numSession = (sub.numbers || []).find((n: any) => n.number.replace(/[\s\-\+]/g, "") === numberClean);
              let wasEdited = false;
              if (numSession && numSession.messageId) {
                const flag = getCountryFlag(country);
                const serviceName = numSession.service || userSpecificService;
                const displayOtp = extOtp === "PENDING" ? "😺" : extOtp;
                const updatedText = `🌍 <b>Country:</b> ${country} ${flag}\n🔌 <b>Service:</b> ${serviceName}\n\n☎ <b>Number:</b> <code>${numSession.number}</code>\n\n✅ <b>OTP Received:</b> <code>${displayOtp}</code>\n\n💬 <b>Message:</b>\n<i>${escapeTelegramHtml(msg)}</i>`;
                
                const inlineKbWithOtp = getOtpInlineKeyboardWithOtp(user.botConfig, extOtp, sub.chatId);
                await editBotMessageText(token, sub.chatId, numSession.messageId, updatedText, inlineKbWithOtp);
                wasEdited = true;
              }

              if (!wasEdited) {
                const inlineKbWithOtp = getOtpInlineKeyboardWithOtp(user.botConfig, extOtp, sub.chatId);
                await sendCustomTelegramMessageWithKeyboard(token, sub.chatId, customMsgText, inlineKbWithOtp);
              }
            }
            // ── Forward to Telegram group / WhatsApp channel ─────────────────
            // STRICT RULE: Sirf woh messages group mein jayein jo:
            //   1. Real OTP code contain karti hon (extOtp !== "PENDING")
            //      — fake, spam, promotional ya bina code ke messages BLOCK hain
            //   2. isSpamOrPromotionalMessage === false (payment/order messages block)
            //   3. Panel ke Live OTP Stream mein receive ho rahi hon (fast poller
            //      se aati hain — allNewSms loop mein hain)
            // ── GROUP GATE ────────────────────────────────────────────────────
            // Sirf woh OTP group mein jaaye jis mein real code extract hua ho.
            // Duplicate per-group groupsSentThisSms Set se handle hain.
            // ─────────────────────────────────────────────────────────────────
            // GATE: sirf woh OTP Telegram group mein jaaye jis mein real code extract hua ho.
            // Panel mein aane wale sab APIs ke OTPs forward honge — PENDING (no code) block.
            // RULE: panel ka har real OTP (code extracted) → Telegram group
            // PENDING (no code) → block
            const allowGroupForward = extOtp !== "PENDING";
            console.log(`[FILTER] number=${numberClean} subs=${matchedSubs.length} otp=${extOtp} → allow=${allowGroupForward}`);

            if (allowGroupForward) {
              // Telegram group — dedup: same groupId mein ek OTP sirf ek baar
              if (user.botConfig?.groupId) {
                const gid = user.botConfig.groupId;
                if (groupsSentThisSms.has(gid)) {
                  console.log(`[TG-GROUP] ⏭️ SKIP duplicate → groupId=${gid} (already sent this OTP)`);
                } else {
                  groupsSentThisSms.add(gid);
                  const inlineKbWithOtp = getOtpInlineKeyboardWithOtp(user.botConfig, extOtp, gid);
                  const tgOk = await sendCustomTelegramMessageWithKeyboard(token, gid, customMsgText, inlineKbWithOtp);
                  console.log(`[TG-GROUP] ${tgOk ? "✅ Sent" : "❌ Failed"} → groupId=${gid}`);
                  if (tgOk) await new Promise(r => setTimeout(r, 500));
                }
              }

            } else {
              console.log(`[FILTER] ⛔ BLOCKED group/channel forward — fake/spam/no-code message`);
            }
            // ─────────────────────────────────────────────────────────────────
          }

          // Also feed user's internal OTP logs so the web interface is populated!
          if (user.botConfig) {
            if (!user.otpHistory) user.otpHistory = [];
            const isDuplicate = user.otpHistory.some(
              (h: any) => h.number === sms.number && h.message === sms.message
            );
            if (!isDuplicate) {
              user.otpHistory.unshift(sms);
              if (user.otpHistory.length > 30) {
                user.otpHistory = user.otpHistory.slice(0, 30);
              }
              dbUpdated = true;
            }
          }
        }

      }

      if (dbUpdated) {
        writeDb(db);
      }
      saveForwardedIds(lastForwardedSmsIds);
    }
  } catch (err) {
    console.error("[Fast Poller] Error:", err);
  } finally {
    isFastPolling = false;
    if (!process.env.VERCEL) {
      setTimeout(runFastUserApiPoller, 2000);
    }
  }
}

// Start fast target APIs background loop
if (!process.env.VERCEL) {
  setTimeout(runFastUserApiPoller, 1000);
}

let isPollingIncomingSms = false;

// SMS Worker: Forwarding to all subscribers across all bots
async function pollIncomingSms() {
  // Wait for GitHub db.json restore — duplicate guard needs loaded db
  if (!_startupRestoreDone) {
    setTimeout(pollIncomingSms, 1000);
    return;
  }
  if (isPollingIncomingSms) {
    setTimeout(pollIncomingSms, 2000);
    return;
  }
  isPollingIncomingSms = true;

  try {
    // Poll all numbers from all APIs to cache them respectably
    try {
      await fetchAggregatedNumbers(undefined, false);
    } catch (numErr: any) {
      console.error("[Worker] Background numbers poll error:", numErr.message);
    }

    const otps = await fetchAggregatedSms(false);
    const db = readDb();
    let dbUpdated = false;

    for (const otp of otps) {
      // ═══════════════════════════════════════════════════════════════════════
      // SOURCE VALIDATION — Block db.json / cache / mock / stored data
      // Allow: Panel-injected SMS (source = "Panel") | API SMS (source = API name)
      // Block: _fromStoredDb = true  →  old db.json entries re-read on startup
      // Block: fast-poller sources (API 1-7)  →  already handled exclusively
      //        by runFastUserApiPoller; worker forwarding these causes double
      //        Telegram delivery even with the isDuplicateManual guard due to
      //        a timing race between the two pollers.
      // ═══════════════════════════════════════════════════════════════════════
      if (otp._fromStoredDb) {
        // Silent skip — no console spam; these are display-only history entries
        continue;
      }
      if (FAST_POLLER_SOURCES.has(otp.source)) {
        // Fast poller already handles these exclusively — skip to prevent double delivery
        continue;
      }
      const smsSource = otp.source || "API";
      console.log(`[SMS-WORKER] FORWARDING | Source: ${smsSource} | ${otp.number} | ${(otp.message || "").slice(0, 50)}`);

      const numberClean = otp.number.replace(/[\s\-\+]/g, "");
      const msg = otp.message;
      const service = otp.service;
      const timestamp = otp.timestamp;
      const country = otp.country;

      // Unconditionally claim and remove number from manual/active list since an OTP has been received!
      if (!db.claimedNumbers.includes(numberClean)) {
        db.claimedNumbers.push(numberClean);
        dbUpdated = true;
      }
      if (db.manualNumbers) {
        const originalLength = db.manualNumbers.length;
        db.manualNumbers = db.manualNumbers.filter(
          (n: any) => n.number.replace(/[\s\-\+]/g, "") !== numberClean
        );
        if (db.manualNumbers.length !== originalLength) {
          dbUpdated = true;
        }
      }

      // ── Auto-Number-Add Feature (Worker Poller) ───────────────────────────
      // Rules:
      //   API 1, 3, 4 → SMS aane par number add ho
      //   API 2        → number add NA ho (skip)
      //   Api 5, Api 6 → number add NA ho (ye sirf numbers request bhejte hain)

      // ─────────────────────────────────────────────────────────────────────

      const smsId = `${numberClean}_${msg.trim()}`;
      const userSmsKeyBase = `${numberClean}_${msg.trim()}`;

      // Auto add to db.manualSms so any API OTPs are permanently stored
      if (!db.manualSms) db.manualSms = [];
      const isDuplicateManual = db.manualSms.some(
        (s: any) => s.number === otp.number && s.message === otp.message
      );
      if (!isDuplicateManual) {
        db.manualSms.unshift(otp);
        if (db.manualSms.length > 500) {
          db.manualSms = db.manualSms.slice(0, 500);
        }
        dbUpdated = true;
      } else {
        // ── WORKER DUPLICATE GUARD ─────────────────────────────────────────
        // Fast poller already forwarded this SMS (it saves to db.manualSms
        // before forwarding). Pre-fill lastForwardedSmsIds so the per-user
        // loop also skips it, then skip entirely — prevents double delivery.
        for (const u of db.users) {
          lastForwardedSmsIds.add(`${u.id}_${userSmsKeyBase}`);
        }
        saveForwardedIds(lastForwardedSmsIds);
        continue; // ← SMS already forwarded by fast poller, skip worker
        // ──────────────────────────────────────────────────────────────────
      }

      // Check subscribers of every user
      for (const user of db.users) {
        const userSmsKey = `${user.id}_${userSmsKeyBase}`;
        if (lastForwardedSmsIds.has(userSmsKey)) continue;
        if (isSmsDuplicateForUser(user, numberClean, msg)) {
          lastForwardedSmsIds.add(userSmsKey);
          continue;
        }
        lastForwardedSmsIds.add(userSmsKey);

        if (lastForwardedSmsIds.size > 1000) {
          const arr = Array.from(lastForwardedSmsIds);
          lastForwardedSmsIds = new Set(arr.slice(200));
        }

        const token = user.botConfig?.token;
        const extOtp = extractOtp(msg);
        const userSpecificService = getServiceForSms(otp, user);
        const customMsgText = formatTelegramOtpMessage(otp, msg, userSpecificService, country);

        const matchedSubs = (user.subscribers || []).filter((s: any) =>
          (s.numbers || []).some((n: any) => n.number.replace(/[\s\-\+]/g, "") === numberClean)
        );

        if (token) {
          for (const sub of matchedSubs) {
            if (sub.chatId === 0) continue; // Skip dummy subscriber used for web claims
            
            // Find if this number has an active session with a messageId
            const numSession = (sub.numbers || []).find((n: any) => n.number.replace(/[\s\-\+]/g, "") === numberClean);
            let wasEdited = false;
            if (numSession && numSession.messageId) {
              const flag = getCountryFlag(country);
              const serviceName = numSession.service || userSpecificService;
              const displayOtp = extOtp === "PENDING" ? "😺" : extOtp;
              const updatedText = `🌍 <b>Country:</b> ${country} ${flag}\n🔌 <b>Service:</b> ${serviceName}\n\n☎ <b>Number:</b> <code>${numSession.number}</code>\n\n✅ <b>OTP Received:</b> <code>${displayOtp}</code>\n\n💬 <b>Message:</b>\n<i>${escapeTelegramHtml(msg)}</i>`;
              
              const inlineKbWithOtp = getOtpInlineKeyboardWithOtp(user.botConfig, extOtp, sub.chatId);
              await editBotMessageText(token, sub.chatId, numSession.messageId, updatedText, inlineKbWithOtp);
              wasEdited = true;
            }

            if (!wasEdited) {
              const inlineKbWithOtp = getOtpInlineKeyboardWithOtp(user.botConfig, extOtp, sub.chatId);
              await sendCustomTelegramMessageWithKeyboard(
                token,
                sub.chatId,
                customMsgText,
                inlineKbWithOtp
              );
            }
          }

          // NOTE: Telegram group + WhatsApp channel forwarding is handled ONLY
          // by the fast poller (runFastUserApiPoller) to avoid double-delivery.
          // The main worker only handles per-subscriber private messages.
        }


        if (matchedSubs.length > 0) {
          if (!user.otpHistory) user.otpHistory = [];
          const isDuplicate = user.otpHistory.some(
            (h: any) => h.number === otp.number && h.message === otp.message
          );
          if (!isDuplicate) {
            user.otpHistory.unshift(otp);
            if (user.otpHistory.length > 30) {
              user.otpHistory = user.otpHistory.slice(0, 30);
            }
            dbUpdated = true;
          }
        }
      }
    }

    if (dbUpdated) {
      writeDb(db);
    }
    saveForwardedIds(lastForwardedSmsIds);
  } catch (err) {
    console.error("SMS poll failure:", err);
  } finally {
    isPollingIncomingSms = false;
    if (!process.env.VERCEL) {
      setTimeout(pollIncomingSms, 2000);
    }
  }
}

let isAutoAddingNumbers = false;

async function autoAddNumbersFromApis() {
  if (isAutoAddingNumbers) return;
  isAutoAddingNumbers = true;
  try {
    const db = readDb();
    if (!db.manualNumbers) db.manualNumbers = [];
    if (!db.claimedNumbers) db.claimedNumbers = [];
    
    let addedCount = 0;
    const nowStr = new Date().toISOString();
    
    // Original aggregator logic (for API_ENDPOINTS)
    console.log("[AutoNumberAdder] Polling API aggregators...");
    const activeApiNumbers = await fetchAggregatedNumbers(undefined, true);
    for (const item of activeApiNumbers) {
      const cleanNum = item.number.replace(/[\s\-\+]/g, "");
      if (!cleanNum || db.claimedNumbers.includes(cleanNum)) continue;
      const exists = db.manualNumbers.some((n: any) => n.number.replace(/[\s\-\+]/g, "") === cleanNum);
      if (!exists) {
        const newNumObj = {
          id: "num_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
          number: item.number,
          country: item.country || "Unknown",
          server: item.source || "API Aggregator",
          addedAt: nowStr,
          autoAdded: true
        };
        db.manualNumbers.push(newNumObj);
        addedCount++;
      }
    }
    
    // New specific target APIs logic as requested by user
    if (autoAddConfig.enabled) {
      console.log("[AutoNumberAdder] Polling explicit target APIs for numbers...");
      const targetApis = [
        { label: "API 1", url: "http://147.135.212.197/crapi/st/viewstats", type: "array", auth: "SE5XREZBUzRfTpVnX2dQh3NQcYB2dZBWQ4JpXVxmblp2alCDi25oZg==" },
        { label: "API 2", url: "http://147.135.212.197/crapi/st/viewstats", type: "array", auth: "RVdWRElBUzRGcW9WeneNcmd2cGV9ZJd8e29PVlyPcFxeamxSgWVXfw==" },
        { label: "API 3", url: "https://pscall.net/restapi/smsreport", type: "pscall", auth: "SFNYSj1SS16DgYdyf4KIgA==" },
        { label: "API 4", url: "http://147.135.212.197/crapi/time/viewstats", type: "array", auth: "RldRNEVBYIFbkYpaY19udX53hX1DZnZhiI9iRkGEjGGFdXZKfmw==" },
        { label: "Api 5", url: "https://api-junaid-production.up.railway.app/api/ps?type=sms", type: "junaid" },
        { label: "Api 6", url: "https://api-junaid-production.up.railway.app/api/np?type=sms", type: "junaid" },
        { label: "API 7", url: "http://147.135.212.197/crapi/had/viewstats", type: "array", auth: "SlJSQjRSQldcko9XYX9Yh4p4eX5kl2tlRGKHYWhgWEhGgph7Undu" }
      ];

      for (const api of targetApis) {
        if (autoAddConfig.apis.includes("all") || autoAddConfig.apis.includes(api.label)) {
          let numberUrl = api.url.replace(/sms/g, "number");
          try {
            let parsed = [];
            if (api.type === "junaid") {
              const res = await fetchWithTimeout(numberUrl, {}, 4000);
              if (res.ok) {
                const text = await res.text();
                parsed = parseJunaidNumbers(text, api.label);
              }
            } else {
              const headers = api.auth ? { "Authorization": `Basic ${api.auth}` } : {};
              const res = await fetchWithTimeout(numberUrl, { method: "POST", headers }, 4000);
              if (res.ok) {
                const text = await res.text();
                parsed = parseSmsList(text, api.label);
              }
            }
            
            for (const item of parsed) {
              const cleanNum = item.number.replace(/[\s\-\+]/g, "");
              if (!cleanNum || db.claimedNumbers.includes(cleanNum)) continue;
              const exists = db.manualNumbers.some((n: any) => n.number.replace(/[\s\-\+]/g, "") === cleanNum);
              if (!exists) {
                db.manualNumbers.push({
                  id: "num_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
                  number: item.number,
                  country: item.country || "Unknown",
                  server: item.source || api.label,
                  addedAt: nowStr,
                  autoAdded: true
                });
                addedCount++;
              }
            }
          } catch (e) {
            // Ignore if endpoint fails
          }
        }
      }
    }

    if (addedCount > 0) {
      writeDb(db);
      console.log(`[AutoNumberAdder] Successfully auto-added ${addedCount} new numbers.`);
    } else {
      console.log("[AutoNumberAdder] No new unique numbers found to auto-add.");
    }
  } catch (err: any) {
    console.error("[AutoNumberAdder] Error:", err.message);
  } finally {
    isAutoAddingNumbers = false;
    if (!process.env.VERCEL) {
      setTimeout(autoAddNumbersFromApis, 60 * 1000);
    }
  }
}

// Cleanup stale claimed numbers every 30 minutes
// (numbers cycle in APIs — old claimed entries block new adds indefinitely)
async function cleanupStaleClaimedNumbers() {
  try {
    const db = readDb();
    if (!db.claimedNumbers || db.claimedNumbers.length === 0) return;

    // Fetch fresh API numbers to see what's still available
    const freshApiNums = new Set<string>();
    for (const api of API_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(api.numbers, {}, 3000);
        if (res.ok) {
          const text = await res.text();
          const parsed = parseNumbersList(text, api.label);
          parsed.forEach((n: any) => freshApiNums.add(n.number.replace(/[\s\-\+]/g, "")));
        }
      } catch (_) {}
    }
    // Also include Junaid API numbers (aaData format)
    for (const je of JUNAID_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(je.numbersUrl, {}, 3000);
        if (res.ok) {
          const text = await res.text();
          const parsed = parseJunaidNumbers(text, je.label);
          parsed.forEach((n: any) => freshApiNums.add(n.number.replace(/[\s\-\+]/g, "")));
        }
      } catch (_) {}
    }

    // Keep only claimed numbers that are still actively in API pools
    // (numbers no longer in any API are old/deleted — safe to unclaim)
    const before = db.claimedNumbers.length;
    // Only clean if we got data (freshApiNums non-empty)
    if (freshApiNums.size > 0) {
      db.claimedNumbers = db.claimedNumbers.filter((n: string) => freshApiNums.has(n));
      const removed = before - db.claimedNumbers.length;
      if (removed > 0) {
        writeDb(db);
        console.log(`[CleanupClaimed] Removed ${removed} stale claimed number(s). Pool freed.`);
      }
    }
  } catch (err: any) {
    console.error("[CleanupClaimed] Error:", err.message);
  } finally {
    if (!process.env.VERCEL) setTimeout(cleanupStaleClaimedNumbers, 30 * 60 * 1000);
  }
}

// Start workers
if (!process.env.VERCEL) {
  pollAllTelegramBots();
  setTimeout(pollIncomingSms, 2000);
  setTimeout(autoAddNumbersFromApis, 5000);
  setTimeout(cleanupStaleClaimedNumbers, 5 * 60 * 1000); // first run after 5 min
}

// ============================================================
//  API ROUTES
// ============================================================

// 0. Vercel Cron 24/7 background polling endpoint
router.get("/cron/poll", async (req, res) => {
  try {
    console.log("[Cron] Running 24/7 background pollers...");
    // Explicitly reset locks to allow cron executions to proceed
    isFastPolling = false;
    isPollingIncomingSms = false;

    // Run each of the main workers once
    await Promise.all([
      runFastUserApiPoller(),
      pollIncomingSms(),
      pollAllTelegramBots()
    ]);

    res.json({ success: true, message: "Cron polling completed successfully." });
  } catch (err: any) {
    console.error("[Cron] Error:", err);
    res.status(500).json({ success: true, error: err.message, note: "Handled gracefully to prevent cron failures" });
  }
});

// 1. Get Aggregated Numbers with Stats
router.get("/numbers", async (req, res) => {
  try {
    const list = await fetchAggregatedNumbers();
    const countryCounts: { [key: string]: number } = {};
    list.forEach((n) => {
      const c = n.country || "Unknown";
      countryCounts[c] = (countryCounts[c] || 0) + 1;
    });

    res.json({
      success: true,
      numbers: list,
      stats: {
        totalNumbers: list.length,
        countryBreakdown: countryCounts,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1b. Claim virtual number (registers it to user session and immediately claims/deletes it)
router.post("/numbers/claim", (req, res) => {
  const { number, userId, country } = req.body;
  if (!number) {
    return res.status(400).json({ success: false, error: "Number is required" });
  }

  if (userId) {
    registerNumberForSubInDb(userId, 0, number, country || "Virtual Number");
  }
  claimNumberInDb(number);

  res.json({ success: true, message: "Number assigned to user session and claimed successfully" });
});

// Polling Stats and Control Endpoints
router.get("/admin/system-status", (req, res) => {
  const db = readDb();
  const users = db.users || [];
  const totalUsers = users.length;
  const totalActiveBots = users.filter((u: any) => u.botConfig?.token && u.botConfig?.status === "active").length;
  const totalTokens = users.filter((u: any) => u.botConfig?.token).length;
  const totalSubscribers = users.reduce((sum: number, u: any) => sum + (u.subscribers || []).length, 0);
  res.json({
    success: true,
    isVercel: !!process.env.VERCEL,
    isKvConfigured: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
    dbFile: DB_FILE,
    totalUsers,
    totalActiveBots,
    totalTokens,
    totalSubscribers,
    pollingActive: !isPollingPaused,
    activeBotPollerCount: activeBotPollers.size
  });
});

router.get("/admin/polling-stats", (req, res) => {
  res.json({
    success: true,
    stats: apiStats,
    backgroundStats: backgroundApiStats,
    isPollingPaused: isPollingPaused
  });
});

router.post("/admin/polling-control", (req, res) => {
  const { paused } = req.body;
  if (typeof paused === "boolean") {
    isPollingPaused = paused;
  }
  res.json({
    success: true,
    isPollingPaused: isPollingPaused
  });
});

// ── Auto-Number-Add Config Routes ─────────────────────────────────────────
// GET: current config fetch karo
router.get("/admin/auto-add-config", (req, res) => {
  res.json({ success: true, config: autoAddConfig });
});

// POST: config update karo aur db.json mein save karo (permanent)
router.post("/admin/auto-add-config", (req, res) => {
  try {
    const { enabled, apis } = req.body;
    if (typeof enabled === "boolean") autoAddConfig.enabled = enabled;
    if (Array.isArray(apis) && apis.length > 0) autoAddConfig.apis = apis;

    // db.json mein save karo taake restart ke baad bhi rahay
    const db = readDb();
    db.autoAddConfig = { ...autoAddConfig };
    writeDb(db);

    console.log("[AutoAdd] Config updated:", JSON.stringify(autoAddConfig));
    res.json({ success: true, config: autoAddConfig });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────

router.get("/admin/target-sms", (req, res) => {
  res.json({
    success: true,
    sms: targetApiSmsHistory
  });
});

// 2. Get Aggregated SMS Logs
router.get("/sms", async (req, res) => {
  try {
    const list = await fetchAggregatedSms();
    const db = readDb();
    
    const augmentedList = list.map((o: any) => {
      const numberClean = o.number.replace(/[\s\-\+]/g, "");
      let btn1Text = "";
      let btn1Url = "";
      let btn2Text = "";
      let btn2Url = "";
      let btn3Text = "";
      let btn3Url = "";
      let botUsername = "";

      for (const u of db.users) {
        const hasSub = (u.subscribers || []).some((s: any) => 
          (s.numbers || []).some((n: any) => n.number.replace(/[\s\-\+]/g, "") === numberClean)
        );
        if (hasSub) {
          btn1Text = u.botConfig?.btn1Text || "";
          btn1Url = u.botConfig?.btn1Url || u.botConfig?.botLink || "";
          btn2Text = u.botConfig?.btn2Text || u.botConfig?.otpGroupUrl || "";
          btn3Text = u.botConfig?.btn3Text || "";
          btn3Url = u.botConfig?.btn3Url || "";
          botUsername = u.username || "";
          break;
        }
      }

      return {
        ...o,
        btn1Text,
        btn1Url,
        btn2Text,
        btn2Url,
        btn3Text,
        btn3Url,
        botUsername
      };
    });

    res.json({ success: true, otps: augmentedList });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. User Registration (Account to Deploy Bot)
router.post("/users/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ success: false, error: "Please fill in all details." });
  }

  // Wait for startup restore before registering
  if (!_startupRestoreDone) {
    return res.status(503).json({
      success: false,
      error: "Server abhi start ho raha hai, please 5-10 second baad dobara try karein.",
      startingUp: true
    });
  }

  const db = await loadDbFromStore();
  const exists = db.users.some((u: any) => u.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ success: false, error: "Email is already registered." });
  }

  const newUser = {
    id: "user_" + Date.now(),
    username,
    email,
    password,
    botConfig: {
      token: "",
      groupId: "",
      ownerChatId: "",
      botLink: "",
      otpGroupUrl: "",
    },
    subscribers: [],
  };

  db.users.push(newUser);
  writeDb(db);

  res.json({
    success: true,
    user: {
      id: newUser.id,
      username: newUser.username,
      email: newUser.email,
      botConfig: newUser.botConfig,
      subscribers: newUser.subscribers,
      otpHistory: [],
      whatsappHistory: [],
    },
  });
});

// 4. User Login
router.post("/users/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Credentials required" });
  }

  // ── Startup safety: if DB is still loading from GitHub, tell frontend to wait ──
  // This prevents auto-logout on page reload when the server just restarted.
  if (!_startupRestoreDone) {
    return res.status(503).json({
      success: false,
      error: "Server abhi start ho raha hai, please 5-10 second baad dobara try karein.",
      startingUp: true
    });
  }

  // ── Always use fresh DB from GitHub (avoids stale cache on restart) ──
  const db = await loadDbFromStore();
  const user = db.users.find(
    (u: any) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
  );

  if (!user) {
    // ── Heroku restart guard: if DB has 0 users it means GitHub restore
    // hasn't loaded yet (ephemeral filesystem wiped on dyno restart).
    // Tell the frontend to wait and retry — not "wrong password".
    if (db.users.length === 0) {
      return res.status(503).json({
        success: false,
        startingUp: true,
        error: "Server abhi start ho raha hai, please 10-15 second baad dobara try karein."
      });
    }
    return res.status(401).json({ success: false, error: "Invalid email or password." });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      botConfig: user.botConfig,
      subscribers: user.subscribers || [],
      otpHistory: user.otpHistory || [],
      whatsappHistory: user.whatsappHistory || [],
    },
  });
});

// 4b. Toggle User Bot Polling Status (paused / active)
router.post("/users/bot/toggle-status", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, error: "User ID required" });
  }

  const db = readDb();
  const userIdx = db.users.findIndex((u: any) => u.id === userId);
  if (userIdx === -1) {
    return res.status(404).json({ success: false, error: "User not found" });
  }

  const botConfig = db.users[userIdx].botConfig || {};
  const currentStatus = botConfig.status || "offline";
  const newStatus = currentStatus === "paused" ? "active" : "paused";

  db.users[userIdx].botConfig = {
    ...botConfig,
    status: newStatus
  };

  writeDb(db);

  // If bot just activated, immediately start polling — no restart needed
  if (newStatus === "active") {
    const token = db.users[userIdx].botConfig?.token;
    if (token) {
      console.log(`[BOT] Toggle ON for user ${userId} — starting poll immediately`);
      pollSingleTelegramBot(userId, token);
    }
  }

  res.json({ success: true, status: newStatus, botConfig: db.users[userIdx].botConfig });
});

// 5. Update User Bot Configuration
router.post("/users/bot/config", async (req, res) => {
  const {
    userId,
    token,
    groupId,
    ownerChatId,
    botLink,
    otpGroupUrl,
    btn1Text,
    btn1Url,
    btn2Text,
    btn2Url,
    btn3Text,
    btn3Url,
  } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, error: "User ID required" });
  }

  // ── Startup safety: GitHub restore complete hone tak wait karo ────────────
  // Only return startingUp:true if the initial restore isn't done yet.
  // After restore is done, we do a fresh GitHub load instead of retrying.
  if (!_startupRestoreDone) {
    return res.status(503).json({
      success: false,
      error: "Server abhi start ho raha hai, please 5-10 second baad dobara try karein.",
      startingUp: true
    });
  }

  // Try cached db first (fast path)
  let db = readDb();
  let userIdx = db.users.findIndex((u: any) => u.id === userId);

  // ── RECOVERY: cached db mein user nahi mila → GitHub se fresh load karo ──
  // Ye Heroku restarts par hota hai jab local cache stale ho.
  // loadDbFromStore() directly GitHub se load karta hai (cache bypass karke).
  if (userIdx === -1) {
    try {
      // Force fresh load by clearing TTL guard
      lastDbLoadTime = 0;
      db = await loadDbFromStore();
      userIdx = db.users.findIndex((u: any) => u.id === userId);
    } catch (loadErr: any) {
      console.warn("[BotConfig] Fresh GitHub load failed:", loadErr?.message);
    }
  }

  if (userIdx === -1) {
    // ── Distinguish two cases ──────────────────────────────────────────────
    // Case A: DB has 0 users → Heroku just restarted and GitHub restore hasn't
    //         finished yet (or GITHUB_PERSONAL_ACCESS_TOKEN not set on Heroku).
    //         Tell frontend to wait/retry — NOT a real user-not-found error.
    // Case B: DB has users but this user isn't among them → genuine mismatch.
    //         Tell frontend to show a helpful message WITHOUT auto-logout.
    // ─────────────────────────────────────────────────────────────────────
    const isEmptyDb = db.users.length === 0;
    console.warn(`[BotConfig] User ${userId} not found after fresh DB load. DB has ${db.users.length} users.`);
    if (isEmptyDb) {
      return res.status(503).json({
        success: false,
        startingUp: true,
        error: "Server abhi start ho raha hai, please 10-15 second baad dobara try karein."
      });
    }
    return res.status(404).json({
      success: false,
      userNotFound: true,
      error: "Account nahi mila. Dobara login karein ya admin se rabta karein."
    });
  }

  const previousConfig = db.users[userIdx].botConfig || {};
  const nextConfig = { ...previousConfig };
  const incomingConfig: Record<string, any> = {
    token, groupId, ownerChatId, botLink, otpGroupUrl,
    btn1Text, btn1Url, btn2Text, btn2Url, btn3Text, btn3Url,
  };
  for (const [key, value] of Object.entries(incomingConfig)) {
    if (value !== undefined) {
      nextConfig[key] = typeof value === "string" ? value.trim() : value;
    }
  }
  if (token !== undefined) {
    nextConfig.status = String(token).trim() ? "active" : "offline";
  }
  db.users[userIdx].botConfig = nextConfig;

  writeDb(db, { forceRemote: true });

  // ── Immediately start polling the new/updated bot — no need to wait for
  // the 10-second pollAllTelegramBots cycle. Delete any existing webhook
  // first so polling mode works (webhook + polling cannot coexist).
  const savedToken = nextConfig.token;
  if (savedToken && nextConfig.status === "active" && !activeBotPollers.has(savedToken)) {
    activeBotPollers.add(savedToken);
    deleteWebhookForBot(savedToken).then(() => {
      pollSingleTelegramBot(userId, savedToken);
    }).catch(() => {
      pollSingleTelegramBot(userId, savedToken);
    });
    console.log(`[BotConfig] Immediately started polling for user ${userId}`);
  }
  // ─────────────────────────────────────────────────────────────────────────

  res.json({ success: true, botConfig: db.users[userIdx].botConfig });
});

// ============================================================
//  REAL WHATSAPP ENDPOINTS
// ============================================================
// NOTE: this endpoint used to also call the legacy requestWhatsAppPairingCode(),
// which opened a SECOND real WhatsApp/Baileys socket and requested a second
// pairing code for the same phone number while the real pairing flow
// (/api/wa/pairing-code in wa-routes.ts) was already in progress. Two
// concurrent pairing requests for the same number caused WhatsApp to
// invalidate the first code, so the phone reported "incorrect code" even
// though the user typed it correctly and in time. This endpoint now only
// persists bookkeeping data to db.json; it does not touch WhatsApp/Baileys.

// 6. Admin Panel password-based authentication
router.post("/admin/login", (req, res) => {
  try {
    const { password } = req.body || {};
    if (password === getAdminPassword()) {
      return res.json({ success: true, message: "Welcome Admin" });
    }
    res.status(401).json({ success: false, error: "Invalid Admin Password" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Get All Users (Admin Only) - Shows emails, usernames, raw passwords, bot tokens, and dates
router.post("/admin/users", (req, res) => {
  try {
    const { password } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const db = readDb();
    let updated = false;
    (db.users || []).forEach((u: any) => {
      if (!u.createdAt) {
        const ts = parseInt(u.id.replace("user_", ""));
        u.createdAt = !isNaN(ts) ? new Date(ts).toISOString() : new Date().toISOString();
        updated = true;
      }
      if (!u.expiryDate) {
        const creationTime = new Date(u.createdAt).getTime();
        u.expiryDate = new Date(creationTime + 30 * 24 * 60 * 60 * 1000).toISOString();
        updated = true;
      }
    });
    if (updated) {
      writeDb(db);
    }

    // Don't leak users' personal Gemini API keys to the admin view — only
    // whether one is set, plus a short preview, so admin can verify without
    // being able to copy/reuse someone else's key.
    const usersForAdmin = (db.users || []).map((u: any) => {
      const key = u.botConfig?.geminiApiKey;
      const { geminiApiKey, ...restBotConfig } = u.botConfig || {};
      return {
        ...u,
        botConfig: {
          ...restBotConfig,
          hasGeminiKey: !!key,
          geminiKeyPreview: key ? `${key.slice(0, 4)}...${key.slice(-4)}` : null
        }
      };
    });

    res.json({ success: true, users: usersForAdmin });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7b. Update User Expiry Date (Admin Only)
router.post("/admin/users/update-date", (req, res) => {
  try {
    const { password, userId, expiryDate } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const db = readDb();
    const user = db.users.find((u: any) => u.id === userId);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    user.expiryDate = expiryDate;
    writeDb(db);
    res.json({ success: true, message: "User expiry date updated successfully" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Super-Admin Broadcast (Sends message to ALL subscribers + WhatsApp channel)
router.post("/admin/broadcast", async (req, res) => {
  const { password, message } = req.body;
  if (password !== getAdminPassword()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  if (!message) {
    return res.status(400).json({ success: false, error: "Announcement message is required." });
  }

  const db = readDb();
  let totalBotsUsed = 0;
  let totalMessagesSent = 0;

  for (const user of db.users) {
    const token = user.botConfig?.token;
    const subs = user.subscribers || [];
    if (!token || subs.length === 0) continue;

    totalBotsUsed++;
    for (const sub of subs) {
      const ok = await sendCustomTelegramMessage(
        token,
        sub.chatId,
        `📢 *Global Announcement from Team Zero Admin* 📢\n\n${message}`
      );
      if (ok) totalMessagesSent++;
    }


  }

  res.json({
    success: true,
    totalBots: totalBotsUsed,
    sentCount: totalMessagesSent,
    message: `Broadcast pushed through ${totalBotsUsed} bots to ${totalMessagesSent} subscribers.`,
  });
});

// Admin — Force trigger API poll immediately
router.post("/admin/force-poll", (req, res) => {
  const { password } = req.body as any;
  if (password !== getAdminPassword()) return res.status(401).json({ success: false, error: "Unauthorized" });
  // Reset isFastPolling guard so next cycle starts immediately
  isFastPolling = false;
  // Trigger async poll — don't await, just fire
  runFastUserApiPoller().catch(() => {});
  res.json({ success: true, message: "API poll triggered — nayi OTPs abhi check ho rahi hain" });
});

// 9. Simulation manually register number on behalf of bot subscribers
router.post("/telegram/subscribers/register", (req, res) => {
  const { userId, chatId, number, country } = req.body;
  if (!userId || !chatId || !number) {
    return res.status(400).json({ success: false, error: "Missing required parameters." });
  }

  registerNumberForSubInDb(userId, Number(chatId), number, country || "Unknown");
  res.json({ success: true, message: "Successfully simulation joined number to subscriber" });
});

// 9b. GET Subscribers (handles query/fallback to flattened list)
router.get("/telegram/subscribers", (req, res) => {
  const { userId } = req.query;
  const db = readDb();
  if (userId) {
    const user = db.users.find((u: any) => u.id === userId);
    return res.json({ success: true, subscribers: user ? (user.subscribers || []) : [] });
  }
  const allSubs = db.users.flatMap((u: any) => u.subscribers || []);
  res.json({ success: true, subscribers: allSubs });
});

router.get("/subscribers", (req, res) => {
  const { userId } = req.query;
  const db = readDb();
  if (userId) {
    const user = db.users.find((u: any) => u.id === userId);
    return res.json({ success: true, subscribers: user ? (user.subscribers || []) : [] });
  }
  const allSubs = db.users.flatMap((u: any) => u.subscribers || []);
  res.json({ success: true, subscribers: allSubs });
});

// 9d. Super-Admin manual SMS/OTP injection
router.post("/admin/sms/send", (req, res) => {
  const { password, number, country, server, message } = req.body;
  if (password !== getAdminPassword()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  if (!number || !server || !message) {
    return res.status(400).json({ success: false, error: "Number, server, and message are required." });
  }

  const db = readDb();
  if (!db.manualSms) db.manualSms = [];

  const otp = {
    timestamp: new Date().toISOString(),
    number: number,
    service: server,
    message: message,
    country: country || "Unknown",
    source: "Manual"
  };

  db.manualSms.unshift(otp);
  if (db.manualSms.length > 500) {
    db.manualSms = db.manualSms.slice(0, 500);
  }
  writeDb(db);
  res.json({ success: true, otp });
});

router.post("/admin/sms/clear", (req, res) => {
  const { password } = req.body;
  if (password !== getAdminPassword()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const db = readDb();
  db.manualSms = [];
  writeDb(db);
  res.json({ success: true });
});

// Helper to broadcast newly added/injected numbers immediately to all registered user bot groups
async function dispatchNewNumbers(newNumbers: any[]) {
  if (!newNumbers || newNumbers.length === 0) return;
  const db = readDb();
  
  for (const user of db.users) {
    const token = user.botConfig?.token;
    const groupId = user.botConfig?.groupId;
    if (!token || !groupId) continue;

    // Build the broadcast message
    let textMsg = `🔥 <b>NEW ACTIVE TEMPORARY LINES DETECTED</b> 🔥\n\n`;
    textMsg += `The following premium virtual lines have been successfully injected and are now active in the pool. Use the bot commands or main menu to claim them instantly!\n\n`;

    newNumbers.forEach((num: any, idx: number) => {
      const country = num.country || "Sudan";
      const flag = getCountryFlag(country);
      const service = num.server || "WhatsApp";
      textMsg += `📍 <b>Line #${idx + 1}:</b> <code>${num.number}</code>\n`;
      textMsg += `   🌍 <b>Country:</b> ${country} ${flag}\n`;
      textMsg += `   🔌 <b>Service:</b> ${service}\n\n`;
    });

    textMsg += `⚡ <b>How to claim:</b> Click <b>📱 Get Number</b> below or type /get_number!`;

    // Send to the Telegram group/channel!
    const inlineKb = getMainKeyboard(user, groupId);
    await sendCustomTelegramMessageWithKeyboard(token, groupId, textMsg, inlineKb);
  }
}

// 9c. Super-Admin manual number management
router.post("/admin/numbers/add", (req, res) => {
  const { password, country, server, numbersText } = req.body;
  if (password !== getAdminPassword()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  if (!country || !server || !numbersText) {
    return res.status(400).json({ success: false, error: "Country, server, and numbers list are required." });
  }

  const lines = numbersText.split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
  const db = readDb();
  if (!db.manualNumbers) db.manualNumbers = [];

  let addedCount = 0;
  let skippedCount = 0;
  const now = new Date().toISOString();
  const newlyAddedNumbers: any[] = [];

  for (const num of lines) {
    const cleanNum = num.replace(/[\s\-\+]/g, "");
    if (!cleanNum) continue;

    // Avoid duplicates in active manual numbers
    const exists = db.manualNumbers.some((n: any) => n.number.replace(/[\s\-\+]/g, "") === cleanNum);
    if (!exists) {
      const newNumObj = {
        id: "num_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
        number: num,
        country: country,
        server: server,
        addedAt: now,
        manuallyAdded: true    // ← ONLY these go to Telegram group & WA channel
      };
      db.manualNumbers.push(newNumObj);
      newlyAddedNumbers.push(newNumObj);
      addedCount++;
    } else {
      skippedCount++;
    }
  }

  writeDb(db);

  // dispatchNewNumbers disabled — sirf OTP messages group mein jaayein
  // if (newlyAddedNumbers.length > 0) {
  //   dispatchNewNumbers(newlyAddedNumbers).catch(err => {
  //     console.error("Error broadcasting new numbers to bot groups:", err);
  //   });
  // }

  res.json({ success: true, addedCount, skippedCount });
});

router.post("/admin/numbers", (req, res) => {
  try {
    const { password } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const db = readDb();
    res.json({ success: true, numbers: db.manualNumbers || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/admin/numbers/delete", (req, res) => {
  try {
    const { password, numberId, numberIds } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const db = readDb();
    if (db.manualNumbers) {
      if (Array.isArray(numberIds)) {
        db.manualNumbers = db.manualNumbers.filter((n: any) => !numberIds.includes(n.id));
      } else if (numberId) {
        db.manualNumbers = db.manualNumbers.filter((n: any) => n.id !== numberId);
      }
    }
    writeDb(db);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete All Manual Numbers
router.post("/admin/numbers/delete-all", (req, res) => {
  try {
    const { password } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const db = readDb();
    db.manualNumbers = [];
    writeDb(db);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete All Manual Numbers of a Specific Country
router.post("/admin/numbers/delete-by-country", (req, res) => {
  try {
    const { password, country } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!country) {
      return res.status(400).json({ success: false, error: "Country is required" });
    }
    const db = readDb();
    if (db.manualNumbers) {
      db.manualNumbers = db.manualNumbers.filter(
        (n: any) => String(n.country || "").trim().toLowerCase() !== country.trim().toLowerCase()
      );
    }
    writeDb(db);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backup db.json
router.post("/admin/db/backup", (req, res) => {
  try {
    const { password } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const db = readDb();
    res.json({ success: true, db });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restore db.json
router.post("/admin/db/restore", (req, res) => {
  try {
    const { password, dbData } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!dbData || typeof dbData !== "object") {
      return res.status(400).json({ success: false, error: "Invalid database structure" });
    }
    
    // Simple validation of db structure
    if (!dbData.users) dbData.users = [];
    if (!dbData.manualNumbers) dbData.manualNumbers = [];
    if (!dbData.globalApiSettings) dbData.globalApiSettings = {};
    if (!dbData.smsLogs) dbData.smsLogs = [];
    
    writeDb(dbData);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET GitHub Config
router.get("/admin/github-config", (req, res) => {
  try {
    const { password } = req.query || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    loadDynamicEnv();
    res.json({
      success: true,
      token: process.env.GITHUB_TOKEN || "",
      repo: process.env.GITHUB_REPO || "",
      path: process.env.GITHUB_PATH || "db.json",
      branch: process.env.GITHUB_BRANCH || "main"
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST GitHub Config
router.post("/admin/github-config", (req, res) => {
  try {
    const { password, token, repo, path: pathFile, branch } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    
    const config = {
      GITHUB_TOKEN: token || "",
      GITHUB_REPO: repo || "",
      GITHUB_PATH: pathFile || "db.json",
      GITHUB_BRANCH: branch || "main"
    };
    
    // Save to github_config_dynamic.json (legacy, in-memory restart safe within same process)
    try {
      fs.writeFileSync(path.join(process.cwd(), "github_config_dynamic.json"), JSON.stringify(config, null, 2), "utf8");
    } catch {}

    // PERMANENT: save into db.json under githubConfig key so it survives server restarts
    try {
      const dbPath = path.join(process.cwd(), "db.json");
      const dbRaw = fs.existsSync(dbPath) ? fs.readFileSync(dbPath, "utf8") : "{}";
      const dbData = JSON.parse(dbRaw);
      dbData.githubConfig = config;
      fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), "utf8");
      // Invalidate cache so next read picks up the new config
      dbCache = dbData;
      lastDbLoadTime = Date.now();
      console.log("[GitHub-Config] ✅ Saved to db.json githubConfig permanently.");
    } catch (dbErr: any) {
      console.error("[GitHub-Config] db.json save error:", dbErr.message);
    }
    
    // Apply immediately to process.env
    process.env.GITHUB_TOKEN = config.GITHUB_TOKEN;
    process.env.GITHUB_REPO = config.GITHUB_REPO;
    process.env.GITHUB_PATH = config.GITHUB_PATH;
    process.env.GITHUB_BRANCH = config.GITHUB_BRANCH;
    
    res.json({ success: true, message: "GitHub configuration saved successfully!" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST Test GitHub Connection
router.post("/admin/db/test-github", async (req, res) => {
  try {
    const { password, token, repo, path: pathFile, branch } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const t = token || process.env.GITHUB_TOKEN;
    const r = repo || process.env.GITHUB_REPO;
    const p = pathFile || process.env.GITHUB_PATH || "db.json";
    const b = branch || process.env.GITHUB_BRANCH || "main";

    if (!t || !r) {
      return res.status(400).json({ success: false, error: "GitHub Token and Repository are required to test." });
    }

    const url = `https://api.github.com/repos/${r}/contents/${p}?ref=${b}`;
    console.log(`[GitHub Test] Testing connection to ${r}/${p} (${b})`);
    
    const response = await fetch(url, {
      headers: {
        "Authorization": `token ${t}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "OTP-Bot-Server-Test"
      }
    });

    if (response.ok) {
      res.json({ success: true, message: "Connection successful! Database read verified." });
    } else {
      const errText = await response.text();
      res.status(400).json({ success: false, error: `GitHub responded: Status ${response.status} - ${errText}` });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: `Connection failed: ${err.message}` });
  }
});

// Server-side Telegram Token Test Proxy (bypasses CORS & IFrame Network blocks!)
router.post("/telegram/test-token", async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, error: "Token is required" });
  }
  try {
    const data = await runTelegramRequest(token, "getMe");
    if (data && data.ok && data.result) {
      res.json({
        success: true,
        botName: data.result.first_name,
        username: data.result.username
      });
    } else {
      res.json({
        success: false,
        error: data && !data.ok ? "Telegram API rejected: Unauthorized/Invalid Token" : "Invalid token or unauthorized"
      });
    }
  } catch (err: any) {
    res.json({
      success: false,
      error: err.message || "Failed to reach Telegram API"
    });
  }
});

// Server-side Telegram Group/Chat Auto-Detect
// Reads recent updates the bot has seen (requires the bot to have been
// added to the group and a message sent there recently) and returns the
// list of distinct chats so the panel can offer the correct chat_id
// instead of the admin guessing/pasting a stale one.
router.post("/telegram/detect-groups", async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, error: "Token is required" });
  }
  try {
    const data = await runTelegramRequest(token, "getUpdates", { limit: 100, timeout: 0 });
    if (!data || !data.ok) {
      return res.json({
        success: false,
        error: data?.description || "Telegram API rejected the request. Check the bot token."
      });
    }
    const seen = new Map<string, any>();
    for (const update of data.result || []) {
      const chat = update.message?.chat || update.channel_post?.chat || update.my_chat_member?.chat;
      if (chat && chat.id !== undefined) {
        seen.set(String(chat.id), {
          id: chat.id,
          title: chat.title || chat.username || chat.first_name || "Private chat",
          type: chat.type
        });
      }
    }
    const chats = Array.from(seen.values());
    if (chats.length === 0) {
      return res.json({
        success: true,
        chats: [],
        hint: "No recent activity seen. Add the bot to your group as admin, send any message in the group, then click Detect again."
      });
    }
    res.json({ success: true, chats });
  } catch (err: any) {
    res.json({ success: false, error: err.message || "Failed to reach Telegram API" });
  }
});

// Server-side Telegram Chat ID Verifier — sends a harmless test message so
// the panel can show the *real* Telegram error (e.g. "chat not found",
// "bot was blocked", "not enough rights") instead of failing silently.
// Also auto-tries -chatId and -100chatId if the original is missing the minus prefix.
router.post("/telegram/test-chat", async (req, res) => {
  const { token, chatId } = req.body || {};
  if (!token || !chatId) {
    return res.status(400).json({ success: false, error: "Token and chatId are required" });
  }
  try {
    const candidates = getTelegramChatIdCandidates(chatId);
    let lastData: any = null;
    for (const candidateId of candidates) {
      const data = await runTelegramRequest(token, "sendMessage", {
        chat_id: candidateId,
        text: "✅ Team Zero test message — this chat is correctly configured to receive OTP forwards."
      });
      lastData = data;
      if (data && data.ok) {
        const hint = String(candidateId) !== String(chatId)
          ? ` ⚠️ Note: Your saved Group ID should be ${candidateId} (with minus prefix).`
          : "";
        return res.json({
          success: true,
          message: `Test message sent successfully.${hint}`,
          resolvedChatId: candidateId
        });
      }
      const desc = (data?.description || "").toLowerCase();
      // Only try alternate IDs for explicit chat-ID-resolution errors.
      // "Bad Request" alone is NOT a reliable chat-ID indicator — it also covers
      // formatting errors, text length, etc.
      if (!desc.includes("chat not found") && !desc.includes("chat_id_invalid")) {
        break;
      }
    }
    const errorDesc = lastData?.description || "Telegram rejected the message. Verify the chat ID and that the bot is a member/admin of the group.";
    const helpHint = errorDesc.toLowerCase().includes("chat not found")
      ? " Make sure: (1) Bot is added to the group as admin, (2) Group ID has - prefix e.g. -1001234567890"
      : "";
    res.json({ success: false, error: errorDesc + helpHint });
  } catch (err: any) {
    res.json({ success: false, error: err.message || "Failed to reach Telegram API" });
  }
});

// ─── Gemini AI Chat Bot — user brings their own Gemini API key ────────────────
// Each user pastes their own key (from https://aistudio.google.com/apikey).
// It is stored on their own botConfig in db.json and used only for that
// user's requests. This is what actually powers both the "AI Chat Bot" panel
// tab and the "Gemini SMS Intelligence Scan" tool below — neither works
// without a key because there is no shared/server-wide GEMINI_API_KEY.
function getUserGeminiKey(userId: string): string | null {
  if (!userId) return process.env.GEMINI_API_KEY || null;
  const db = readDb();
  const user = db.users.find((u: any) => u.id === userId);
  return user?.botConfig?.geminiApiKey || process.env.GEMINI_API_KEY || null;
}

// Google regularly retires specific Gemini model IDs for new users (e.g.
// "gemini-2.5-flash" started returning 404 NOT_FOUND mid-2026 for keys that
// hadn't used it before). Try the current recommended alias first, then fall
// back through older concrete model IDs so the chatbot/analyzer keeps working
// across Google's model rotations without needing a code deploy every time.
const GEMINI_MODEL_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-pro-latest",
];

async function generateWithFallbackModel(ai: any, params: any) {
  let lastErr: any = null;
  for (const model of GEMINI_MODEL_CANDIDATES) {
    try {
      return await ai.models.generateContent({ model, ...params });
    } catch (err: any) {
      lastErr = err;
      const notFound = /404|NOT_FOUND|no longer available/i.test(err?.message || "");
      if (!notFound) throw err; // real error (bad key, quota, etc.) — don't mask it
      console.log(`[Gemini] Model "${model}" unavailable, trying next candidate...`);
    }
  }
  throw lastErr;
}

// Fast OTP extraction using Gemini — called when regex fails (returns PENDING).
// Uses the first available user's Gemini key. 3-second timeout to keep poller fast.
async function extractOtpWithGemini(msg: string, apiKey: string): Promise<string> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Extract ONLY the OTP/verification code from this SMS. Reply with JUST the code (numbers or alphanumeric), nothing else. If no OTP found, reply PENDING.\n\nSMS: ${msg}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const resp = await generateWithFallbackModel(ai, {
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      });
      clearTimeout(timeout);
      const result = (resp.text || "").trim().replace(/[^A-Za-z0-9]/g, "");
      return result.length >= 4 && result.length <= 12 ? result : "PENDING";
    } catch {
      clearTimeout(timeout);
      return "PENDING";
    }
  } catch {
    return "PENDING";
  }
}

const PANEL_KNOWLEDGE_PROMPT = `Aap "TZ AI" hain — TEAM ZERO SMS/OTP panel ka official AI assistant. POWERED BY TEAM ZERO. Owner: Rana Muhammad Usman. Support: @teamzerotrace on Telegram.
Aap HAMESHA Roman Urdu mein baat karte hain (Urdu likha English letters mein), friendly aur seedha andaz mein, jargon kam se kam.

Aap is panel ke baare mein sab kuch jante hain:

1. PANEL KYA HAI: TZ AI (Team Zero) ek SMS/OTP aggregator panel hai jo virtual phone numbers par aane wale OTP/SMS messages ko real-time mein collect karta hai aur Telegram bot ya WhatsApp ke zariye forward karta hai. POWERED BY TEAM ZERO.

2. TELEGRAM BOT KAISE BANAYEN (poora step-by-step):
   a) Telegram par @BotFather ko open karen, "/newbot" bhejen, bot ka naam aur username set karen — BotFather aapko ek Bot Token dega (jaisa: 123456:ABC-DEF...).
   b) Ek naya Telegram group banayen jahan OTPs aani hain, us group mein apna naya bot bhi add karen aur usay ADMIN banayen (warna wo messages nahi bhej sakega).
   c) Panel ke "Deploy My Bot → Telegram Bot" tab mein jaake Bot Token paste karen.
   d) Group Chat ID daalne ke liye do tareeqe hain: (1) "🔎 Auto-detect group ID" button dabayen — bot ko group mein add/admin banane ke baad, group mein koi bhi message bhejen, phir Auto-detect click karen, ye khud group ID nikal lega. (2) Ya phir manually kisi ID-finder bot (@RawDataBot jaisa) se group ka ID nikal ke paste karen.
   e) "🧪 Test" button se confirm karen ke sab sahi hai, phir Save karen.
   f) "CHAT NOT FOUND" ERROR KA SOLUTION: Ye error tab aata hai jab (i) bot us group mein add nahi hai, (ii) bot group mein admin nahi hai, (iii) group ID galat/purani hai (agar group ko dobara banaya ya group type change hua to ID badal jati hai), ya (iv) user ne bot ko block kar diya. Solution: bot ko group mein dobara add + admin banayen, phir "🔎 Auto-detect group ID" dobara chalayen taake fresh/sahi ID mil jaye.

3. WHATSAPP OTP BOT KAISE BANAYEN:
   a) Panel ke "Deploy My Bot → WhatsApp Bot" tab mein apna WhatsApp number (country code ke sath, + ya 0 ke bagair, jaise Pakistan ke liye 923001234567) dalen.
   b) "Link Bot via Pairing Code" par click karen — 8-character pairing code milega jo 60 second ke andar apne WhatsApp app mein jaake enter karna hota hai: WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead".
   c) Link hone ke baad OTP forwarding channel/newsletter link set karen jahan OTPs jayengi.
   d) Agar "Couldn't link device" ya code fail ho: (i) code 60 second ke andar hi enter karen, (ii) sirf ek dafa "Link Bot via Pairing Code" dabayen aur purana code expire hone ka intezar karen phir dobara try karen, (iii) 2-3 minute wait karke retry karen.

4. KONSI COUNTRY KI TRAFFIC HIGH HAI (WhatsApp/imo OTP ke liye): Aam tor par South Asia (Pakistan, India, Bangladesh), Southeast Asia (Indonesia, Philippines, Vietnam), aur Middle East/Africa (Saudi Arabia, Nigeria, Egypt) mein traffic sab se zyada hoti hai.

5. TZ AI CHATBOT: Ye feature TEAM ZERO ke backend AI system se chalta hai. Koi manual API key daalne ki zaroorat nahi — automatically kaam karta hai.

6. VIRTUAL LINE GENERATOR / LIVE OTP STREAM: Home page par public OTP feed hoti hai jahan sabhi active numbers ki OTP dikhti hain real-time mein.

SAKHT PABANDIYAN (STRICT RESTRICTIONS):
- Panel andar se kaun se SMS/number APIs use karta hai — kabhi zikar na karen.
- Admin Portal ki internal detail — kabhi share na karen. Sirf itna: "Admin Portal sirf owner ke liye hai."
- Koi bhi "Gemini", "Google AI", "Replit", ya third-party tool ka naam UI mein na batayen.
Inke ilawa panel ke baare mein har cheez ka jawab khul kar den.`;

// User-facing TZ AI chatbot (powered by backend GEMINI_API_KEY — no per-user key needed)
router.post("/gemini/chat", async (req, res) => {
  try {
    const { userId, message, history, apiKey: clientKey } = req.body || {};
    if (!message) {
      return res.status(400).json({ success: false, error: "Message required" });
    }
    // Priority: client key (localStorage) → env key → admin db key → per-user db key
    const apiKey = clientKey || process.env.GEMINI_API_KEY || getAdminGeminiKey() || getUserGeminiKey(userId);
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: "Gemini API key set nahi hai. AI Chat Bot section mein apni key paste karein aur Activate karen."
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const priorTurns = Array.isArray(history) ? history.slice(-12) : [];
    const contents = [
      ...priorTurns.map((h: any) => ({
        role: h.role === "bot" ? "model" : "user",
        parts: [{ text: String(h.text || "") }]
      })),
      { role: "user", parts: [{ text: String(message) }] }
    ];

    const response = await generateWithFallbackModel(ai, {
      contents,
      config: { systemInstruction: PANEL_KNOWLEDGE_PROMPT }
    });

    res.json({ success: true, reply: response.text });
  } catch (err: any) {
    const detail = err?.message || "Request failed";
    res.status(500).json({ success: false, error: detail });
  }
});

// ── Gemini key status — frontend checks this to decide whether to show chatbot ──
router.get("/gemini/key-status", (_req, res) => {
  const hasKey = !!(process.env.GEMINI_API_KEY) || !!(getAdminGeminiKey());
  res.json({ available: hasKey });
});

// ── Save global admin Gemini key to db.json (no login required) ──────────────
router.post("/gemini/set-admin-key", async (req, res) => {
  const { apiKey, adminPassword } = req.body || {};
  const cleanKey = String(apiKey || "").trim();

  if (!cleanKey) {
    return res.status(400).json({ success: false, error: "API key required hai" });
  }
  if (adminPassword !== getAdminPassword()) {
    return res.status(403).json({ success: false, error: "Admin password galat hai" });
  }

  // Validate key lightly
  try {
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`
    );
    if (checkRes.status === 400 || checkRes.status === 403) {
      return res.status(400).json({
        success: false,
        error: "Ye key valid nahi hai. Google AI Studio (aistudio.google.com/apikey) se sahi key copy karen."
      });
    }
  } catch {
    // Network hiccup — save anyway, real errors surface on first use
  }

  const db = readDb();
  db.adminGeminiKey = cleanKey;
  writeDb(db);

  console.log("[Gemini] Global admin key saved to db.json ✅");
  res.json({ success: true, message: "AI key save ho gayi! Ab chatbot aur scan dono kaam karengi. ✅" });
});

// ── Remove global admin Gemini key ───────────────────────────────────────────
router.post("/gemini/remove-admin-key", (req, res) => {
  const { adminPassword } = req.body || {};
  if (adminPassword !== getAdminPassword()) {
    return res.status(403).json({ success: false, error: "Admin password galat hai" });
  }
  const db = readDb();
  delete db.adminGeminiKey;
  writeDb(db);
  res.json({ success: true });
});

// Save/activate a user's own Gemini API key. Validated with a lightweight
// "list models" call (not generateContent) — this only checks that the key
// itself is real and enabled, without being sensitive to quota, region, or
// a particular model's availability, which previously caused valid keys to
// get rejected as "invalid".
router.post("/gemini/set-key", async (req, res) => {
  const { userId, apiKey } = req.body || {};
  const cleanKey = String(apiKey || "").trim();
  if (!userId || !cleanKey) {
    return res.status(400).json({ success: false, error: "User ID and API key are required" });
  }

  try {
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`
    );
    if (checkRes.status === 400 || checkRes.status === 403) {
      // Genuinely invalid/disabled key — only these statuses mean the key
      // itself is bad. Anything else (429 quota, 5xx, network hiccup) is not
      // proof the key is bad, so we save it and let real usage surface issues.
      const body = await checkRes.json().catch(() => ({}));
      const reason = body?.error?.status || body?.error?.message || "";
      console.log(`[Gemini] set-key rejected for user ${userId}: HTTP ${checkRes.status} ${reason}`);
      return res.status(400).json({
        success: false,
        error: "Ye API key valid nahi hai ya disabled hai. Google AI Studio (aistudio.google.com/apikey) se sahi key copy karke dobara try karen."
      });
    }
  } catch (err: any) {
    console.log(`[Gemini] set-key validation network error for user ${userId}: ${err?.message}`);
    // Network hiccup while validating — don't block the user from saving a
    // key that may well be fine; /gemini/chat will surface a real error if
    // the key truly doesn't work.
  }

  const db = readDb();
  const userIdx = db.users.findIndex((u: any) => u.id === userId);
  if (userIdx === -1) {
    return res.status(404).json({ success: false, error: "User not found" });
  }
  if (!db.users[userIdx].botConfig) db.users[userIdx].botConfig = {};
  db.users[userIdx].botConfig.geminiApiKey = apiKey;
  writeDb(db);

  res.json({ success: true, message: "Gemini API key activated! AI Chat Bot ab ready hai." });
});

// Remove a user's Gemini key (deactivate the AI Chat Bot).
router.post("/gemini/remove-key", (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, error: "User ID required" });
  const db = readDb();
  const userIdx = db.users.findIndex((u: any) => u.id === userId);
  if (userIdx === -1) return res.status(404).json({ success: false, error: "User not found" });
  if (db.users[userIdx].botConfig) delete db.users[userIdx].botConfig.geminiApiKey;
  writeDb(db);
  res.json({ success: true });
});

// 10. Server-side TZ AI SMS Intelligence Scan (uses backend key first, then per-user key)
router.post("/gemini/analyze", async (req, res) => {
  try {
    const { message, userId } = req.body || {};
    if (!message) {
      return res.status(400).json({ success: false, error: "Message content is required" });
    }

    const apiKey = process.env.GEMINI_API_KEY || getAdminGeminiKey() || getUserGeminiKey(userId);
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: "TZ AI abhi available nahi hai. Admin se rabta karen — @teamzerotrace on Telegram.",
      });
    }

    const ai = new GoogleGenAI({ apiKey });

    const response = await generateWithFallbackModel(ai, {
      contents: `Analyze this SMS message:\n"${message}"`,
      config: {
        systemInstruction:
          "You are TZ AI — an expert security and SMS analyzer for TEAM ZERO panel (POWERED BY TEAM ZERO). Analyze the SMS. Determine its intent (e.g., login OTP, subscription confirmation, scam/phishing threat, general notification). Identify the target service/brand and extract the numeric/alphanumeric OTP code or verification link. Return the response in clean, bulleted, bold, concise markdown. Do not mention Gemini, Google, or any AI platform name.",
      },
    });

    res.json({ success: true, analysis: response.text });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── TZ AI Admin Chatbot — SUPER POWERFUL: real data + action execution ──
const TZ_AI_ADMIN_SYSTEM = `Aap "TZ AI" hain — TEAM ZERO ka super-intelligent admin AI assistant. Owner: Rana Muhammad Usman (@teamzerotrace). POWERED BY TEAM ZERO. Hamesha Roman Urdu mein jawab dein.

AAPKI POWERS:
- Aap REAL live data ke saath jawab dete hain — real-time panel state aapko inject ki gayi hai
- Aap actions EXECUTE kar sakte hain (executed actions ka result aapko diya jayega)
- Kabhi bhi "Gemini/Google/AI" ka naam nahi len — sirf "TZ AI" kehna hai

PANEL FEATURES (poori jankari):
1. PUBLIC LIVE LINES: Virtual phone numbers ka pool jahan users OTP receive karte hain. Countries filter kar sakte hain.
2. DEPLOY MY BOT: Users apna Telegram ya WhatsApp bot deploy karte hain. Bot token + group ID se Telegram forward hota hai. WhatsApp: Baileys pairing code se link.
3. ADMIN PANEL (sirf owner): 
   - API Health Monitor: 4 fast APIs (1,2,3,4) + 29+ background APIs ka real-time status
   - Auto Number Add: ON karo + API select karo → jo SMS aaye us number ko service name ke saath panel mein auto-add karo. db.json mein save, permanent.
   - Send Panel Message: Sab users ke Telegram bot groups mein ya WhatsApp pe ek saath message bhejo
   - Global Broadcast: Sab subscribers ko ek saath announcement bhejo
   - Users List: Sab registered users ki details — bot status, subscribers, etc.
   - Numbers Management: Manual numbers add/delete, country-wise download
   - WhatsApp Control: Baileys se WA link/unlink, pairing code generate
   - GitHub Cloud Sync: db.json GitHub mein auto-save (restart ke baad bhi data safe)
   - TZ AI Chatbot: Yani main — real-time data ke saath koi bhi sawal jawab
4. DB.JSON: Flat file database — users, bots, numbers, SMS logs, WA auth, auto-add config, sab kuch
5. GITHUB AUTO-SYNC: Har 45s mein db.json GitHub pe save. Heroku/server restart pe auto-restore.
6. KEEPALIVE: Har 4 minute mein self-ping — server kabhi sleep nahi karta
7. PERMANENT STORAGE: GitHub sync ki wajah se users aur bots kabhi delete nahi hote restart pe

ADMIN ACTIONS (jo aap commands se execute kar sakte hain):
- "API status batao" → sab APIs ka live health check
- "Users dikhao" → sab registered users ki detail
- "Numbers count batao" → pool mein kitne numbers hain
- "WA status" → WhatsApp connection status
- "Polling pause/resume karo" → SMS polling band ya chalu karo
- "Auto-add status" → Auto Number Add ka current config

TROUBLESHOOTING:
- OTPs nahi aa rahe: API Health Monitor mein offline API check karo. Fast pollers (API 1-4) ka status dekhna.
- WA disconnect: Auto-reconnect active hai. Agar phir bhi nahi chala: Admin → WhatsApp → Pairing Code dobara generate.
- Data gayab (Heroku restart): GitHub sync ON hai to auto-restore hoti hai. GITHUB_PERSONAL_ACCESS_TOKEN secret set hona chahiye.
- Build fail Heroku pe: pnpm 10.26.1 via corepack, Node 20+, onlyBuiltDependencies mein baileys/protobufjs/genai approved hain.

Aap seedha, madadgar, aur confident jawab dete hain. AAPKE PAAS REAL DATA HAI — use karo.`;

// ── Execute an admin action and return the result ──
function executeAdminAction(msg: string, db: any): string | null {
  const lower = msg.toLowerCase();

  // "sab APIs ka status dikhao" / "API list" / "kaunsi APIs online hain"
  if (lower.includes("api") && (lower.includes("list") || lower.includes("status") || lower.includes("check") || lower.includes("online") || lower.includes("offline") || lower.includes("sab"))) {
    const onlineApis: string[] = [];
    const offlineApis: string[] = [];
    const pendingApis: string[] = [];
    for (const [name, stat] of Object.entries(apiStats) as [string, any][]) {
      if (stat.lastStatus === "Online") onlineApis.push(name);
      else if (stat.lastStatus === "Offline" || stat.lastStatus === "Error") offlineApis.push(name);
      else pendingApis.push(name);
    }
    for (const [name, stat] of Object.entries(backgroundApiStats) as [string, any][]) {
      if (!apiStats[name]) {
        if (stat.lastStatus === "Online") onlineApis.push(name + " [bg]");
        else if (stat.lastStatus === "Offline" || stat.lastStatus === "Error") offlineApis.push(name + " [bg]");
      }
    }
    return `🔴 LIVE API STATUS (ab is waqt):
✅ ONLINE (${onlineApis.length}): ${onlineApis.join(", ") || "koi nahi"}
❌ OFFLINE/ERROR (${offlineApis.length}): ${offlineApis.join(", ") || "koi nahi"}
⏳ PENDING (${pendingApis.length}): ${pendingApis.join(", ") || "koi nahi"}
Total APIs: ${Object.keys(apiStats).length + Object.keys(backgroundApiStats).length}`;
  }

  // "users dikhao" / "users list" / "kitne users hain"
  if (lower.includes("user") && (lower.includes("list") || lower.includes("dikhao") || lower.includes("kitne") || lower.includes("sab") || lower.includes("batao"))) {
    const users = db.users || [];
    if (users.length === 0) return "❌ Koi user registered nahi hai abhi.";
    const list = users.map((u: any, i: number) => {
      const subs = (u.subscribers || []).length;
      const hasTg = !!u.botConfig?.token;
      const hasGemini = !!(u.botConfig?.geminiApiKey);
      const botStatus = u.botConfig?.status === "active" ? "🟢 Active" : (u.botConfig?.status === "paused" ? "⏸️ Paused" : "⚫ No Token");
      return `${i + 1}. **${u.username}** (${u.email}) | Subscribers: ${subs} | TG Bot: ${hasTg ? "✅" : "❌"} [${botStatus}] | AI: ${hasGemini ? "✅" : "❌"}`;
    }).join("\n");
    return `👥 REGISTERED USERS (${users.length} total):\n${list}`;
  }

  // "numbers count" / "kitne numbers" / "numbers pool"
  if (lower.includes("number") && (lower.includes("count") || lower.includes("kitne") || lower.includes("pool") || lower.includes("total") || lower.includes("batao"))) {
    const nums = db.manualNumbers || [];
    const byCountry: Record<string, number> = {};
    for (const n of nums) {
      const c = n.country || "Unknown";
      byCountry[c] = (byCountry[c] || 0) + 1;
    }
    const countryList = Object.entries(byCountry).map(([c, cnt]) => `${c}: ${cnt}`).join(", ");
    return `📱 NUMBERS POOL: ${nums.length} total\nBy country: ${countryList || "koi nahi"}`;
  }

  // "polling pause/resume"
  if (lower.includes("polling") && (lower.includes("pause") || lower.includes("band") || lower.includes("rok"))) {
    isPollingPaused = true;
    return "⏸️ ACTION EXECUTED: Polling paused kar diya gaya hai. Admin panel mein status update ho jayega.";
  }
  if (lower.includes("polling") && (lower.includes("resume") || lower.includes("start") || lower.includes("chalu") || lower.includes("shuru"))) {
    isPollingPaused = false;
    return "▶️ ACTION EXECUTED: Polling resume kar di gayi hai. APIs wapas check karne lagenge.";
  }

  return null; // No specific action detected
}

router.post("/admin/tz-ai-chat", async (req, res) => {
  try {
    const { password, message, history, context, apiKey: clientKey } = req.body || {};
    if (password !== getAdminPassword()) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    if (!message) {
      return res.status(400).json({ success: false, error: "Message required" });
    }

    // Priority: client-provided key → env key → admin db key
    const apiKey = clientKey || process.env.GEMINI_API_KEY || getAdminGeminiKey();
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        error: "Gemini API key set nahi hai. AI Chat Bot section mein apni key paste karein aur Activate karen."
      });
    }

    // ── 1. Execute any detected admin action ──
    const db = readDb();
    const actionResult = executeAdminAction(message, db);

    // ── 2. Build rich live context ──
    const users = db.users || [];
    const numbers = db.manualNumbers || [];

    // Top 5 API statuses (failed ones first)
    const apiEntries = Object.entries(apiStats) as [string, any][];
    const offlineApis = apiEntries.filter(([, s]) => s.lastStatus !== "Online").slice(0, 5);
    const onlineCount = apiEntries.filter(([, s]) => s.lastStatus === "Online").length;
    const offlineCount = apiEntries.filter(([, s]) => s.lastStatus !== "Online" && s.lastStatus !== "Pending").length;

    const autoAddCfg = autoAddConfig;
    const recentSms = (db.manualSms || []).slice(0, 5);
    const autoAddedNums = (db.manualNumbers || []).filter((n: any) => n.autoAdded);

    const liveContext = `
═══════════════════════════════════════
📊 LIVE ADMIN PANEL DATA (REAL-TIME)
═══════════════════════════════════════
👥 Total Users: ${users.length}
📱 Numbers Pool: ${numbers.length} total (${autoAddedNums.length} auto-added)
🤖 Active Bots: ${users.filter((u: any) => u.botConfig?.token && u.botConfig?.status === "active").length} / ${users.length} users
⏸️ SMS Polling: ${isPollingPaused ? "⏸️ PAUSED" : "▶️ ACTIVE"}
🔄 Auto-Number-Add: ${autoAddCfg.enabled ? `✅ ON (APIs: ${autoAddCfg.apis.join(", ")})` : "❌ OFF"}

📡 FAST API HEALTH (API 1-4):
  • Online: ${onlineCount} / ${apiEntries.length}
  • Offline/Error: ${offlineCount}
${offlineApis.length > 0 ? `  • Problem APIs:\n${offlineApis.map(([n, s]) => `    - ${n}: ${s.lastStatus} | ${s.lastError?.slice(0, 80) || ""}`).join("\n")}` : "  • ✅ Sab fast APIs theek hain!"}

👤 USERS (${users.length} registered):
${users.length > 0 
  ? users.map((u: any, i: number) => `  ${i+1}. ${u.username} (${u.email})\n     Subs: ${(u.subscribers||[]).length} | TG: ${u.botConfig?.token ? "✅ "+u.botConfig.token.slice(0,15)+"..." : "❌"} | AI Key: ${u.botConfig?.geminiApiKey ? "✅" : "❌"}`).join("\n")
  : "  Koi user registered nahi hai."}

📥 RECENT SMS (last 5):
${recentSms.length > 0
  ? recentSms.map((s: any) => `  • ${s.number} | ${s.service || "Unknown"} | ${(s.message||"").slice(0,50)} [${s.source}]`).join("\n")
  : "  Koi recent SMS nahi."}

${actionResult ? `\n🤖 ACTION RESULT:\n${actionResult}` : ""}
${context ? `\nExtra context: ${context}` : ""}
═══════════════════════════════════════`;

    const ai = new GoogleGenAI({ apiKey });
    const priorTurns = Array.isArray(history) ? history.slice(-8) : [];
    const contents = [
      ...priorTurns.map((h: any) => ({
        role: h.role === "ai" ? "model" : "user",
        parts: [{ text: String(h.text || "") }]
      })),
      { role: "user", parts: [{ text: String(message) }] }
    ];

    const response = await generateWithFallbackModel(ai, {
      contents,
      config: { systemInstruction: TZ_AI_ADMIN_SYSTEM + liveContext }
    });

    res.json({ success: true, reply: response.text });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || "TZ AI request failed" });
  }
});

// ── Panel Announcement — in-panel notification banner ────────────────────
// Admin se message set hota hai → panel ke andar sab ko banner mein dikhta hai

// GET /api/panel-announcement — public, frontend poll karta hai har 30s
router.get("/panel-announcement", (req, res) => {
  const db = readDb();
  const ann = db.adminPanelAnnouncement || null;
  res.json({ success: true, announcement: ann });
});

// POST /api/admin/panel-announcement — naya message set karo
router.post("/admin/panel-announcement", (req, res) => {
  const { password, message } = req.body || {};
  if (password !== getAdminPassword()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const text = String(message || "").trim();
  if (!text) {
    return res.status(400).json({ success: false, error: "Message empty nahi hona chahiye" });
  }
  const db = readDb();
  db.adminPanelAnnouncement = { message: text, createdAt: new Date().toISOString() };
  writeDb(db);
  console.log("[PanelAnnounce] Set:", text.slice(0, 80));
  res.json({ success: true });
});

// DELETE /api/admin/panel-announcement — message hatao
router.delete("/admin/panel-announcement", (req, res) => {
  const { password } = req.body || {};
  if (password !== getAdminPassword()) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const db = readDb();
  delete db.adminPanelAnnouncement;
  writeDb(db);
  console.log("[PanelAnnounce] Cleared.");
  res.json({ success: true });
});
// ─────────────────────────────────────────────────────────────────────────

// ── External WA MD Bot: Get SMS by number (for polling) ──────────────────────
// Other WA bots can call this endpoint to check if SMS arrived for a number.
// GET /api/sms/by-number?number=923001234567
router.get("/sms/by-number", (req, res) => {
  try {
    const numberRaw = String(req.query.number || "").trim();
    if (!numberRaw) {
      return res.status(400).json({ success: false, error: "number query param required" });
    }
    const numberClean = numberRaw.replace(/[\s\-\+]/g, "");
    const db = readDb();
    // Search in manualSms AND targetApiSmsHistory
    const allSms: any[] = [
      ...(db.manualSms || []),
      ...(targetApiSmsHistory || [])
    ];
    const matched = allSms
      .filter((s: any) => s && s.number && s.number.replace(/[\s\-\+]/g, "") === numberClean)
      .slice(0, 20);
    res.json({ success: true, sms: matched, count: matched.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Periodic GitHub safety sync — every 4 minutes ────────────────────────────
// Even if there's no panel activity, data is pushed to GitHub regularly.
if (!process.env.VERCEL) {
  setInterval(async () => {
    try {
      if (dbCache && process.env.GITHUB_TOKEN) {
        await saveDbToStore(true);
        console.log("[GitHubSync] ✅ Periodic 4-min safety sync complete");
      }
    } catch (e: any) {
      console.warn("[GitHubSync] Periodic sync error:", e?.message);
    }
  }, 4 * 60 * 1000);
}

// Catch-all for undefined API routes to prevent falling through to SPA HTML
router.all("/{*path}", (req, res) => {
  res.status(404).json({
    success: false,
    error: `API endpoint ${req.method} ${req.path} not found or unsupported method.`
  });
});

export default router;
