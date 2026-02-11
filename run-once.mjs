import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { fileURLToPath } from 'url';

// Activate Stealth Mode
puppeteer.use(StealthPlugin());

// --- 1. AUTO-LOAD .ENV FILE ---
function loadEnv() {
    try {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            content.split('\n').forEach(line => {
                const cleanLine = line.trim();
                if (!cleanLine || cleanLine.startsWith('#')) return;
                const [key, ...parts] = cleanLine.split('=');
                if (key) {
                    const val = parts.join('=').trim().replace(/^["']|["']$/g, '');
                    if (!process.env[key.trim()]) process.env[key.trim()] = val;
                }
            });
            console.log("[Config] .env loaded.");
        }
    } catch (e) { console.error(`[Config] Env load error: ${e.message}`); }
}
loadEnv(); 

function argEnv(name, fallback) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function toAbs(p) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}

function escapeHtml(s) {
  return String(s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
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
  if (!token) { console.error("[Telegram] Token missing!"); return; }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true };
  
  try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const r = await fetch(url, { 
          method: "POST", 
          headers: { "content-type": "application/json" }, 
          body: JSON.stringify(body),
          signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!r.ok) console.error(`[Telegram] API Error: ${await r.text()}`);
  } catch (e) { console.error(`[Telegram] Failed: ${e.message}`); }
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

// --- MODULE: HENKEL (STRICT ALGERIA DEFAULT) ---
async function scrapeHenkel(page, targetCountry = "algeria") {
    const jobs = [];
    const countryMap = { 'algeria': 'Algeria', 'israel': 'Israel', 'france': 'France' };
    const cVal = countryMap[targetCountry.toLowerCase()] || 'Algeria';
    const url = `https://www.henkel.com/careers/jobs-and-application?f_Country=${encodeURIComponent(cVal)}`;
    
    console.log(`[Henkel] Targeting: ${url} (Filter: ${cVal})`);

    // KEYWORDS FOR POST-FILTERING
    const locationKeywords = targetCountry.toLowerCase() === 'israel' 
        ? ['israel', 'netanya', 'tel aviv', 'haifa'] 
        : ['algeria', 'algerie', 'algérie', 'algers', 'dza', 'bouira', 'oran', 'constantine'];

    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
        
        try {
            const consentBtn = await page.waitForSelector('#accept-recommended-btn-handler, #onetrust-accept-btn-handler', { timeout: 8000 });
            if (consentBtn) {
                await consentBtn.click();
                await sleep(1500); 
            }
        } catch {}

        try {
            await page.waitForSelector('.bab-filters__results-list-result', { timeout: 20000 });
        } catch {
            console.warn(`[Henkel] No jobs visible initially.`);
            return [];
        }

        // LOAD MORE LOOP
        let clicks = 0;
        while (clicks < 5) { // Limit to 5 pages of loading to save time
            try {
                const btnVisible = await page.evaluate(() => {
                    const btn = document.querySelector('.bab-filters__results-loadMore');
                    return btn && btn.style.display !== 'none' && btn.offsetParent !== null;
                });
                if (!btnVisible) break;
                await page.click('.bab-filters__results-loadMore');
                await sleep(2500); 
                clicks++;
            } catch { break; }
        }

        const extracted = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.bab-filters__results-list-result')).map(node => {
                const title = node.querySelector('.link-title')?.innerText?.trim() || "Henkel Job";
                const loc = node.querySelector('.place')?.innerText?.trim() || "";
                const linkNode = node.querySelector('a');
                let link = linkNode ? linkNode.getAttribute('href') : null;
                if (link && !link.startsWith('http')) link = 'https://www.henkel.com' + link;
                return { title, location: loc, url: link };
            });
        });

        const relevantJobs = extracted.filter(j => {
            const loc = j.location.toLowerCase();
            return locationKeywords.some(k => loc.includes(k));
        }).map(j => ({
            title: j.title,
            company: "Henkel",
            location: j.location,
            url: j.url,
            posted: "Recent",
            source: `Henkel-${cVal}`
        }));

        console.log(`[Henkel] Extracted ${relevantJobs.length} verified jobs.`);
        jobs.push(...relevantJobs);

    } catch (e) { console.warn(`[Henkel] Error: ${e.message}`); }
    return jobs;
}

