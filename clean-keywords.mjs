import fs from "fs/promises";

function normalize(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isHexLike(s) {
  // 24..64 hex chars (sha1=40, sha256=64, etc.)
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

  // Avoid junk strings full of punctuation
  const alnum = [...s].filter((c) => /[0-9A-Za-zÀ-ÖØ-öø-ÿ]/.test(c)).length;
  if (alnum / s.length < 0.4) return false;

  return true;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d = null) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : d;
  };
  return {
    inFile: get("--in", "keywords.json"),
    outFile: get("--out", "keywords.cleaned.json"),
  };
}

const { inFile, outFile } = parseArgs();

const raw = await fs.readFile(inFile, "utf-8");
let obj;
try {
  obj = JSON.parse(raw);
} catch {
  throw new Error("Input is not valid JSON.");
}

const arr = Array.isArray(obj) ? obj : Array.isArray(obj.data) ? obj.data : null;
if (!arr) throw new Error("Expected a JSON array OR an object with a .data array.");

const cleaned = [];
const seen = new Set();
for (const x of arr) {
  if (!goodKeyword(x)) continue;
  const s = normalize(x);
  const key = s.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  cleaned.push(s);
}

cleaned.sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));

const out = Array.isArray(obj)
  ? cleaned
  : {
      ...obj,
      originalCount: arr.length,
      cleanedCount: cleaned.length,
      removed: arr.length - cleaned.length,
      data: cleaned,
    };

await fs.writeFile(outFile, JSON.stringify(out, null, 2), "utf-8");
console.log(`✅ Cleaned: ${arr.length} -> ${cleaned.length}`);
console.log(`✅ Saved to: ${outFile}`);
