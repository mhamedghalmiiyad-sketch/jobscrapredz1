import fs from "fs";
import puppeteer from "puppeteer";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return "true";
  return v;
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(baseUrl);
  if (pageNum > 1) u.searchParams.set("page", String(pageNum));
  else u.searchParams.delete("page");
  return u.toString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const BASE_URL = arg("url", "https://emploitic.com/offres-d-emploi");
const PAGES = Number(arg("pages", "3"));
const OUT = arg("out", "jobs.json");
const DELAY_MS = Number(arg("delay", "800"));

const browser = await puppeteer.launch({
  headless: true,
  // Windows usually doesn't need --no-sandbox
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

// Speed up: block images/fonts
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
  console.log(`\n[Page ${p}] ${url}`);

  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  // Wait for job items to appear
  try {
    await page.waitForSelector('li[data-testid="jobs-item"]', { timeout: 30000 });
  } catch {
    console.log("  ⚠️ jobs list not found on this page (maybe blocked or empty).");
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

  let added = 0;
  for (const j of items) {
    if (!j.url) continue;
    if (seen.has(j.url)) continue;
    seen.add(j.url);
    all.push({ ...j, page: p });
    added++;
  }

  console.log(`  ✅ extracted: ${items.length}, added new: ${added}`);
  await sleep(DELAY_MS);
}

await browser.close();

fs.writeFileSync(
  OUT,
  JSON.stringify({ scrapedAt: new Date().toISOString(), baseUrl: BASE_URL, count: all.length, data: all }, null, 2),
  "utf-8"
);

console.log(`\n✅ Saved ${all.length} jobs to ${OUT}`);
