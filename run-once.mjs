import fs from "fs";
import crypto from "crypto";
import puppeteer from "puppeteer";
import { createClient } from "redis";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return "true";
  return v;
}

const BASE_URL = process.env.BASE_URL || arg("url", "https://emploitic.com/offres-d-emploi");
const PAGES = Number(process.env.PAGES || arg("pages", "5"));
const KEYWORDS_FILE = process.env.KEYWORDS_FILE || arg("keywords", "./keywords.cleaned.json");

// Telegram
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // ex: "@my_channel" OR "-100xxxxxxxxxx"

// Filtering (you can add/remove)
const DEFAULT_STEMS = [
  "automat", "automatis", "plc", "api", "scada", "hmi",
  "siemens", "schneider", "abb", "omron",
  "maintenance", "electr", "électr", "electromecan", "électromécan",
  "instrument", "metrologie", "mécan", "mecan",
  "industrial", "industrie", "energi", "énergie",
  "technicien", "ingénieur", "ingenieur"
];
const INTEREST_STEMS = (process.env.INTEREST_STEMS || DEFAULT_STEMS.join(","))
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Redis (optional but recommended)
const REDIS_URL = process.env.REDIS_URL || ""; // from Render Key Value
const DEDUPE_DAYS = Number(process.env.DEDUPE_DAYS || "90");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum > 1) u.searchParams.set("page", String(pageNum));
  else u.searchParams.delete("page");
  return u.toString();
}

function loadKeywordsList(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  // support both formats you used
  const arr =
    Array.isArray(raw) ? raw :
    Array.isArray(raw.data) ? raw.data :
    Array.isArray(raw.keywords) ? raw.keywords :
    [];
  return arr.map(String).map(s => s.trim()).filter(Boolean);
}

function buildInterestKeywords(allKeywords) {
  const stems = INTEREST_STEMS.map(norm);
  const out = [];
  for (const k of allKeywords) {
    const nk = norm(k);
    if (!nk) continue;
    if (stems.some(st => nk.includes(st))) out.push(k);
  }
  // add stems themselves as match terms
  for (const st of INTEREST_STEMS) out.push(st);
  // unique
  return [...new Set(out.map(x => x.trim()).filter(Boolean))];
}

function isMatch(text, interestKeywords) {
  const t = norm(text);
  if (!t) return false;
  // Fast-ish: check stems first
  if (INTEREST_STEMS.some(st => t.includes(norm(st)))) return true;

  // Then check site keywords subset
  for (const k of interestKeywords) {
    const nk = norm(k);
    if (nk && nk.length >= 3 && t.includes(nk)) return true;
  }
  return false;
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tgSend(html) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const body = {
    chat_id: TG_CHAT_ID,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) {
    throw new Error(`Telegram error: ${res.status} ${JSON.stringify(j)}`);
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

async function makeDedupe() {
  if (!REDIS_URL) {
    // fallback: in-memory only (not persistent on Render)
    const mem = new Set();
    return {
      async seen(url) { return mem.has(url); },
      async mark(url) { mem.add(url); }
    };
  }

  const client = createClient({ url: REDIS_URL });
  client.on("error", (e) => console.error("Redis error:", e?.message || e));
  await client.connect();

  return {
    async seen(url) {
      const key = `emploitic:seen:${sha1(url)}`;
      const v = await client.get(key);
      return !!v;
    },
    async mark(url) {
      const key = `emploitic:seen:${sha1(url)}`;
      await client.set(key, "1", { EX: DEDUPE_DAYS * 24 * 3600 });
    },
    async close() { await client.quit().catch(() => {}); }
  };
}

async function scrapeListPages(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "font" || t === "media") req.abort();
    else req.continue();
  });

  const all = [];
  const seen = new Set();

  for (let p = 1; p <= PAGES; p++) {
    const url = buildPageUrl(BASE_URL, p);
    console.log(`[List] Page ${p}: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    try {
      await page.waitForSelector('li[data-testid="jobs-item"]', { timeout: 30000 });
    } catch {
      console.log("  ⚠️ No jobs list found");
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

      return Array.from(document.querySelectorAll('li[data-testid="jobs-item"]')).map(li => {
        const a = li.querySelector("a[href]");
        return {
          title: li.querySelector("h2")?.innerText?.trim() || null,
          company: li.querySelector('[data-testid="jobs-item-company"]')?.innerText?.trim() || null,
          location: pickTextNearIcon(li, "RoomRoundedIcon"),
          posted: pickTextNearIcon(li, "AccessTimeRoundedIcon"),
          experience: pickTextNearIcon(li, "StarsRoundedIcon"),
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

    await sleep(500);
  }

  await page.close();
  return all;
}

async function scrapeJobDetails(browser, url) {
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "font" || t === "media") req.abort();
    else req.continue();
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("h1", { timeout: 20000 }).catch(() => {});

  const details = await page.evaluate(() => {
    const title = document.querySelector("h1")?.innerText?.trim() || null;

    const main = document.querySelector("main") || document.body;
    const text = (main?.innerText || "")
      .replace(/\s+/g, " ")
      .trim();

    // Try to grab a useful snippet near “Responsabilit” or “Compétence”
    const lower = text.toLowerCase();
    const idx =
      lower.indexOf("responsabil") >= 0 ? lower.indexOf("responsabil") :
      lower.indexOf("compét") >= 0 ? lower.indexOf("compét") :
      -1;

    const snippet = (idx >= 0 ? text.slice(idx, idx + 500) : text.slice(0, 500)).trim();

    return { title, snippet };
  });

  await page.close();
  return details;
}

async function main() {
  const allKeywords = loadKeywordsList(KEYWORDS_FILE);
  const interestKeywords = buildInterestKeywords(allKeywords);

  const dedupe = await makeDedupe();

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const list = await scrapeListPages(browser);
    console.log(`[List] total scraped: ${list.length}`);

    const matches = [];
    for (const j of list) {
      const hay = `${j.title || ""} ${j.company || ""} ${j.location || ""}`;
      if (!isMatch(hay, interestKeywords)) continue;
      matches.push(j);
    }

    console.log(`[Filter] matches from list: ${matches.length}`);

    let sent = 0;
    for (const j of matches) {
      if (await dedupe.seen(j.url)) continue;

      const d = await scrapeJobDetails(browser, j.url).catch(() => ({ title: j.title, snippet: "" }));

      const html =
        `<b>${escapeHtml(d.title || j.title || "Offre")}</b>\n` +
        (j.company ? `🏢 ${escapeHtml(j.company)}\n` : "") +
        (j.location ? `📍 ${escapeHtml(j.location)}\n` : "") +
        (j.experience ? `⭐ ${escapeHtml(j.experience)}\n` : "") +
        (j.posted ? `🕒 ${escapeHtml(j.posted)}\n` : "") +
        (d.snippet ? `📝 ${escapeHtml(d.snippet)}\n` : "") +
        `🔗 ${escapeHtml(j.url)}\n`;

      await tgSend(html);
      await dedupe.mark(j.url);
      sent++;

      await sleep(700); // be nice to Telegram + site
    }

    console.log(`✅ Sent ${sent} new matching jobs.`);
  } finally {
    await browser.close().catch(() => {});
    await dedupe.close?.();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
