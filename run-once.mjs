import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";

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

// Normalize for matching (lower + remove accents)
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Emploitic Helpers ---
function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum > 1) u.searchParams.set("page", String(pageNum));
  else u.searchParams.delete("page");
  return u.toString();
}

// --- Common Helpers ---
function pickSnippet(fullText, maxLen = 420) {
  let t = String(fullText || "").replace(/\s+/g, " ").trim();

  // Try to cut after useful markers
  const markers = [
    "responsabilit",
    "mission",
    "profil",
    "competence",
    "compétence",
    "description",
    "qualifications", // Added for GSK
    "requirements",   // Added for GSK
  ].map(norm);

  const nt = norm(t);
  let best = -1;
  for (const m of markers) {
    const i = nt.indexOf(m);
    if (i !== -1) best = best === -1 ? i : Math.min(best, i);
  }
  if (best > 0) t = t.slice(best);

  if (t.length > maxLen) t = t.slice(0, maxLen - 1) + "…";
  return t;
}

function parseKeywordsFile(filePath) {
  const data = readJsonSafe(filePath, null);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.keywords)) return data.keywords;
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

  // Must have terms
  [
    "automate", "plc", "scada", "hmi", "gmao", "instrumentation",
    "electrotechnique", "maintenance industrielle", "electricite",
    "électricité", "automatisme", "automation", "technicien",
    "ingenieur", "ingénieur",
  ].forEach((x) => bank.add(x));

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
  const body = {
    chat_id: chatId,
    text: textHtml,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(`Telegram send failed: ${JSON.stringify(j).slice(0, 300)}`);
  }
}

// --- GSK Scraper Function ---
async function scrapeGSK(page) {
  console.log("[GSK] Starting scrape...");
  // Search specifically for Algeria
  const GSK_URL = "https://jobs.gsk.com/en-gb/jobs?keywords=Algeria&page=1"; 
  
  const jobs = [];
  try {
    await page.goto(GSK_URL, { waitUntil: "networkidle2", timeout: 60000 });
    
    // Accept cookies using the specific ID from your file
    try {
        const acceptBtn = await page.waitForSelector('#pixel-consent-accept-button', { timeout: 5000 });
        if (acceptBtn) await acceptBtn.click();
        await sleep(1000);
    } catch (e) { /* ignore if no cookie banner */ }

    // Wait for job list
    await page.waitForSelector('.job-results-list', { timeout: 20000 }).catch(() => console.log("[GSK] No job list found (maybe 0 results)"));

    const items = await page.evaluate(() => {
      // Find all job links
      const links = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));
      
      return links.map(a => {
        const container = a.closest('li') || a.closest('div'); 
        if (!container) return null;

        const title = a.innerText.trim();
        // Extract location (simplistic match)
        const location = container.innerText.match(/Location\s*\n\s*(.*)/i)?.[1] || "Algeria"; 
        const url = a.href;
        
        // Ensure it is actually an Algeria job
        if (!location.toLowerCase().includes('algeria') && !container.innerText.toLowerCase().includes('algeria')) {
            return null;
        }

        return {
          title: title,
          company: "GSK",
          location: location.trim(),
          url: url,
          posted: "Recent",
          source: "GSK"
        };
      }).filter(x => x && x.title);
    });

    if (items && items.length > 0) {
      console.log(`[GSK] Found ${items.length} potential jobs.`);
      jobs.push(...items);
    } else {
      console.log("[GSK] No jobs found.");
    }

  } catch (e) {
    console.error("[GSK] Error scraping:", e.message);
  }
  return jobs;
}

