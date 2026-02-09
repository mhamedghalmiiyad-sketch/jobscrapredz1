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

// --- NETTOYAGE DU TEXTE ---
function cleanPostText(text) {
    let t = text || "";
    t = t.replace(/Feed post number \d+/gi, "")
         .replace(/\d+ followers/gi, "")
         .replace(/Visible to anyone on or off LinkedIn/gi, "")
         .replace(/\d+[dDhHmM] •/g, "")
         .replace(/Show translation/gi, "")
         .replace(/Like Comment Repost Send/gi, "")
         .replace(/See more/gi, "")
         .replace(/\d+ comments/gi, "")
         .replace(/\d+ reposts/gi, "");
    
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

function parseNetscapeCookies(text) {
    const cookies = [];
    text.split('\n').forEach(line => {
        if (line.startsWith('#') || line.trim() === '') return;
        const parts = line.split('\t');
        if (parts.length >= 7) {
            cookies.push({
                domain: parts[0],
                path: parts[2],
                secure: parts[3] === 'TRUE',
                expires: parseInt(parts[4]),
                name: parts[5],
                value: parts[6].trim()
            });
        }
    });
    return cookies;
}

// --- NEW HELPER: GET LINKS (REMOTE OR LOCAL) ---
async function getTargetLinks() {
    const remoteUrl = argEnv("LINKS_URL", "");
    const localFile = argEnv("LINKS_FILE", "links.txt");
    let links = [];

    // 1. Try Remote URL first
    if (remoteUrl && remoteUrl.startsWith("http")) {
        console.log(`[Config] Fetching target list from Remote Command Center...`);
        try {
            const resp = await fetch(remoteUrl);
            if (resp.ok) {
                const text = await resp.text();
                links = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
                console.log(`[Config] Acquired ${links.length} targets from cloud.`);
                return links;
            }
        } catch (e) {
            console.warn(`[Config] Remote fetch failed: ${e.message}`);
        }
    }

    // 2. Fallback to Local File
    const localPath = toAbs(localFile);
    if (fs.existsSync(localPath)) {
        console.log(`[Config] Reading local target file: ${localFile}`);
        const text = fs.readFileSync(localPath, 'utf-8');
        links = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("#"));
        return links;
    }

    console.warn("[Config] NO TARGETS FOUND (No LINKS_URL and no links.txt)");
    return [];
}

// --- AUTHENTICATION MODULE ---
async function loginToLinkedIn(page) {
    console.log("[Auth] Initiating LinkedIn Infiltration...");
    const cookiePath = toAbs(argEnv("LINKEDIN_COOKIE_FILE", "linkedin.json"));
    
    if (fs.existsSync(cookiePath)) {
        console.log(`[Auth] Loading cookies from ${cookiePath}`);
        try {
            const raw = fs.readFileSync(cookiePath, 'utf-8');
            let cookies = [];
            if (raw.trim().startsWith('[') || raw.trim().startsWith('{')) {
                cookies = JSON.parse(raw);
            } else {
                cookies = parseNetscapeCookies(raw);
            }
            if (cookies.length > 0) await page.setCookie(...cookies);
        } catch (e) {
            console.warn("[Auth] Cookie parse error:", e.message);
        }
    }

    console.log("[Auth] Verifying Session...");
    try {
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {}
    
    const isLoggedIn = await page.evaluate(() => {
        return !!(document.querySelector('.global-nav__me-photo') || window.location.href.includes('/feed'));
    });

    if (isLoggedIn) {
        console.log("[Auth] Session Active ✅");
        return true;
    }

    console.warn("[Auth] ❌ Session Dead. Please refresh cookies locally.");
    return false;
}

// --- MODULE: COMPANY POSTS ---
async function scrapeLinkedInCompanyPosts(page, rawLink, bank) {
    let url = rawLink.trim();
    if (!url.includes("/posts/")) {
        url = url.replace(/\/$/, "") + "/posts/?feedView=all";
    }
    
    console.log(`[LinkedIn-Posts] Targeting: ${url}`);
    const posts = [];
    
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await safeClick(page, '.modal__dismiss');
        
        await page.evaluate(async () => {
            const distance = 800;
            for(let i=0; i<8; i++) { 
                window.scrollBy(0, distance);
                await new Promise(r => setTimeout(r, 600));
            }
        });
        
        await page.evaluate(() => {
            document.querySelectorAll('.feed-shared-inline-show-more-text__see-more-less-toggle').forEach(b => b.click());
        });
        await sleep(1500);

        const extracted = await page.evaluate(() => {
            const nodes = Array.from(document.querySelectorAll('div.feed-shared-update-v2, li.mb-2, div.occludable-update'));
            return nodes.map(node => {
                const fullText = node.innerText || node.textContent || "";
                const timeEl = node.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]') ||
                               node.querySelector('.feed-shared-actor__sub-description');
                const timeText = timeEl ? timeEl.innerText.trim().split("•")[0].trim() : "";
                const companyEl = node.querySelector('.update-components-actor__title span[dir="ltr"] span') ||
                                  node.querySelector('.feed-shared-actor__title');
                const company = companyEl ? companyEl.innerText.trim() : "LinkedIn Company";

                let directLink = window.location.href;
                const urnContainer = node.closest('[data-urn]');
                if (urnContainer) {
                    const urn = urnContainer.getAttribute('data-urn');
                    directLink = `https://www.linkedin.com/feed/update/${urn}/`;
                }

                return {
                    text: fullText.trim(),
                    timeRaw: timeText,
                    url: directLink,
                    company: company
                };
            });
        });

        console.log(`[LinkedIn-Posts] Raw candidates found: ${extracted.length}`);

        for (const p of extracted) {
            if (!p.text || p.text.length < 5) continue;

            const hasCVKeyword = /\b(cv|c\.v|curriculum|resume|envoyer|recrute|opérateur|hassi|job|offre)\b/i.test(p.text);
            const techMatches = matchBank(p.text, bank);
            const hasTechKeyword = techMatches.length > 0;

            if (!hasCVKeyword && !hasTechKeyword) continue;

            const t = p.timeRaw.toLowerCase();
            let isRecent = false;
            if (t.includes("m") && !t.includes("mo") && !t.includes("mar") && !t.includes("mai")) isRecent = true;
            else if (t.includes("h")) isRecent = true;
            else if (t.includes("d") || t.includes("j")) isRecent = true;
            else if (t.includes("w") || t.includes("sem")) {
                const num = parseInt(t.match(/\d+/)?.[0] || "99");
                if (num <= 1) isRecent = true; 
            }
            if (!t) isRecent = false;

            if (isRecent) {
                let hitTags = [];
                if (hasCVKeyword) hitTags.push("Recrutement");
                if (hasTechKeyword) hitTags.push(...techMatches.slice(0, 3));

                posts.push({
                    title: `📢 Post: ${p.company}`,
                    company: p.company,
                    location: "LinkedIn Feed",
                    posted: p.timeRaw,
                    url: p.url,
                    source: "LinkedIn-Post",
                    fullText: p.text,
                    hits: hitTags
                });
            }
        }
        console.log(`[LinkedIn-Posts] Filtered to ${posts.length} relevant posts.`);
    } catch (e) {
        console.warn(`[LinkedIn-Posts] Failed: ${e.message}`);
    }
    return posts;
}

