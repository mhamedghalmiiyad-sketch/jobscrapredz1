import express from "express";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Required ENV =====
const RUN_TOKEN = process.env.RUN_TOKEN || ""; // protect /run
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ""; // e.g. @your_channel OR -100xxxxxxxxxx

// ===== Scrape config =====
const BASE_URL = process.env.BASE_URL || "https://emploitic.com/offres-d-emploi";
const PAGES = Number(process.env.PAGES || "5");
const KEYWORDS_FILE = process.env.KEYWORDS_FILE || "./keywords.json";
const MAX_RESULTS_PER_RUN = Number(process.env.MAX_RESULTS_PER_RUN || "20");
const MIN_MATCH_TERMS = Number(process.env.MIN_MATCH_TERMS || "1");

// Your profile (maintenance / automation / electricity)
const PROFILE_SEEDS = [
  "maintenance",
  "automat", "automation", "automatis",
  "electr", "électr", "electrotech", "électrotech",
  "instrument", "plc", "scada", "hmi", "dcs",
  "siemens", "schneider", "abb", "beckhoff", "rockwell", "allen",
  "variateur", "vfd", "drive",
  "mecan", "mécan",
  "electromecan", "électromécan",
  "pneumat", "hydraul",
  "hvac", "cvc", "clim", "froid",
  "energi", "énergi",
];

// simple lock to avoid overlapping runs
let isRunning = false;
const seenThisBoot = new Set(); // prevents duplicates within the same running instance

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function loadKeywords(filepath) {
  const raw = fs.readFileSync(filepath, "utf-8");
  const json = JSON.parse(raw);

  // supports:
  // 1) { data: [...] }
  // 2) [ ... ]
  const list = Array.isArray(json) ? json : (json.data || []);
  return list.filter(Boolean).map(String);
}

function buildKeywordBank(allKeywords) {
  const seedsN = PROFILE_SEEDS.map(norm);
  const bank = [];

  for (const kw of allKeywords) {
    const k = norm(kw);
    if (!k) continue;
    if (seedsN.some((s) => k.includes(s))) bank.push(kw);
  }

  // de-dupe + cap
  const uniq = Array.from(new Set(bank));
  return uniq.slice(0, 800);
}

async function telegramSend(html) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, skipping send.");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`[Telegram] sendMessage failed: ${res.status} ${JSON.stringify(data)}`);
  }

  // avoid hitting rate limits
  await sleep(900);
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum > 1) u.searchParams.set("page", String(pageNum));
  else u.searchParams.delete("page");
  return u.toString();
}

async function scrapeJobList(page) {
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= PAGES; p++) {
    const url = buildPageUrl(BASE_URL, p);
    console.log(`[List] Page ${p}: ${url}`);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    try {
      await page.waitForSelector('li[data-testid="jobs-item"]', { timeout: 25000 });
    } catch {
      console.log("  ⚠️ No jobs list found (blocked/empty).");
      continue;
    }

    const items = await page.evaluate(() => {
      function pickTextNearIcon(item, iconTestId) {
        const svg = item.querySelector(`svg[data-testid="${iconTestId}"]`);
        if (!svg) return null;
        const container = svg.closest("div");
        if (!container) return null;
        const txt = container.innerText.replace(/\s+/g, " ").trim();
        return txt || null;
      }

      const nodes = Array.from(document.querySelectorAll('li[data-testid="jobs-item"]'));
      return nodes.map((li) => {
        const a = li.querySelector("a[href]");
        const title = li.querySelector("h2")?.innerText?.trim() || null;
        const company = li.querySelector('[data-testid="jobs-item-company"]')?.innerText?.trim() || null;

        const location = pickTextNearIcon(li, "RoomRoundedIcon");
        const posted = pickTextNearIcon(li, "AccessTimeRoundedIcon");
        const experience = pickTextNearIcon(li, "StarsRoundedIcon");

        return {
          title,
          company,
          location,
          posted,
          experience,
          url: a ? a.href : null,
        };
      });
    });

    for (const j of items) {
      if (!j.url) continue;
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      all.push(j);
    }
  }

  return all;
}

async function scrapeJobDetails(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 60000 });

  const details = await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const title =
      document.querySelector("h1")?.innerText?.trim() ||
      document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
      null;

    // try to find a good text block
    const main = document.querySelector("main") || document.body;
    const text = clean(main?.innerText || "");

    // try to cut around common headings
    const candidates = ["Responsabilit", "Compétence", "Competence", "Profil", "Missions", "Description"];
    let snippet = "";
    for (const c of candidates) {
      const idx = text.toLowerCase().indexOf(c.toLowerCase());
      if (idx !== -1) {
        snippet = text.slice(idx, idx + 450);
        break;
      }
    }
    if (!snippet) snippet = text.slice(0, 450);

    return { title, snippet };
  });

  return details;
}

