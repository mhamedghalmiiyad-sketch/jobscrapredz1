import fs from "fs/promises";
import puppeteer from "puppeteer";

const DEFAULT_URL = "https://emploitic.com/offres-d-emploi";

// Keep charset close to what your logs showed (letters + digits + accents)
const CHARSET =
  "abcdefghijklmnopqrstuvwxyz0123456789" +
  "àâäçéèêëîïôöùûüÿœ";

function normalize(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function isHexLike(s) {
  return /^[0-9a-f]{24,64}$/i.test(s);
}
function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function isBase64ish(s) {
  return s.length >= 24 && /^[A-Za-z0-9+/=]+$/.test(s);
}
function hasLetter(s) {
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s);
}
function goodKeyword(raw) {
  const s = normalize(raw);
  if (s.length < 2 || s.length > 80) return false;
  if (isUUID(s) || isHexLike(s) || isBase64ish(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (!hasLetter(s)) return false;

  const alnum = [...s].filter((c) => /[0-9A-Za-zÀ-ÖØ-öø-ÿ]/.test(c)).length;
  if (alnum / s.length < 0.4) return false;

  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs() {
  const a = process.argv.slice(2);
  const has = (k) => a.includes(k);
  const get = (k, d = null) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : d;
  };
  return {
    url: get("--url", DEFAULT_URL),
    out: get("--out", "keywords.json"),
    state: get("--state", "keywords.state.json"),
    fixedLen: Number(get("--fixedLen", "2")),        // deterministic scan (recommended)
    maxPrefixes: Number(get("--maxPrefixes", "2500")),
    saveEvery: Number(get("--saveEvery", "25")),
    delayMin: Number(get("--delayMin", "180")),
    delayMax: Number(get("--delayMax", "420")),
    headful: has("--headful"),
    resume: has("--resume"),
    startAfter: get("--startAfter", null),           // e.g. "s5"
    chrome: get("--chrome", null),                   // optional chrome path
  };
}

function buildPrefixesFixedLen(len) {
  // deterministic order: first char loops outer, second inner, etc.
  let prefixes = [""];
  for (let d = 0; d < len; d++) {
    const next = [];
    for (const p of prefixes) {
      for (const ch of CHARSET) next.push(p + ch);
    }
    prefixes = next;
  }
  return prefixes;
}

async function ensureLoaded(page, url) {
  for (let i = 0; i < 8; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector('input[data-testid="search"]', { timeout: 60000 });
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      console.log(`  ⚠️ load failed (${i + 1}/8): ${msg.slice(0, 120)}`);
      await sleep(1000 + i * 1500);
    }
  }
  throw new Error("Failed to load page after multiple retries.");
}

async function clearAndType(page, selector, text) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, text, { delay: 10 });
}

async function openDropdown(page) {
  // open popup in the same autocomplete root (keyword field)
  await page.evaluate(() => {
    const input = document.querySelector('input[data-testid="search"]');
    const root = input?.closest(".MuiAutocomplete-root");
    const btn = root?.querySelector('button[aria-label="Open"]');
    btn?.click();
  });
}

async function readOptions(page) {
  // MUI listbox options
  return await page.$$eval('ul[role="listbox"] li[role="option"]', (els) =>
    els.map((e) => (e.textContent || "").trim()).filter(Boolean)
  ).catch(() => []);
}

async function getSuggestions(page, prefix) {
  const inputSel = 'input[data-testid="search"]';

  for (let tries = 0; tries < 6; tries++) {
    try {
      await clearAndType(page, inputSel, prefix);

      // sometimes MUI doesn’t open automatically
      await openDropdown(page);
      await page.keyboard.press("ArrowDown").catch(() => {});

      // wait a bit for XHR + render
      await sleep(250);

      const opts = await readOptions(page);
      return opts;
    } catch (e) {
      const msg = String(e?.message || e);

      // classic when internet drops / navigation happens:
      if (msg.includes("detached Frame") || msg.includes("Execution context was destroyed") || msg.includes("Target closed")) {
        console.log(`  ⚠️ ${msg.split("\n")[0]} -> reloading...`);
        await ensureLoaded(page, DEFAULT_URL);
        continue; // retry same prefix
      }

      console.log(`  ⚠️ prefix="${prefix}" try ${tries + 1}/6 failed: ${msg.slice(0, 140)}`);
      await sleep(500 + tries * 700);
    }
  }

  return [];
}

async function loadState(path) {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveState(path, obj) {
  await fs.writeFile(path, JSON.stringify(obj, null, 2), "utf-8");
}

const args = parseArgs();

const prefixes = buildPrefixesFixedLen(args.fixedLen); // deterministic + resumable by index/prefix
let startIndex = 0;

const prevState = args.resume ? await loadState(args.state) : null;
if (prevState?.progress?.index != null) {
  startIndex = prevState.progress.index;
}
if (args.startAfter) {
  const idx = prefixes.indexOf(args.startAfter);
  if (idx >= 0) startIndex = Math.max(startIndex, idx + 1);
}

const existingOut = await loadState(args.out);
const existingData = Array.isArray(existingOut?.data) ? existingOut.data : [];
const keywords = new Map(); // key=lower, value=original
for (const k of existingData) {
  const s = normalize(k);
  if (goodKeyword(s)) keywords.set(s.toLowerCase(), s);
}

const browser = await puppeteer.launch({
  headless: args.headful ? false : "new",
  executablePath: args.chrome || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const page = await browser.newPage();

// speed: block heavy assets
await page.setRequestInterception(true);
page.on("request", (req) => {
  const t = req.resourceType();
  if (t === "image" || t === "font" || t === "media") return req.abort();
  req.continue();
});

await ensureLoaded(page, args.url);

let processed = 0;
let addedTotal = 0;

for (let i = startIndex; i < prefixes.length && processed < args.maxPrefixes; i++) {
  const prefix = prefixes[i];

  // small random delay to reduce blocking
  const jitter = args.delayMin + Math.floor(Math.random() * (args.delayMax - args.delayMin + 1));
  await sleep(jitter);

  const opts = await getSuggestions(page, prefix);

  let added = 0;
  for (const o of opts) {
    const s = normalize(o);
    if (!goodKeyword(s)) continue;
    const key = s.toLowerCase();
    if (!keywords.has(key)) {
      keywords.set(key, s);
      added++;
    }
  }

  processed++;
  addedTotal += added;

  if (processed % 25 === 0 || added > 0) {
    console.log(`[${processed}/${args.maxPrefixes}] prefix="${prefix}" options=${opts.length} added=${added} total=${keywords.size}`);
  }

  if (processed % args.saveEvery === 0) {
    const outObj = {
      scrapedAt: new Date().toISOString(),
      count: keywords.size,
      data: [...keywords.values()].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })),
      progress: { index: i + 1, lastPrefix: prefix },
      mode: { fixedLen: args.fixedLen, charset: CHARSET },
    };
    await saveState(args.out, outObj);
    await saveState(args.state, outObj);
  }
}

// final save
const outObj = {
  scrapedAt: new Date().toISOString(),
  count: keywords.size,
  data: [...keywords.values()].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })),
  progress: { index: Math.min(startIndex + processed, prefixes.length), lastPrefix: prefixes[Math.min(startIndex + processed - 1, prefixes.length - 1)] },
  mode: { fixedLen: args.fixedLen, charset: CHARSET },
};
await saveState(args.out, outObj);
await saveState(args.state, outObj);

await browser.close();
console.log(`✅ Done. processed=${processed} added=${addedTotal} total_keywords=${keywords.size}`);
console.log(`✅ Saved to ${args.out} (and state to ${args.state})`);
