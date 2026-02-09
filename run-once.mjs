import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { fileURLToPath } from 'url';

// Activate Stealth Mode
puppeteer.use(StealthPlugin());

function argEnv(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function toAbs(p) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function escapeHtml(s) {
  return String(s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanPostText(text) {
    let t = text || "";
    t = t.replace(/\n\s*\n/g, "\n");
    return t.trim();
}

function pickSnippet(fullText, maxLen = 800) {
    let t = cleanPostText(fullText);
    if (t.length > maxLen) t = t.slice(0, maxLen - 1) + "…";
    return t;
}

function parseKeywordsFile(filePath) {
  const data = readJsonSafe(filePath, null);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function makeKeywordBank(allKeywords, seeds) {
  const seedNorm = seeds.map(norm).filter(Boolean);
  const bank = new Set();
  for (const s of seeds) bank.add(String(s).trim());
  for (const k of allKeywords) {
    const nk = norm(k);
    if (!nk) continue;
    for (const s of seedNorm) {
      if (s && nk.includes(s)) {
        bank.add(String(k).trim());
        break;
      }
    }
  }
  ["automate", "plc", "scada", "hmi", "gmao", "instrumentation", "electrotechnique", "maintenance industrielle", "electricite", "électricité", "automatisme", "automation", "technicien", "ingenieur"].forEach((x) => bank.add(x));
  return Array.from(bank).filter(Boolean);
}

function matchBank(text, bank) {
  const t = norm(text);
  const hits = [];
  for (const k of bank) {
    const kk = norm(k);
    if (!kk) continue;
    if (t.includes(kk)) hits.push(k);
    if (hits.length >= 10) break;
  }
  return hits;
}

async function sendTelegramMessage({ token, chatId, textHtml }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true };
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) console.error(`Telegram error: ${await r.text()}`);
}

async function safeClick(page, selector) {
    try {
        if (await page.$(selector)) {
            await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
            return true;
        }
    } catch {}
    return false;
}

// --- MODULE: GSK ---
async function scrapeGSK(page) {
    const jobs = [];
    try {
        await page.goto("https://jobs.gsk.com/en-gb/jobs?keywords=Algeria&page=1", { waitUntil: "domcontentloaded", timeout: 60000 });
        await safeClick(page, '#pixel-consent-accept-button');
        try { await page.waitForSelector('a[href*="/jobs/"]', { timeout: 10000 }); } catch {}
        const items = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/jobs/"]')).map(a => ({
             title: a.innerText.trim(),
             company: "GSK",
             location: a.closest('div')?.innerText.match(/Location\s*\n\s*(.*)/i)?.[1] || "Algeria",
             url: a.href,
             posted: "Recent",
             source: "GSK"
        })).filter(x => x.url.includes('/jobs/') && x.title.length>3));
        const u = new Map(); items.forEach(i => u.set(i.url, i));
        jobs.push(...u.values());
    } catch (e) {}
    return jobs;
}

// --- MODULE: EMPLOITIC ---
async function scrapeEmploitic(page, baseUrl, pageNum) {
    const url = new URL(baseUrl);
    if(pageNum>1) url.searchParams.set("page", pageNum); else url.searchParams.delete("page");
    await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: 60000 });
    return await page.evaluate(() => Array.from(document.querySelectorAll('li[data-testid="jobs-item"]')).map(li => ({
        title: li.querySelector("h2")?.innerText?.trim(),
        company: li.querySelector('[data-testid="jobs-item-company"]')?.innerText?.trim(),
        location: li.querySelector('svg[data-testid="RoomRoundedIcon"]')?.closest("div")?.innerText?.trim(),
        posted: li.querySelector('svg[data-testid="AccessTimeRoundedIcon"]')?.closest("div")?.innerText?.trim(),
        experience: li.querySelector('svg[data-testid="StarsRoundedIcon"]')?.closest("div")?.innerText?.trim(),
        url: li.querySelector("a[href]")?.href,
        source: "Emploitic"
    })).filter(x => x.url));
}