function matchJob(job, keywordBank) {
  const hay = norm(`${job.title || ""} ${job.company || ""} ${job.location || ""}`);

  // quick filter: must match at least MIN_MATCH_TERMS seeds
  const seedHits = PROFILE_SEEDS.map(norm).filter((s) => hay.includes(s));
  if (new Set(seedHits).size < MIN_MATCH_TERMS) return null;

  // show matched keywords (from Emploitic keyword bank) — limited to keep it small
  const matched = [];
  for (const kw of keywordBank) {
    const k = norm(kw);
    if (!k || k.length < 3) continue;
    if (hay.includes(k)) matched.push(kw);
    if (matched.length >= 8) break;
  }

  return { seedHits: Array.from(new Set(seedHits)).slice(0, 8), matchedKeywords: matched };
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function runOnce() {
  if (isRunning) return { ok: false, reason: "already_running" };
  isRunning = true;

  try {
    const allKeywords = loadKeywords(KEYWORDS_FILE);
    const keywordBank = buildKeywordBank(allKeywords);

    console.log(`[Init] keywords loaded=${allKeywords.length}, bank=${keywordBank.length}`);

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const pageList = await browser.newPage();
    const pageDetail = await browser.newPage();

    // speed up
    for (const p of [pageList, pageDetail]) {
      await p.setViewport({ width: 1280, height: 800 });
      await p.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
      );
      await p.setRequestInterception(true);
      p.on("request", (req) => {
        const t = req.resourceType();
        if (t === "image" || t === "font" || t === "media") req.abort();
        else req.continue();
      });
    }

    const jobs = await scrapeJobList(pageList);
    console.log(`[List] scraped jobs=${jobs.length}`);

    const matchedJobs = [];
    for (const job of jobs) {
      if (!job.url) continue;
      if (seenThisBoot.has(job.url)) continue;

      const m = matchJob(job, keywordBank);
      if (!m) continue;

      matchedJobs.push({ job, match: m });
      if (matchedJobs.length >= MAX_RESULTS_PER_RUN) break;
    }

    if (matchedJobs.length === 0) {
      await browser.close();
      return { ok: true, sent: 0, message: "no_matches" };
    }

    // header
    const now = new Date().toISOString();
    await telegramSend(
      `🛠️ <b>Emploitic - Jobs match (Maintenance/Automation)</b>\n` +
      `🗓️ ${escapeHtml(now)}\n` +
      `🔎 Found: <b>${matchedJobs.length}</b> (from ${jobs.length} scraped)\n`
    );

    let sent = 0;

    for (const item of matchedJobs) {
      const { job, match } = item;

      // mark seen ASAP
      seenThisBoot.add(job.url);

      let details = null;
      try {
        details = await scrapeJobDetails(pageDetail, job.url);
      } catch (e) {
        console.log(`[Detail] failed ${job.url}: ${e.message}`);
      }

      const title = escapeHtml(details?.title || job.title || "Offre");
      const company = escapeHtml(job.company || "");
      const location = escapeHtml(job.location || "");
      const posted = escapeHtml(job.posted || "");
      const exp = escapeHtml(job.experience || "");
      const snippet = escapeHtml(details?.snippet || "").slice(0, 380);

      const seeds = match.seedHits.map(escapeHtml).join(", ");
      const kws = match.matchedKeywords.map(escapeHtml).join(", ");

      const msg =
        `📌 <b>${title}</b>\n` +
        (company ? `🏢 ${company}\n` : "") +
        (location ? `📍 ${location}\n` : "") +
        ((posted || exp) ? `🕒 ${posted} ${exp ? `| ⭐ ${exp}` : ""}\n` : "") +
        (seeds ? `✅ Match: <i>${seeds}</i>\n` : "") +
        (kws ? `🔑 Keywords: <i>${kws}</i>\n` : "") +
        `🔗 ${escapeHtml(job.url)}\n` +
        (snippet ? `\n📝 ${snippet}…` : "");

      await telegramSend(msg);
      sent++;
    }

    await browser.close();
    return { ok: true, sent };
  } finally {
    isRunning = false;
  }
}

// ===== Routes =====
app.get("/health", (req, res) => res.status(200).send("ok"));

app.get("/run", async (req, res) => {
  const token = req.query.token || "";
  if (!RUN_TOKEN || token !== RUN_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });

  // respond fast, run in background
  res.status(202).json({ ok: true, started: true });

  try {
    const result = await runOnce();
    console.log("[Run] result:", result);
  } catch (e) {
    console.error("[Run] failed:", e);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
