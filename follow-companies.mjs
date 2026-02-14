import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Activate Stealth Mode
puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---
const JSON_FILE = "emploitic_companies.json"; 
const COOKIE_FILE = "linkedin..txt"; 
const PROGRESS_FILE = "follow_progress_emploitic.json"; 

// ✅ CREDENTIALS ADDED DIRECTLY
const EMAIL = "ghalmimiyad@gmail.com";
const PASSWORD = "aezakmixu";

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
        ]
    });
}

// --- AUTHENTICATION ---
async function authenticate(page) {
    console.log(`[Auth] Checking Session using: ${COOKIE_FILE}`);
    page.setDefaultNavigationTimeout(60000);

    // 1. Try to load cookies
    if (fs.existsSync(COOKIE_FILE)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
            await page.setCookie(...cookies);
            console.log(`[Auth] Cookies loaded.`);
        } catch (e) {
            console.log(`[Auth] Cookie file corrupt.`);
        }
    }

    // 2. Check if logged in
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

    // 3. Login Flow
    console.log("[Auth] Session expired. Logging in with credentials...");
    
    try {
        await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle2" });
        await page.type('#username', EMAIL, { delay: 50 });
        await page.type('#password', PASSWORD, { delay: 50 });
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: "domcontentloaded" });

        // Double check login success
        isLoggedIn = await page.evaluate(() => !!document.querySelector('.global-nav__me-photo'));
        if (isLoggedIn) {
            console.log("[Auth] Login Successful! Saving new cookies...");
            const newCookies = await page.cookies();
            fs.writeFileSync(COOKIE_FILE, JSON.stringify(newCookies, null, 2));
            return true;
        } else {
            console.error("[Auth] Login Failed. Check if a CAPTCHA appeared.");
        }
    } catch (e) { console.error(`[Auth] Failed: ${e.message}`); }
    return false;
}

// --- FIXED SEARCH & FOLLOW FUNCTION ---
async function searchAndFollow(page, rawName) {
    const cleanName = cleanCompanyName(rawName);
    console.log(`   🔎 Searching: "${cleanName}"`);

    const searchUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(cleanName)}&origin=SWITCH_SEARCH_VERTICAL`;
    
    try {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(rand(3000, 5000)); 

        // 1. Find the correct company URL
        const companyUrl = await page.evaluate(() => {
            const main = document.querySelector('main');
            if (!main) return null;
            const links = Array.from(main.querySelectorAll('a'));
            const target = links.find(l => 
                l.href.includes("/company/") && 
                !l.href.includes("/life/") &&
                !l.href.includes("/people/") &&
                !l.href.includes("/jobs/") &&
                !l.href.includes("linkedin.com/search") &&
                l.innerText.trim().length > 0
            );
            return target ? target.href : null;
        });

        if (!companyUrl) {
            console.log("   ❌ No company found.");
            return "NOT_FOUND";
        }

        console.log(`   👉 Visiting: ${companyUrl}`);
        await page.goto(companyUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        
        try {
            await page.waitForSelector('.org-top-card', { timeout: 10000 });
        } catch(e) {}
        await sleep(rand(2000, 3000));

        // 2. CHECK STATUS & CLICK (Scoped to Header Only)
        const actionResult = await page.evaluate(() => {
            const getText = (el) => (el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
            const getAria = (el) => (el.getAttribute('aria-label') || "").toLowerCase();

            const header = document.querySelector('.org-top-card') || document.querySelector('.org-page-navigation__header') || document.body;
            const buttons = Array.from(header.querySelectorAll('button'));

            // Check if WE are already following
            const alreadyBtn = buttons.find(b => {
                const txt = getText(b);
                const aria = getAria(b);
                return txt.includes('following') || txt.includes('abonné') || aria.includes('following') || aria.includes('abonné');
            });

            if (alreadyBtn) return "ALREADY";

            // Find "Follow" button
            const followBtn = buttons.find(b => {
                const txt = getText(b);
                const aria = getAria(b);
                return (txt === 'follow' || txt === 'suivre' || txt === '+ follow' || txt === '+ suivre') ||
                       (aria.includes('follow ') || aria.includes('suivre '));
            });

            if (followBtn) {
                followBtn.click();
                return "CLICKED";
            }

            return "NO_BUTTON";
        });

        if (actionResult === "ALREADY") {
            console.log("   👀 Already Following.");
            return "ALREADY";
        }

        if (actionResult === "NO_BUTTON") {
            console.log("   ⚠️ 'Follow' button not found.");
            return "FAILED";
        }

        if (actionResult === "CLICKED") {
            console.log("   👉 Clicked Follow. Verifying...");
            await sleep(2000); 

            // 3. VERIFICATION
            const isSuccess = await page.evaluate(() => {
                const header = document.querySelector('.org-top-card') || document.body;
                const buttons = Array.from(header.querySelectorAll('button'));
                return buttons.some(b => {
                    const txt = (b.innerText || "").toLowerCase();
                    return txt.includes('following') || txt.includes('abonné');
                });
            });

            if (isSuccess) {
                console.log("   ✅ Success: Status changed.");
                return "SUCCESS";
            } else {
                console.log("   ⚠️ Clicked but status didn't update.");
                return "FAILED";
            }
        }

    } catch (e) {
        console.warn(`   ⚠️ Error: ${e.message}`);
        return "ERROR";
    }
}

// --- MAIN ---
(async () => {
    console.log("🚀 WORM-AI: EMPLOITIC CAMPAIGN");
    console.log("⚠️ WARNING: SAFETY LIMITS REMOVED.");

    let companies = [];
    try {
        const raw = fs.readFileSync(JSON_FILE, 'utf-8');
        companies = JSON.parse(raw).map(c => c.name); 
        console.log(`[Data] Targets Loaded: ${companies.length}`);
    } catch (e) { 
        console.error(`❌ JSON Load Error: ${e.message}`);
        process.exit(1); 
    }

    let browser = await launchBrowser();
    let page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    if (!await authenticate(page)) {
        console.log("🛑 Authentication failed.");
        await browser.close();
        process.exit(1);
    }

    const LIMIT = companies.length;
    let startIndex = loadProgress();
    if (startIndex > 0) console.log(`🔄 RESUMING CAMPAIGN from company #${startIndex + 1}...`);
    
    let successCount = 0;
    let consecutiveErrors = 0;

    for (let i = startIndex; i < LIMIT; i++) {
        const company = companies[i];
        const progress = ((i + 1) / LIMIT * 100).toFixed(2);
        console.log(`\n[${i + 1}/${LIMIT}] (${progress}%) Processing...`);
        
        const status = await searchAndFollow(page, company);
        
        if (status === "SUCCESS") {
            successCount++;
            consecutiveErrors = 0;
        } else if (status === "ERROR") {
            consecutiveErrors++;
            console.log(`   🚨 Consecutive Errors: ${consecutiveErrors}/3`);
        } else {
            consecutiveErrors = 0;
        }

        saveProgress(i + 1);

        if (consecutiveErrors >= 3) {
            console.log("\n🛑 DETECTED BROWSER FREEZE. RESTARTING...");
            try { await browser.close(); } catch(e) {}
            await sleep(5000);
            browser = await launchBrowser();
            page = await browser.newPage();
            await page.setViewport({ width: 1366, height: 768 });
            await authenticate(page);
            consecutiveErrors = 0;
        }

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