// --- EXISTING MODULES ---
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

  // --- 1. START ALERT ---
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      await sendTelegramMessage({
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
          textHtml: `🚀 <b>WORM-AI Initiated</b>\nStarting Intelligence Gathering...`
      });
  }

  const seeds = String(argEnv("KEYWORD_SEEDS", "automation,automatisme,maintenance,electricite,électricité,électrique,instrumentation,plc,automate,scada,hmi,ingénieur,technicien")).split(",").map(s => s.trim()).filter(Boolean);
  const allKeywords = parseKeywordsFile(toAbs(KEYWORDS_FILE));
  const bank = makeKeywordBank(allKeywords, seeds);

  if (bankOnly) return { ok: true, reason, bankSize: bank.length };

  const companyLinks = await getTargetLinks();
  const sentState = readJsonSafe(SENT_FILE, { sent: {} });
  const sent = sentState.sent || {};

  const browser = await puppeteer.launch({
    headless: "new", 
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 768 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "font", "media"].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  const allJobs = [];
  const seen = new Set();
  const isAuthenticated = await loginToLinkedIn(page);

  // SCRAPE EMPLOITIC
  for (let p = 1; p <= PAGES; p++) {
      try {
          const items = await scrapeEmploitic(page, EMPLOITIC_URL, p);
          items.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});
      } catch {}
      await sleep(1000);
  }

  // SCRAPE GSK
  const gskJobs = await scrapeGSK(page);
  gskJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});

  // SCRAPE LINKEDIN POSTS
  if (isAuthenticated) {
      for (const link of companyLinks) {
          const posts = await scrapeLinkedInCompanyPosts(page, link, bank);
          posts.forEach(j => { 
              const uniqueId = j.url;
              if(!seen.has(uniqueId)) { seen.add(uniqueId); allJobs.push(j); }
          });
          await sleep(2000);
      }
  } else {
      console.warn("[WORM-AI] Skipping LinkedIn Posts (Auth Failed)");
  }

  console.log(`[WORM-AI] Total Intelligence Gathered: ${allJobs.length}`);
  const candidates = [];
  for (const j of allJobs) {
    if (sent[j.url]) continue;

    if (j.source === "GSK") candidates.push({ ...j, hits: ["GSK-Target"], score: 999 });
    else if (j.source === "LinkedIn-Post") {
        let score = 800; 
        if (j.hits && j.hits.length > 0) score = 1200;
        candidates.push({ ...j, score: score });
    }
    else {
        const hay = `${j.title} ${j.company} ${j.location}`;
        const hits = matchBank(hay, bank);
        if (hits.length) candidates.push({ ...j, hits, score: hits.length });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const toSend = candidates.slice(0, MAX_SEND);
  let sentCount = 0;

  for (const j of toSend) {
    let detailText = j.fullText || ""; 
    if (!detailText && j.source !== "LinkedIn-Post") {
        try {
            await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 15000 });
            const sel = j.source === "GSK" ? ".job-description" : "main";
            detailText = await page.evaluate((s) => document.querySelector(s)?.innerText || "", sel);
        } catch {}
    }

    const snippet = pickSnippet(detailText, 600);
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

  // --- 2. SUMMARY REPORT ---
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const summaryMsg = 
        `🏁 <b>Mission Report</b>\n\n` +
        `🔎 <b>Sources Scanned:</b>\n` +
        `• Emploitic (${PAGES} pages)\n` +
        `• GSK Careers\n` +
        `• LinkedIn Targets (${companyLinks.length} companies)\n\n` +
        `📊 <b>Stats:</b>\n` +
        `• Total Found: ${allJobs.length}\n` +
        `• Relevant Matches: ${candidates.length}\n` +
        `• <b>New Sent: ${sentCount}</b>\n\n` +
        (sentCount === 0 ? `<i>😴 No new relevant opportunities found this run.</i>` : `<i>🔥 Action required on sent items.</i>`);

      await sendTelegramMessage({
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
          textHtml: summaryMsg
      });
  }

  return { ok: true, scanned: allJobs.length, matched: candidates.length, sent: sentCount };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runOnce({ reason: 'manual_cli' });