export async function runOnce({ reason = "manual", bankOnly = false } = {}) {
  const EMPLOITIC_URL = argEnv("SCRAPE_URL", "https://emploitic.com/offres-d-emploi");
  const PAGES = Number(argEnv("SCRAPE_PAGES", "5"));
  const MAX_SEND = Number(argEnv("MAX_SEND", "10"));
  const KEYWORDS_FILE = argEnv("KEYWORDS_FILE", "keywords.cleaned.json");
  const STATE_DIR = argEnv("STATE_DIR", process.cwd());
  const SENT_FILE = path.join(STATE_DIR, "sent-urls.json");
  const TELEGRAM_BOT_TOKEN = argEnv("TELEGRAM_BOT_TOKEN", "");
  const TELEGRAM_CHAT_ID = argEnv("TELEGRAM_CHAT_ID", "");

  const seeds = String(argEnv("KEYWORD_SEEDS", "automation,automatisme,maintenance,electricite,électricité,électrique,instrumentation,plc,automate,scada,hmi,ingénieur,technicien,maintenance industrielle,électromécanique")).split(",").map(s => s.trim()).filter(Boolean);

  const allKeywords = parseKeywordsFile(toAbs(KEYWORDS_FILE));
  const bank = makeKeywordBank(allKeywords, seeds);

  if (bankOnly) {
    return { ok: true, reason, bankSize: bank.length, seeds };
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };
  }

  const sentState = readJsonSafe(SENT_FILE, { sent: {} });
  const sent = sentState.sent || {};

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "font" || t === "media") req.abort();
    else req.continue();
  });

  const allJobs = [];
  const seen = new Set();

  // 1. Scrape Emploitic
  for (let p = 1; p <= PAGES; p++) {
    const url = buildPageUrl(EMPLOITIC_URL, p);
    console.log(`[Emploitic] Page ${p}: ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForSelector('li[data-testid="jobs-item"]', { timeout: 15000 }).catch(()=>null);

      const items = await page.evaluate(() => {
        function pickTextNearIcon(item, iconTestId) {
          const svg = item.querySelector(`svg[data-testid="${iconTestId}"]`);
          if (!svg) return null;
          const container = svg.closest("div");
          if (!container) return null;
          return container.innerText.replace(/\s+/g, " ").trim() || null;
        }

        const nodes = Array.from(document.querySelectorAll('li[data-testid="jobs-item"]'));
        return nodes.map((li) => {
          const a = li.querySelector("a[href]");
          return {
            title: li.querySelector("h2")?.innerText?.trim() || null,
            company: li.querySelector('[data-testid="jobs-item-company"]')?.innerText?.trim() || null,
            location: pickTextNearIcon(li, "RoomRoundedIcon"),
            posted: pickTextNearIcon(li, "AccessTimeRoundedIcon"),
            experience: pickTextNearIcon(li, "StarsRoundedIcon"),
            url: a ? a.href : null,
            source: "Emploitic"
          };
        }).filter((x) => x.url);
      });

      for (const j of items) {
        if (!j.url || seen.has(j.url)) continue;
        seen.add(j.url);
        allJobs.push(j);
      }
    } catch (e) {
      console.warn(`[Emploitic] Error page ${p}:`, e.message);
    }
    await sleep(500);
  }

  // 2. Scrape GSK
  const gskJobs = await scrapeGSK(page);
  for (const j of gskJobs) {
      if (!j.url || seen.has(j.url)) continue;
      seen.add(j.url);
      allJobs.push(j);
  }

  console.log(`[Total] scraped jobs=${allJobs.length}`);

  // Filter & Score
  const candidates = [];
  for (const j of allJobs) {
    if (!j.url || sent[j.url]) continue;

    if (j.source === "GSK") {
         // Auto-add GSK jobs (give them a high score)
         const hay = `${j.title} ${j.company} ${j.location}`;
         const hits = matchBank(hay, bank);
         if (hits.length === 0) hits.push("GSK-Auto"); 
         candidates.push({ ...j, hits, score: 999 }); // High Priority
    } else {
        const hay = `${j.title || ""} ${j.company || ""} ${j.location || ""} ${j.experience || ""}`;
        const hits = matchBank(hay, bank);
        if (hits.length) {
          candidates.push({ ...j, hits, score: hits.length });
        }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // Send
  const toSend = candidates.slice(0, MAX_SEND);
  let sentCount = 0;

  for (const j of toSend) {
    let detailText = "";
    try {
      await page.goto(j.url, { waitUntil: "networkidle2", timeout: 60000 });
      // Use different selector for GSK details
      const contentSelector = j.source === "GSK" ? ".job-description" : "main"; 
      await page.waitForSelector(contentSelector, { timeout: 15000 }).catch(() => {});
      
      detailText = await page.evaluate((sel) => {
        const el = document.querySelector(sel) || document.body;
        return el.innerText.trim().slice(0, 8000);
      }, contentSelector);
    } catch (e) {
      detailText = "";
    }

    const snippet = pickSnippet(detailText, 420);
    const matched = (j.hits || []).slice(0, 6).join(", ");

    const msg =
      `<b>${escapeHtml(j.title || "Offre d'emploi")}</b>\n` +
      `🏢 ${escapeHtml(j.company || "")} (${j.source})\n` +
      `📍 ${escapeHtml(j.location || "")}\n` +
      `🕒 ${escapeHtml(j.posted || "")}${j.experience ? " • " + escapeHtml(j.experience) : ""}\n\n` +
      (matched ? `<b>Mots-clés matchés:</b> ${escapeHtml(matched)}\n\n` : "") +
      (snippet ? `${escapeHtml(snippet)}\n\n` : "") +
      `<a href="${escapeHtml(j.url)}">🔗 Ouvrir l'offre</a>`;

    await sendTelegramMessage({
      token: TELEGRAM_BOT_TOKEN,
      chatId: TELEGRAM_CHAT_ID,
      textHtml: msg,
    });

    sent[j.url] = { at: new Date().toISOString(), title: j.title || "" };
    sentCount++;
    await sleep(800);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify({ sent }, null, 2), "utf-8");

  await browser.close();

  return {
    ok: true,
    reason,
    scanned: allJobs.length,
    matched: candidates.length,
    sent: sentCount,
  };
}