// --- CORE EXECUTOR ---
export async function runOnce({ reason = "manual", bankOnly = false } = {}) {
  const EMPLOITIC_URL = argEnv("SCRAPE_URL", "https://emploitic.com/offres-d-emploi");
  const PAGES = Number(argEnv("SCRAPE_PAGES", "3"));
  const MAX_SEND = Number(argEnv("MAX_SEND", "15"));
  const KEYWORDS_FILE = argEnv("KEYWORDS_FILE", "keywords.cleaned.json");
  const TELEGRAM_BOT_TOKEN = argEnv("TELEGRAM_BOT_TOKEN", "");
  const TELEGRAM_CHAT_ID = argEnv("TELEGRAM_CHAT_ID", "");
  const STATE_DIR = argEnv("STATE_DIR", process.cwd());
  const SENT_FILE = path.join(STATE_DIR, "sent-urls.json");

  // SEND START MESSAGE
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await sendTelegramMessage({
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
          textHtml: `🚀 <b>WORM-AI Initiated</b>\nScanning Emploitic & GSK...`
      });
  }

  const seeds = String(argEnv("KEYWORD_SEEDS", "automation,automatisme,maintenance,electricite,électricité,électrique,instrumentation,plc,automate,scada,hmi,ingénieur,technicien")).split(",").map(s => s.trim()).filter(Boolean);
  const allKeywords = parseKeywordsFile(toAbs(KEYWORDS_FILE));
  const bank = makeKeywordBank(allKeywords, seeds);

  if (bankOnly) return { ok: true, reason, bankSize: bank.length };

  const sentState = readJsonSafe(SENT_FILE, { sent: {} });
  const sent = sentState.sent || {};

  // KEEPING MEMORY OPTIMIZATIONS (Just in case)
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu"
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 768 });
  
  // BLOCK ASSETS TO SAVE BANDWIDTH/RAM
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) req.abort();
    else req.continue();
  });

  const allJobs = [];
  const seen = new Set();

  // 1. EMPLOITIC SCAN
  for (let p = 1; p <= PAGES; p++) {
      try {
          const items = await scrapeEmploitic(page, EMPLOITIC_URL, p);
          items.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});
      } catch {}
      await sleep(1000);
  }

  // 2. GSK SCAN
  const gskJobs = await scrapeGSK(page);
  gskJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});

  console.log(`[WORM-AI] Total Intelligence Gathered: ${allJobs.length}`);
  
  // FILTER & RANK
  const candidates = [];
  for (const j of allJobs) {
    if (sent[j.url]) continue;

    if (j.source === "GSK") {
        candidates.push({ ...j, hits: ["GSK-Target"], score: 999 });
    } else {
        const hay = `${j.title} ${j.company} ${j.location}`;
        const hits = matchBank(hay, bank);
        if (hits.length) candidates.push({ ...j, hits, score: hits.length });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const toSend = candidates.slice(0, MAX_SEND);
  let sentCount = 0;

  for (const j of toSend) {
    let detailText = ""; 
    // Emploitic sometimes needs a visit to get full details, but let's skip to save RAM if not needed
    // or keep it light:
    if (j.source === "GSK") {
         try {
            await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 15000 });
            detailText = await page.evaluate(() => document.querySelector(".job-description")?.innerText || "");
        } catch {}
    }

    const snippet = pickSnippet(detailText || j.title, 600);
    const matched = (j.hits || []).slice(0, 6).join(", ");
    
    const msg =
      `<b>${escapeHtml(j.title || "Nouvelle Offre Détectée")}</b>\n` +
      `🏢 <b>${escapeHtml(j.company || "")}</b>\n` +
      `📍 ${escapeHtml(j.location || "Algérie")}\n` +
      `🕒 ${escapeHtml(j.posted || "")}\n\n` +
      (matched ? `🔑 <b>Tags:</b> ${escapeHtml(matched)}\n\n` : "") +
      `📄 <b>Résumé:</b>\n<i>${escapeHtml(snippet)}</i>\n\n` +
      `<a href="${escapeHtml(j.url)}">👉 CLIQUEZ ICI POUR POSTULER</a>`;

    await sendTelegramMessage({ token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID, textHtml: msg });
    sent[j.url] = { at: new Date().toISOString(), title: j.title || "" };
    sentCount++;
    await sleep(2000);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify({ sent }, null, 2), "utf-8");

  await browser.close();

  // FINAL REPORT
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const summaryMsg = 
        `🏁 <b>Mission Report</b>\n\n` +
        `🔎 <b>Sources:</b> Emploitic (${PAGES} pg) + GSK\n` +
        `📊 <b>Found:</b> ${allJobs.length} total\n` +
        `✅ <b>Matches:</b> ${candidates.length}\n` +
        `📩 <b>Sent:</b> ${sentCount}`;

      await sendTelegramMessage({
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
          textHtml: summaryMsg
      });
  }

  return { ok: true, scanned: allJobs.length, matched: candidates.length, sent: sentCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runOnce({ reason: 'manual_cli' });