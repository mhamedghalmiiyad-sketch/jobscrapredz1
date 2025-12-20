import fs from "fs";
import puppeteer from "puppeteer";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return "true";
  return v;
}

function findBrowserExe() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractStringsDeep(x, out = new Set()) {
  if (x == null) return out;
  if (typeof x === "string") {
    const s = x.trim();
    if (
      s.length >= 2 &&
      s.length <= 80 &&
      !s.includes("http") &&
      !s.includes("<") &&
      !s.includes("{") &&
      !s.includes("}") &&
      /[A-Za-zÀ-ÿ0-9]/.test(s)
    ) {
      out.add(s);
    }
    return out;
  }
  if (Array.isArray(x)) {
    for (const v of x) extractStringsDeep(v, out);
    return out;
  }
  if (typeof x === "object") {
    for (const v of Object.values(x)) extractStringsDeep(v, out);
    return out;
  }
  return out;
}

const BASE_URL = arg("url", "https://emploitic.com/offres-d-emploi");
const OUT = arg("out", "keywords.json");

const MAX_DEPTH = Number(arg("maxDepth", "5"));       // max prefix length
const MIN_LEN = Number(arg("minLen", "2"));           // FORCE expand until this length
const MAX_PREFIXES = Number(arg("maxPrefixes", "3000"));
const DELAY_MS = Number(arg("delay", "300"));
const HEADFUL = arg("headful", "false") === "true";

const STARTS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  "é","è","ê","à","â","î","ï","ô","û","ù","ç",
];

function saveProgress(set, meta = {}) {
  const arr = [...set].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { scrapedAt: new Date().toISOString(), count: arr.length, ...meta, data: arr },
      null,
      2
    ),
    "utf-8"
  );
}

const exe = process.env.CHROME_PATH || findBrowserExe();

const browser = await puppeteer.launch({
  headless: !HEADFUL,
  ...(exe ? { executablePath: exe } : {}),
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

// speed up (optional): block images/fonts
await page.setRequestInterception(true);
page.on("request", (req) => {
  const t = req.resourceType();
  if (t === "image" || t === "font" || t === "media") req.abort();
  else req.continue();
});

console.log(`[Init] Opening: ${BASE_URL}`);
await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 });

const inputSel = 'input[data-testid="search"]';
await page.waitForSelector(inputSel, { timeout: 30000 });

async function clearAndType(text) {
  await page.click(inputSel, { clickCount: 3 });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  if (text) await page.type(inputSel, text, { delay: 15 });
}

// clicks the ▼ of the keywords autocomplete (not the location one)
async function openDropdown() {
  await page.evaluate(() => {
    const input = document.querySelector('input[data-testid="search"]');
    if (!input) return;
    const root = input.closest(".MuiAutocomplete-root");
    const btn = root?.querySelector('button[aria-label="Open"],button[title="Open"]');
    btn?.click();
  });
}

async function readDropdownOptions() {
  try {
    await page.waitForSelector('ul[role="listbox"] li[role="option"]', { timeout: 2500 });
  } catch {
    return [];
  }
  const opts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('ul[role="listbox"] li[role="option"]'))
      .map((li) => (li.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  });
  await page.keyboard.press("Escape").catch(() => {});
  return opts;
}

const keywords = new Set();
const visited = new Set();

// BFS queue
const queue = STARTS.map((ch) => ({ prefix: ch, depth: 1 }));

let processed = 0;

while (queue.length && processed < MAX_PREFIXES) {
  const { prefix, depth } = queue.shift();
  if (visited.has(prefix)) continue;
  visited.add(prefix);

  processed++;

  // Capture possible autocomplete JSON responses while we type
  const captured = new Set();
  const respHandler = async (res) => {
    try {
      const req = res.request();
      const rt = req.resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;

      const url = res.url();
      if (!url.includes("/api/") && !url.includes("api/v4")) return;
      if (!/suggest|autocomplete|search|keyword|metier|fonction|competence|skill/i.test(url)) return;

      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) return;

      const json = await res.json().catch(() => null);
      if (!json) return;

      const strings = extractStringsDeep(json);
      for (const s of strings) captured.add(s);
    } catch {}
  };
  page.on("response", respHandler);

  await clearAndType(prefix);
  await sleep(DELAY_MS);

  // try opening dropdown + reading options
  await openDropdown();
  await sleep(150);

  // also try arrow-down to trigger suggestions
  await page.keyboard.press("ArrowDown").catch(() => {});
  await sleep(150);

  const options = await readDropdownOptions();

  page.off("response", respHandler);

  for (const s of captured) keywords.add(s);
  for (const opt of options) keywords.add(opt);

  // progress + autosave
  if (processed % 25 === 0) {
    console.log(`[Progress] prefixes=${processed} keywords=${keywords.size} queue=${queue.length} last="${prefix}" options=${options.length} captured=${captured.size}`);
    saveProgress(keywords, { processedPrefixes: processed, queue: queue.length });
  }

  // ✅ IMPORTANT: Expand even if options are empty, until minLen
  if (depth < MIN_LEN && depth < MAX_DEPTH) {
    for (const ch of STARTS) queue.push({ prefix: prefix + ch, depth: depth + 1 });
    continue;
  }

  // If autocomplete returns many options (or network captured lots), go deeper (more coverage)
  const shouldExpand = (options.length >= 10 || captured.size >= 30) && depth < MAX_DEPTH;
  if (shouldExpand) {
    for (const ch of STARTS) queue.push({ prefix: prefix + ch, depth: depth + 1 });
  }
}

saveProgress(keywords, { processedPrefixes: processed, queue: queue.length });
await browser.close();

console.log(`✅ Done. Found ${keywords.size} strings. Saved to ${OUT}`);
