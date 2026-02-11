import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Activate Stealth Mode
puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---
const JSON_FILE = "algeria_all_results_v3.json"; 
const COOKIE_FILE = process.env.LINKEDIN_COOKIE_FILE || "linkedin..txt"; 
const PROGRESS_FILE = "follow_progress.json"; 
const EMAIL = process.env.LINKEDIN_EMAIL;
const PASSWORD = process.env.LINKEDIN_PASSWORD;

// DELAYS
const SEARCH_DELAY = [4000, 8000];
const ACTION_DELAY = [2000, 5000]; 

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1) + min); }

// --- CHECKPOINT SYSTEM ---
function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
            return data.lastIndex || 0;
        }
    } catch (e) {}
    return 0;
}

function saveProgress(index) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastIndex: index }, null, 2));
}

// --- NAME CLEANER ---
function cleanCompanyName(name) {
    if (!name) return "";
    let clean = name;
    clean = clean.replace(/,?\s*(SARL|EURL|SPA|SNC|EPIC|EPA|EPE|S\.A\.R\.L|S\.P\.A|GROUP|GROUPE)\b.*/gi, "");
    clean = clean.replace(/[&/\\#,+()$~%.'":*?<>{}]/g, " ");
    clean = clean.replace(/\s+/g, " ").trim();
    return clean;
}

// --- BROWSER LAUNCHER ---
async function launchBrowser() {
    return await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu",
            "--window-size=1366,768"
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
}

// --- AUTHENTICATION ---
async function authenticate(page) {
    console.log(`[Auth] Checking Session...`);
    
    // Set global timeout to 60 seconds (prevents 30s errors)
    page.setDefaultNavigationTimeout(60000);

    if (fs.existsSync(COOKIE_FILE)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
            await page.setCookie(...cookies);
        } catch (e) {}
    }

    try {
        await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    } catch (e) {}

    let isLoggedIn = await page.evaluate(() => 
        !!document.querySelector('.global-nav__me-photo') || window.location.href.includes('/feed')
    );

    if (isLoggedIn) {
        console.log("[Auth] Active ✅");
        return true;
    }

    console.log("[Auth] Dead. Logging in...");
    if (!EMAIL || !PASSWORD) return false;

    try {
        await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle2" });
        await page.type('#username', EMAIL, { delay: 50 });
        await page.type('#password', PASSWORD, { delay: 50 });
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: "domcontentloaded" });

        isLoggedIn = await page.evaluate(() => !!document.querySelector('.global-nav__me-photo'));
        if (isLoggedIn) {
            const newCookies = await page.cookies();
            fs.writeFileSync(COOKIE_FILE, JSON.stringify(newCookies, null, 2));
            return true;
        }
    } catch (e) { console.error(`[Auth] Failed: ${e.message}`); }
    return false;
}

