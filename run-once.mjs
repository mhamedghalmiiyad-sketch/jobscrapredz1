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

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum > 1) u.searchParams.set("page", String(pageNum));
  else u.searchParams.delete("page");
  return u.toString();
}

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
  // supports: ["k1","k2"] OR { data: [...] } OR { keywords: [...] }
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

  // Also include some “must have” terms even if missing
  [
    "automate",
    "plc",
    "scada",
    "hmi",
    "gmao",
    "instrumentation",
    "electrotechnique",
    "maintenance industrielle",
    "electricite",
    "électricité",
    "automatisme",
    "automation",
    "technicien",
    "ingenieur",
    "ingénieur",
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
    if (hits.length >= 10) break; // keep messages small
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

export async function runOnce({ reason = "manual", bankOnly = false } = {}) {
  const BASE_URL = argEnv("SCRAPE_URL", "https://emploitic.com/offres-d-emploi");
  const PAGES = Number(argEnv("SCRAPE_PAGES", "5"));
  const MAX_SEND = Number(argEnv("MAX_SEND", "10"));

  const KEYWORDS_FILE = argEnv("KEYWORDS_FILE", "keywords.cleaned.json");
  const STATE_DIR = argEnv("STATE_DIR", process.cwd());
  const SENT_FILE = path.join(STATE_DIR, "sent-urls.json");

  const TELEGRAM_BOT_TOKEN = argEnv("TELEGRAM_BOT_TOKEN", "");
  const TELEGRAM_CHAT_ID = argEnv("TELEGRAM_CHAT_ID", ""); // e.g. @jobscrapredz

  // Seeds: your field (automation/maintenance/electricity)
  const seeds = String(
    argEnv(
      "KEYWORD_SEEDS",
      "automation,automatisme,maintenance,electricite,électricité,électrique,instrumentation,plc,automate,scada,hmi,ingénieur,technicien,maintenance industrielle,électromécanique"
    )
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allKeywords = parseKeywordsFile(toAbs(KEYWORDS_FILE));
  const bank = makeKeywordBank(allKeywords, seeds);

  if (bankOnly) {
    return {
      ok: true,
      reason,
      keywordsFile: KEYWORDS_FILE,
      totalKeywordsLoaded: allKeywords.length,
      seedCount: seeds.length,
      bankSize: bank.length,
      seeds,
      sampleBank: bank.slice(0, 120),
    };
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return {
      ok: false,
      error:
        "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables",
    };
  }

  // Load sent URLs state (avoid duplicates)
  const sentState = readJsonSafe(SENT_FILE, { sent: {} });
  const sent = sentState.sent || {};

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Speed: block images/fonts/media
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "font" || t === "media") req.abort();
    else req.continue();
  });

  const jobs = [];
  const seen = new Set();

  // List scraping
  for (let p = 1; p <= PAGES; p++) {
    const url = buildPageUrl(BASE_URL, p);
    console.log(`[List] Page ${p}: ${url}`);

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector('li[data-testid="jobs-item"]', {
      timeout: 30000,
    });

    const items = await page.evaluate(() => {
      function pickTextNearIcon(item, iconTestId) {
        const svg = item.querySelector(`svg[data-testid="${iconTestId}"]`);
        if (!svg) return null;
        const container = svg.closest("div");
        if (!container) return null;
        const txt = container.innerText.replace(/\s+/g, " ").trim();
        return txt || null;
      }

      const nodes = Array.from(
        document.querySelectorAll('li[data-testid="jobs-item"]')
      );

      return nodes
        .map((li) => {
          const a = li.querySelector("a[href]");
          const title = li.querySelector("h2")?.innerText?.trim() || null;
          const company =
            li
              .querySelector('[data-testid="jobs-item-company"]')
              ?.innerText?.trim() || null;

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
        })
        .filter((x) => x.url);
    });

    for (const j of items) {
      if (!j.url) continue;
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      jobs.push(j);
    }

    await sleep(500);
  }

  console.log(`[List] scraped jobs=${jobs.length}`);

  // Filter matches + not previously sent
  const candidates = [];
  for (const j of jobs) {
    if (!j.url) continue;
    if (sent[j.url]) continue;

    const hay = `${j.title || ""} ${j.company || ""} ${j.location || ""} ${
      j.experience || ""
    }`;
    const hits = matchBank(hay, bank);
    if (hits.length) {
      candidates.push({ ...j, hits, score: hits.length });
    }
  }

  // Prefer stronger matches
  candidates.sort((a, b) => b.score - a.score);

  // Send max N
  const toSend = candidates.slice(0, MAX_SEND);
  let sentCount = 0;

  for (const j of toSend) {
    // Open job detail and extract a snippet
    let detailText = "";
    try {
      await page.goto(j.url, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForSelector("main", { timeout: 15000 }).catch(() => {});
      detailText = await page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        let t = main?.innerText || "";
        t = t.replace(/\r/g, "")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        // keep it bounded
        if (t.length > 8000) t = t.slice(0, 8000);
        return t;
      });
    } catch (e) {
      // If details fail, still send basic info
      detailText = "";
    }

    const snippet = pickSnippet(detailText, 420);
    const matched = (j.hits || []).slice(0, 6).join(", ");

    const msg =
      `<b>${escapeHtml(j.title || "Offre d'emploi")}</b>\n` +
      `${escapeHtml(j.company || "")}\n` +
      `${escapeHtml(j.location || "")}\n` +
      `${escapeHtml(j.posted || "")}${j.experience ? " • " + escapeHtml(j.experience) : ""}\n\n` +
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

  // Save state
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify({ sent }, null, 2), "utf-8");

  await browser.close();

  return {
    ok: true,
    reason,
    scanned: jobs.length,
    matched: candidates.length,
    sent: sentCount,
    bankSize: bank.length,
    seedsCount: seeds.length,
  };
}