// --- MODULE: OUEDKNISS (NEW) ---
async function scrapeOuedkniss(page, maxPages = 10) {
    const jobs = [];
    console.log(`[Ouedkniss] Starting scan (Pages 1-${maxPages})...`);

    for (let i = 1; i <= maxPages; i++) {
        const url = `https://www.ouedkniss.com/offres_demandes_emploi/${i}`;
        // console.log(`[Ouedkniss] Scanning page ${i}...`);
        
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            
            // Wait for Vue app to hydrate card list
            try {
                await page.waitForSelector('.o-announ-card', { timeout: 10000 });
            } catch {
                // If timeout, maybe no results or network lag, skip page
                continue;
            }

            const pageJobs = await page.evaluate(() => {
                const nodes = Array.from(document.querySelectorAll('.o-announ-card'));
                return nodes.map(node => {
                    const titleEl = node.querySelector('.o-announ-card-title');
                    const cityEl = node.querySelector('.o-announ-card-city');
                    const timeEl = node.querySelector('.o-announ-card-date');
                    const linkEl = node.closest('a') || node.querySelector('a');
                    const companyEl = node.closest('.o-announ-card-column')?.nextElementSibling?.querySelector('.text-capitalize');

                    const title = titleEl ? titleEl.innerText.trim() : "";
                    const location = cityEl ? cityEl.innerText.trim() : "Algérie";
                    const posted = timeEl ? timeEl.innerText.trim() : "Recent";
                    const company = companyEl ? companyEl.innerText.trim() : "Ouedkniss Annonce";

                    let link = linkEl ? linkEl.getAttribute('href') : null;
                    if (link && !link.startsWith('http')) link = 'https://www.ouedkniss.com' + link;

                    return {
                        title: title,
                        company: company, 
                        location: location,
                        url: link,
                        posted: posted,
                        source: "Ouedkniss"
                    };
                });
            });

            // Basic cleanup of empty entries
            const validJobs = pageJobs.filter(j => j.title && j.url);
            jobs.push(...validJobs);
            await sleep(1000); // Polite delay

        } catch (e) {
            console.warn(`[Ouedkniss] Error page ${i}: ${e.message}`);
        }
    }
    
    console.log(`[Ouedkniss] Total raw jobs found: ${jobs.length}`);
    return jobs;
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
        jobs.push(...items);
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
  // ARGS
  const args = process.argv.slice(2);
  const flagHenkelOnly = args.includes('-henkel');
  const flagOuedknissOnly = args.includes('-ouedkniss');
  const flagReset = args.includes('-reset');
  
  // COUNTRY LOGIC
  let targetCountry = 'algeria'; // Default to Algeria for Production
  if (args.includes('-israel')) targetCountry = 'israel'; // Override if specified
  
  const EMPLOITIC_URL = argEnv("SCRAPE_URL", "https://emploitic.com/offres-d-emploi");
  const PAGES = Number(argEnv("SCRAPE_PAGES", "5"));
  const MAX_SEND = Number(argEnv("MAX_SEND", "20")); // Increased slightly
  const KEYWORDS_FILE = argEnv("KEYWORDS_FILE", "keywords.cleaned.json");
  const TELEGRAM_BOT_TOKEN = argEnv("TELEGRAM_BOT_TOKEN", "");
  const TELEGRAM_CHAT_ID = argEnv("TELEGRAM_CHAT_ID", "");
  const STATE_DIR = argEnv("STATE_DIR", process.cwd());
  const SENT_FILE = path.join(STATE_DIR, "sent-urls.json");

  // SEND START MESSAGE
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      let modeText = "Full Scan (Algeria)";
      if (flagHenkelOnly) modeText = `Henkel Only (${targetCountry.toUpperCase()})`;
      if (flagOuedknissOnly) modeText = `Ouedkniss Only`;
      
      await sendTelegramMessage({
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
          textHtml: `🚀 <b>WORM-AI Started</b>\nMode: ${modeText}\nReset: ${flagReset}`
      });
  }

  // KEYWORDS
  const seeds = String(argEnv("KEYWORD_SEEDS", "automation,automatisme,maintenance,electricite,électricité,électrique,instrumentation,plc,automate,scada,hmi,ingénieur,technicien")).split(",").map(s => s.trim()).filter(Boolean);
  const allKeywords = parseKeywordsFile(toAbs(KEYWORDS_FILE));
  const bank = makeKeywordBank(allKeywords, seeds);

  // MEMORY
  let sent = {};
  if (!flagReset) {
      const sentState = readJsonSafe(SENT_FILE, { sent: {} });
      sent = sentState.sent || {};
  } else {
      console.log("[Config] Memory Reset Active.");
  }

  // BROWSER
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  
  // Resource Blocking
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    // Allow scripts for Ouedkniss (Vue.js needs them)
    if (["image", "font", "media"].includes(type)) req.abort();
    else req.continue();
  });

  const allJobs = [];
  const seen = new Set();

  // --- EXECUTION LOGIC ---
  if (flagHenkelOnly) {
      // 1. HENKEL ONLY MODE
      const hJobs = await scrapeHenkel(page, targetCountry);
      hJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});
  
  } else if (flagOuedknissOnly) {
      // 2. OUEDKNISS ONLY MODE
      const oJobs = await scrapeOuedkniss(page, 10); // 10 Pages
      oJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});

  } else {
      // 3. FULL MODE (DEFAULT ALGERIA)
      console.log(`[Mode] Running Full Scan for ALGERIA...`);
      
      // A. Emploitic
      for (let p = 1; p <= PAGES; p++) {
          try {
              const items = await scrapeEmploitic(page, EMPLOITIC_URL, p);
              items.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});
          } catch {}
          await sleep(1000);
      }
      
      // B. GSK
      const gskJobs = await scrapeGSK(page);
      gskJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});
      
      // C. Henkel (Forced Algeria in standard mode)
      const henkelJobs = await scrapeHenkel(page, "algeria");
      henkelJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});

      // D. Ouedkniss
      const oJobs = await scrapeOuedkniss(page, 10);
      oJobs.forEach(j => { if(!seen.has(j.url)) { seen.add(j.url); allJobs.push(j); }});
  }

  console.log(`[WORM-AI] Total Intelligence Gathered: ${allJobs.length}`);
  
  // --- FILTERING & MATCHING ---
  const candidates = [];
  for (const j of allJobs) {
    if (sent[j.url]) continue;

    // DIRECT TARGETS (Skip keyword check for specific company portals)
    if (j.source && (j.source.startsWith("Henkel") || j.source === "GSK")) {
        candidates.push({ ...j, score: 999 });
    } 
    // GENERAL SOURCES (Emploitic, Ouedkniss, LinkedIn) -> REQUIRE KEYWORD MATCH
    else {
        const hay = `${j.title} ${j.company} ${j.location}`;
        const hits = matchBank(hay, bank);
        
        if (hits.length > 0) {
            candidates.push({ ...j, score: hits.length });
        }
    }
  }

  // Sort by score (Company targets first, then keyword density)
  candidates.sort((a, b) => b.score - a.score);
  const toSend = candidates.slice(0, MAX_SEND);
  let sentCount = 0;

  for (const j of toSend) {
    const msg =
      `<b>${escapeHtml(j.title || "Nouvelle Offre")}</b>\n` +
      `🏢 <b>${escapeHtml(j.company || "Anonyme")}</b>\n` +
      `📍 ${escapeHtml(j.location || "")}\n` +
      `🕒 ${escapeHtml(j.posted || "")}\n\n` +
      `<a href="${escapeHtml(j.url)}">👉 CLIQUEZ ICI POUR POSTULER</a>`;

    await sendTelegramMessage({ token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID, textHtml: msg });
    sent[j.url] = { at: new Date().toISOString(), title: j.title || "" };
    sentCount++;
    await sleep(2000);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify({ sent }, null, 2), "utf-8");

  await browser.close();

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const summaryMsg = 
        `🏁 <b>Report</b>\n` +
        `🔎 Sources: ${allJobs.length}\n` +
        `✅ Matches: ${candidates.length}\n` +
        `📩 Sent: ${sentCount}`;

      await sendTelegramMessage({
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
          textHtml: summaryMsg
      });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runOnce({ reason: 'manual_cli' });