// --- DIRECT LINKEDIN SEARCH ---
async function searchAndFollow(page, rawName) {
    const cleanName = cleanCompanyName(rawName);
    console.log(`   🔎 Searching LinkedIn for: "${cleanName}"`);

    const searchUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(cleanName)}&origin=SWITCH_SEARCH_VERTICAL`;
    
    try {
        // Increased timeout to 60s
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(rand(3000, 5000)); 

        const companyUrl = await page.evaluate(() => {
            const main = document.querySelector('main');
            if (!main) return null;
            const links = Array.from(main.querySelectorAll('a'));
            const target = links.find(l => 
                l.href.includes("/company/") && 
                !l.href.includes("/life/") &&
                !l.href.includes("/people/") &&
                !l.href.includes("/jobs/") &&
                l.innerText.trim().length > 0
            );
            return target ? target.href : null;
        });

        if (!companyUrl) {
            console.log("   ❌ No company found.");
            return "NOT_FOUND";
        }

        console.log(`   👉 Clicking Result: ${companyUrl}`);
        await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(rand(2000, 4000));

        const alreadyFollowing = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const followingBtn = btns.find(b => b.innerText.match(/Following|Abonné/i));
            return !!followingBtn;
        });

        if (alreadyFollowing) {
            console.log("   👀 Already Following.");
            return "ALREADY";
        }

        const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const followBtn = buttons.find(b => {
                const txt = b.innerText.trim().toLowerCase();
                return txt === 'follow' || txt === 'suivre' || txt === '+ follow' || txt === '+ suivre';
            });
            if (followBtn) {
                followBtn.click();
                return true;
            }
            return false;
        });

        if (clicked) {
            console.log("   ✅ Followed Successfully!");
            return "SUCCESS";
        } else {
            console.log("   ⚠️ Follow button not found.");
            return "FAILED";
        }

    } catch (e) {
        console.warn(`   ⚠️ Error: ${e.message}`);
        // Return explicit ERROR status to trigger restart logic
        return "ERROR";
    }
}

// --- MAIN ---
(async () => {
    console.log("🚀 WORM-AI: SELF-HEALING MODE");
    console.log("⚠️ WARNING: SAFETY LIMITS REMOVED.");

    let companies = [];
    try {
        const raw = fs.readFileSync(JSON_FILE, 'utf-8');
        companies = JSON.parse(raw).map(c => c.company_name);
        console.log(`[Data] Targets Loaded: ${companies.length}`);
    } catch (e) { 
        console.error(`❌ JSON Load Error: ${e.message}`);
        process.exit(1); 
    }

    // Initialize Browser
    let browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    if (!await authenticate(page)) {
        await browser.close();
        process.exit(1);
    }

    const LIMIT = companies.length;
    let startIndex = loadProgress();
    if (startIndex > 0) console.log(`🔄 RESUMING CAMPAIGN from company #${startIndex + 1}...`);
    
    let successCount = 0;
    let consecutiveErrors = 0; // Track consecutive failures

    for (let i = startIndex; i < LIMIT; i++) {
        const company = companies[i];
        const progress = ((i + 1) / LIMIT * 100).toFixed(2);
        console.log(`\n[${i + 1}/${LIMIT}] (${progress}%) Processing...`);
        
        // Run Search
        const status = await searchAndFollow(page, company);
        
        if (status === "SUCCESS") {
            successCount++;
            consecutiveErrors = 0; // Reset error count on success
        } else if (status === "ERROR") {
            consecutiveErrors++;
            console.log(`   🚨 Consecutive Errors: ${consecutiveErrors}/3`);
        } else {
            // NOT_FOUND or ALREADY does not count as a crash error
            consecutiveErrors = 0;
        }

        // SAVE PROGRESS
        saveProgress(i + 1);

        // --- SELF-HEALING LOGIC ---
        // If we hit 3 errors in a row (e.g. Navigation Timeout), restart browser
        if (consecutiveErrors >= 3) {
            console.log("\n🛑 DETECTED BROWSER FREEZE (3 Timeouts). RESTARTING BROWSER...");
            try { await browser.close(); } catch(e) {} // Force close old browser
            
            await sleep(5000); // Wait for processes to clear
            
            // Re-launch
            console.log("🔄 Relaunching WORM-AI Browser...");
            browser = await launchBrowser();
            page = await browser.newPage();
            await page.setViewport({ width: 1366, height: 768 });
            await authenticate(page);
            consecutiveErrors = 0; // Reset counter
            console.log("✅ Browser Restarted. Continuing...");
        }
        // --------------------------

        const delay = rand(...SEARCH_DELAY);
        process.stdout.write(`   ⏳ Cooldown: ${Math.round(delay/1000)}s...`);
        await sleep(delay);
        console.log(""); 
    }

    console.log(`\n🏁 CAMPAIGN FINISHED.`);
    console.log(`👉 New Follows: ${successCount}`);
    saveProgress(0);
    await browser.close();
})();