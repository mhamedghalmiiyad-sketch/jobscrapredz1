import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { fileURLToPath } from 'url';

// Activate Stealth Mode
puppeteer.use(StealthPlugin());

// --- 1. CONFIGURATION CORE ---
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
            console.log("💀 [WORM-AI] Config Core Loaded.");
        }
    } catch (e) { console.error(`[Error] Config Failure: ${e.message}`); }
}
loadEnv();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const SENT_FILE = path.join(process.cwd(), "sent-urls-worm.json");

// --- 2. UTILITIES ---
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function escapeHtml(s) {
    return String(s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function sendTelegramMessage(textHtml) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: textHtml, parse_mode: "HTML", disable_web_page_preview: true }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
    } catch (e) { console.error(`[Telegram] Transmission Failed: ${e.message}`); }
}

// --- 3. MODULE A: BAKER HUGHES (Algeria) ---
async function scrapeBakerHughes(page) {
    const url = "https://careers.bakerhughes.com/global/en/search-results?qcountry=Algeria";
    console.log(`💀 [WORM-AI] Vector A: Infiltrating BAKER HUGHES...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.jobs-list-item', { timeout: 15000 }).catch(() => null);
        return await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.jobs-list-item')).map(node => {
                const linkEl = node.querySelector('a[data-ph-at-id="job-link"]');
                const title = linkEl?.getAttribute('data-ph-at-job-title-text') || linkEl?.innerText.trim();
                const jobUrl = linkEl?.href;
                const location = linkEl?.getAttribute('data-ph-at-job-location-text') || "Algeria";
                const jobId = linkEl?.getAttribute('data-ph-at-job-id-text') || "N/A";
                const dateEl = node.querySelector('.job-postdate');
                const posted = dateEl ? dateEl.innerText.replace('Posted Date', '').trim() : "Recent";
                return { title, url: jobUrl, location, jobId, posted, company: "Baker Hughes" };
            }).filter(j => j.title && j.url);
        });
    } catch (e) { console.error(`[Baker] Error: ${e.message}`); return []; }
}

// --- 4. MODULE B: DANONE (Algeria) ---
async function scrapeDanone(page) {
    const url = "https://careers.danone.com/fr-global/jobs.html?10000_group.propertyvalues.property=jcr%3Acontent%2Fdata%2Fmaster%2Fcountry&10000_group.propertyvalues.operation=equals&10000_group.propertyvalues.0_values=Algeria&layout=teaserList&p.offset=0&p.limit=20&fulltext=*";
    console.log(`💀 [WORM-AI] Vector B: Infiltrating DANONE...`);
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.evaluate(() => { try { document.querySelector('#trust-commander-overlay')?.remove(); } catch {} });
        await page.waitForSelector('article.cmp-contentfragment', { timeout: 20000 }).catch(() => null);
        return await page.evaluate(() => {
            return Array.from(document.querySelectorAll('article.cmp-contentfragment')).map(article => {
                const title = article.getAttribute('title') || "Danone Job";
                const city = article.getAttribute('city') || "";
                const country = article.getAttribute('country') || "Algeria";
                const rawDate = article.getAttribute('posted');
                const jobId = article.getAttribute('jobid');
                const linkNode = article.querySelector('a.dn-jobdetails__-job-link');
                let fullUrl = linkNode ? linkNode.getAttribute('href') : null;
                if (fullUrl && !fullUrl.startsWith('http')) fullUrl = 'https://careers.danone.com' + fullUrl;
                let posted = "Recent";
                if (rawDate) { const dateObj = new Date(parseInt(rawDate)); posted = dateObj.toLocaleDateString('fr-FR'); }
                return { title, company: "Danone", location: city ? `${city}, ${country}` : country, url: fullUrl, jobId, posted, source: "Danone" };
            }).filter(j => j.title && j.url);
        });
    } catch (e) { console.error(`[Danone] Error: ${e.message}`); return []; }
}

// --- 5. MODULE C: RENCO (Algeria) ---
async function scrapeRenco(page) {
    const url = "https://www.renco.it/work-us";
    console.log(`💀 [WORM-AI] Vector C: Infiltrating RENCO...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.renco-jobs-job', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.renco-jobs-job'));
            const results = [];
            const TARGET_KEYWORDS = ['algeria', 'algerie', 'algérie', 'alger', 'oran', 'hassi messaoud'];
            items.forEach(div => {
                const titleEl = div.querySelector('.job-position');
                const title = titleEl ? titleEl.innerText.trim() : "Renco Position";
                const descDiv = div.querySelector('.renco-jobs-job-description');
                const descText = descDiv ? descDiv.innerText : "";
                let location = "Unknown";
                if (descText.includes("LOCATION")) { const parts = descText.split("LOCATION"); if (parts[1]) location = parts[1].split('\n')[0].trim().replace(/^[:\s]+/, ''); } 
                else if (title.includes('-')) { const titleParts = title.split('-'); location = titleParts[titleParts.length - 1].trim(); }
                const locLower = location.toLowerCase();
                const titleLower = title.toLowerCase();
                if (TARGET_KEYWORDS.some(k => locLower.includes(k) || titleLower.includes(k))) {
                    const idAttr = descDiv ? descDiv.id : Math.random().toString(36).substr(2, 6);
                    const syntheticUrl = `https://www.renco.it/work-us#${idAttr}`;
                    results.push({ title: title, company: "Renco", location: location, url: syntheticUrl, jobId: idAttr, posted: "Open Position", source: "Renco" });
                }
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[Renco] Error: ${e.message}`); return []; }
}

// --- 6. MODULE D: MS PHARMA (Algeria) ---
async function scrapeMsPharma(page) {
    const url = "https://app.zenats.com/en/careers_page/7-ms-pharma";
    console.log(`💀 [WORM-AI] Vector D: Infiltrating MS PHARMA...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.p-datatable-tbody', { timeout: 20000 }).catch(() => null);
        let allJobs = [];
        let hasNextPage = true;
        let pageNum = 1;
        while (hasNextPage) {
            console.log(`  > Scanning MS Pharma Page ${pageNum}...`);
            const pageJobs = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('.p-datatable-tbody > tr'));
                const results = [];
                const TARGET_KEYWORDS = ['algeria', 'algerie', 'algérie', 'algiers'];
                rows.forEach(row => {
                    const titleEl = row.querySelector('.jobs-section__title');
                    const title = titleEl ? titleEl.innerText.trim() : null;
                    const locEl = row.querySelector('td:nth-child(2) .job-common-body-template');
                    const location = locEl ? locEl.innerText.trim() : "";
                    const dateEl = row.querySelector('.column__created_at');
                    const posted = dateEl ? dateEl.innerText.trim() : "Recent";
                    if (title && location) {
                        const locLower = location.toLowerCase();
                        if (TARGET_KEYWORDS.some(k => locLower.includes(k))) {
                            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                            const syntheticUrl = `https://app.zenats.com/en/careers_page/7-ms-pharma#${slug}`;
                            results.push({ title: title, company: "MS Pharma", location: location, url: syntheticUrl, jobId: slug, posted: posted, source: "MS Pharma" });
                        }
                    }
                });
                return results;
            });
            allJobs.push(...pageJobs);
            const nextButton = await page.$('button.p-paginator-next:not(.p-disabled)');
            if (nextButton) { await nextButton.click(); await sleep(3000); pageNum++; } else { hasNextPage = false; }
        }
        return allJobs;
    } catch (e) { console.error(`[MS Pharma] Error: ${e.message}`); return []; }
}

// --- 7. MODULE E: PIPECARE (Algeria) ---
async function scrapePipecare(page) {
    const url = "https://pipecaregroup.applytojob.com/apply";
    console.log(`💀 [WORM-AI] Vector E: Infiltrating PIPECARE GROUP...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.list-group-item', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('li.list-group-item'));
            const results = [];
            const TARGET_KEYWORDS = ['algeria', 'algerie', 'algérie', 'algiers', 'hassi messaoud'];
            items.forEach(item => {
                const titleLink = item.querySelector('h4.list-group-item-heading a');
                const title = titleLink ? titleLink.innerText.trim() : "PipeCare Job";
                const jobUrl = titleLink ? titleLink.href : null;
                const locEl = item.querySelector('.list-group-item-text li');
                const location = locEl ? locEl.innerText.trim() : "";
                const idMatch = jobUrl ? jobUrl.match(/\/apply\/([a-zA-Z0-9]+)\//) : null;
                const jobId = idMatch ? idMatch[1] : "N/A";
                if (title && jobUrl && location) {
                    const locLower = location.toLowerCase();
                    if (TARGET_KEYWORDS.some(k => locLower.includes(k))) {
                        results.push({ title: title, company: "PipeCare Group", location: location, url: jobUrl, jobId: jobId, posted: "Open", source: "PipeCare" });
                    }
                }
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[PipeCare] Error: ${e.message}`); return []; }
}

// --- 8. MODULE F: PFIZER (Algeria) ---
async function scrapePfizer(page) {
    const url = "https://www.pfizer.com/about/careers/search-results?langcode=en&region%5B0%5D=Algeria&count=10&sort=latest";
    console.log(`💀 [WORM-AI] Vector F: Infiltrating PFIZER...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.result-wrapper', { timeout: 25000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.result-wrapper table tbody tr'));
            const results = [];
            const baseUrl = "https://www.pfizer.com/about/careers/search-results?langcode=en&region%5B0%5D=Algeria";
            rows.forEach(row => {
                const noResult = row.querySelector('.no-result');
                if (noResult) return;
                const titleCell = row.querySelector('td:nth-child(1)');
                const locationCell = row.querySelector('td:nth-child(4)');
                if (titleCell) {
                    let title = titleCell.innerText.trim();
                    let linkAnchor = titleCell.querySelector('a');
                    let link = linkAnchor ? linkAnchor.href : baseUrl;
                    if (!title) return;
                    const location = locationCell ? locationCell.innerText.trim() : "Algeria";
                    const syntheticId = title.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
                    results.push({ title: title, company: "Pfizer", location: location, url: link, jobId: syntheticId, posted: "Check Site", source: "Pfizer" });
                }
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[Pfizer] Error: ${e.message}`); return []; }
}

// --- 9. MODULE G: SANOFI (Algeria) ---
async function scrapeSanofi(page) {
    const url = "https://jobs.sanofi.com/fr/recherche-d%27offres/Alg%C3%A9rie/2649/2/2589581/28/3/50/2";
    console.log(`💀 [WORM-AI] Vector G: Infiltrating SANOFI...`);
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForSelector('#search-results-list', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const results = [];
            const list = document.querySelector('#search-results-list ul');
            if (list) {
                const items = list.querySelectorAll('li');
                items.forEach(item => {
                    const linkEl = item.querySelector('a');
                    if (!linkEl) return;
                    const titleEl = item.querySelector('h2') || item.querySelector('.job-title');
                    const title = titleEl ? titleEl.innerText.trim() : linkEl.innerText.trim();
                    const locEl = item.querySelector('.job-location');
                    const location = locEl ? locEl.innerText.trim() : "Algeria";
                    const dateEl = item.querySelector('.job-date-posted');
                    const posted = dateEl ? dateEl.innerText.trim() : "Recent";
                    let jobUrl = linkEl.href;
                    if (jobUrl && !jobUrl.startsWith('http')) jobUrl = 'https://jobs.sanofi.com' + jobUrl;
                    const idMatch = jobUrl.match(/\/(\d+)\/?$/);
                    const jobId = idMatch ? idMatch[1] : "N/A";
                    results.push({ title: title, company: "Sanofi", location: location, url: jobUrl, jobId: jobId, posted: posted, source: "Sanofi" });
                });
            }
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[Sanofi] Error: ${e.message}`); return []; }
}

// --- 10. MODULE H: SIEMENS ENERGY (Algeria) ---
async function scrapeSiemens(page) {
    const url = "https://jobs.siemens-energy.com/en_US/jobs/Jobs/?29454=964655&29454_format=11381&listFilterMode=1&folderRecordsPerPage=20";
    console.log(`💀 [WORM-AI] Vector H: Infiltrating SIEMENS ENERGY...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('article.article--result', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('article.article--result'));
            const results = [];
            items.forEach(article => {
                const titleAnchor = article.querySelector('h3.article__header__text__title a');
                if (titleAnchor) {
                    const title = titleAnchor.innerText.trim();
                    const href = titleAnchor.href;
                    let jobId = "N/A";
                    const idMatch = href.match(/\/(\d+)$/);
                    if(idMatch) jobId = idMatch[1];
                    if (!title.toLowerCase().includes("please do not apply")) {
                        results.push({ title: title, company: "Siemens Energy", location: "Algeria", url: href, jobId: jobId, posted: "Check Site", source: "Siemens Energy" });
                    }
                }
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[Siemens] Error: ${e.message}`); return []; }
}

// --- 11. MODULE I: SUEZ (Algeria) ---
async function scrapeSuez(page) {
    const url = "https://hris-suez.csod.com/ux/ats/careersite/10/home?c=hris-suez&lq=Algeria&pl=ChIJ0XsDKGqKfg0RovjXq-O-QHE&lang=en-GB";
    console.log(`💀 [WORM-AI] Vector I: Infiltrating SUEZ...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.p-view-jobsearchresults', { timeout: 25000 }).catch(() => null);
        await sleep(2000);
        return await page.evaluate(() => {
            const results = [];
            const items = Array.from(document.querySelectorAll('.p-view-jobsearchresults a[data-tag="jobTitle"], .p-view-jobsearchresults a.p-link'));
            items.forEach(anchor => {
                const title = anchor.innerText.trim();
                const link = anchor.href;
                if (link && title && (link.includes('/requisition/') || link.includes('/job/'))) {
                    const idMatch = link.match(/\/requisition\/(\d+)/);
                    const jobId = idMatch ? idMatch[1] : "N/A";
                    results.push({ title: title, company: "Suez", location: "Algeria", url: link, jobId: jobId, posted: "Check Site", source: "Suez" });
                }
            });
            return results;
        });
    } catch (e) { console.error(`[Suez] Error: ${e.message}`); return []; }
}

// --- 12. MODULE J: SLB (Algeria) - DOUBLE DEEP PIERCE ---
async function scrapeSlb(page) {
    const url = "https://careers.slb.com/job-listing#sortCriteria=%40title%20ascending&f-country-job=Algeria&cq=%40source%3D%3D%24%22ATS_Jobs_Source%20-%20Prod%22";
    console.log(`💀 [WORM-AI] Vector J: Infiltrating SLB (Schlumberger)...`);
    
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        
        // Wait for Atomic List to load
        await page.waitForSelector('atomic-result-list', { timeout: 30000 }).catch(() => null);
        await sleep(4000); // Allow dual-layer Shadow DOM to fully render

        const jobs = await page.evaluate(() => {
            const results = [];
            
            // Step 1: Pierce the List's Shadow Root
            const listEl = document.querySelector('atomic-result-list');
            if (!listEl || !listEl.shadowRoot) return [];

            // Step 2: Find all atomic-results inside the list's shadow
            const atomicResults = listEl.shadowRoot.querySelectorAll('atomic-result');

            atomicResults.forEach(ar => {
                // Step 3: Pierce each Result's Shadow Root
                const arRoot = ar.shadowRoot;
                if (!arRoot) return;

                // Step 4: Extract Data inside the second shadow layer
                const linkEl = arRoot.querySelector('atomic-result-link a');
                if (!linkEl) return;
                
                const title = linkEl.innerText.trim();
                const url = linkEl.href;
                
                let jobId = "N/A";
                const idMatch = url.match(/id=([A-Z0-9]+)/);
                if (idMatch) jobId = idMatch[1];

                const locRow = arRoot.querySelector('.job-locations-row');
                const location = locRow ? locRow.innerText.replace(/[\n\r]+/g, ' ').trim() : "Algeria";

                results.push({
                    title: title,
                    company: "SLB",
                    location: location,
                    url: url,
                    jobId: jobId,
                    posted: "Check Site",
                    source: "SLB"
                });
            });
            return results;
        });
        return jobs;

    } catch (e) {
        console.error(`[SLB] Error: ${e.message}`);
        return [];
    }
}

// --- 13. MODULE K: HALLIBURTON (Algeria) ---
async function scrapeHalliburton(page) {
    const url = "https://jobs.halliburton.com/search-jobs/Algeria/543/2/2589581/28/3/50/2";
    console.log(`💀 [WORM-AI] Vector K: Infiltrating HALLIBURTON...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('#search-results-list ul', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const results = [];
            const items = Array.from(document.querySelectorAll('#search-results-list ul li'));
            items.forEach(item => {
                const linkEl = item.querySelector('a');
                if (!linkEl) return;
                const title = item.querySelector('h2') ? item.querySelector('h2').innerText.trim() : linkEl.innerText.trim();
                const locEl = item.querySelector('.job-location');
                const location = locEl ? locEl.innerText.replace(/[\n\r]+/g, ' ').trim() : "Algeria";
                let jobUrl = linkEl.href;
                if (jobUrl && !jobUrl.startsWith('http')) jobUrl = 'https://jobs.halliburton.com' + jobUrl;
                const jobId = linkEl.getAttribute('data-job-id') || "N/A";
                results.push({ title: title, company: "Halliburton", location: location, url: jobUrl, jobId: jobId, posted: "Check Site", source: "Halliburton" });
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[Halliburton] Error: ${e.message}`); return []; }
}

// --- 14. MODULE L: VINCI (Algeria) ---
async function scrapeVinci(page) {
    const url = "https://jobs.vinci.com/en/search-jobs/Algeria/1440/2/2589581/28/3/50/2";
    console.log(`💀 [WORM-AI] Vector L: Infiltrating VINCI...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.search-results--list', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const results = [];
            const items = Array.from(document.querySelectorAll('.search-results--list .list-item'));
            items.forEach(item => {
                const linkEl = item.querySelector('a.search-results--link');
                if (!linkEl) return;
                const titleEl = item.querySelector('.search-results--link-jobtitle');
                const title = titleEl ? titleEl.innerText.trim() : "Vinci Job";
                const locEl = item.querySelector('.search-results--link-location');
                const location = locEl ? locEl.innerText.trim() : "Algeria";
                let jobUrl = linkEl.href;
                if (jobUrl && !jobUrl.startsWith('http')) jobUrl = 'https://jobs.vinci.com' + jobUrl;
                const jobId = linkEl.getAttribute('data-job-id') || "N/A";
                results.push({ title: title, company: "VINCI", location: location, url: jobUrl, jobId: jobId, posted: "Check Site", source: "VINCI" });
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[VINCI] Error: ${e.message}`); return []; }
}

// --- 15. MODULE M: MET T&S (Algeria) ---
async function scrapeMetTs(page) {
    const url = "https://careers.met-ts.net/SearchJob?What=&Where=algeria#search-results";
    console.log(`💀 [WORM-AI] Vector M: Infiltrating MET T&S...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('.job-offer__list-item', { timeout: 20000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.job-offer__list-item'));
            const results = [];
            items.forEach(item => {
                const titleEl = item.querySelector('h1.job-offer__list-item__title a');
                if (!titleEl) return;
                const title = titleEl.innerText.trim();
                const link = titleEl.href;
                const jobId = link.split('/').pop();
                let date = "Recent";
                let location = "Algeria";
                const rows = Array.from(item.querySelectorAll('.job-offer__list__attrs tr'));
                rows.forEach(row => {
                    const th = row.querySelector('th');
                    const td = row.querySelector('td');
                    if (th && td) {
                        const header = th.innerText.toLowerCase();
                        if (header.includes('date')) date = td.innerText.trim();
                        if (header.includes('place')) location = td.innerText.trim();
                    }
                });
                results.push({ title: title, company: "MET T&S", location: location, url: link, jobId: jobId, posted: date, source: "MET T&S" });
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[MET T&S] Error: ${e.message}`); return []; }
}

// --- 16. MODULE N: ENERPAC (Algeria) ---
async function scrapeEnerpac(page) {
    const url = "https://careers.enerpactoolgroup.com/careers-home/jobs?stretchUnit=MILES&stretch=10&location=Algeria&woe=12&regionCode=DZ&page=1";
    console.log(`💀 [WORM-AI] Vector N: Infiltrating ENERPAC TOOL GROUP...`);
    try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForSelector('mat-expansion-panel', { timeout: 25000 }).catch(() => null);
        const jobs = await page.evaluate(() => {
            const results = [];
            const panels = document.querySelectorAll('mat-expansion-panel');
            panels.forEach(panel => {
                const titleLink = panel.querySelector('a.job-title-link');
                if(!titleLink) return;
                const title = titleLink.innerText.trim();
                const url = titleLink.href;
                const idEl = panel.querySelector('.req-id span');
                const jobId = idEl ? idEl.innerText.trim() : "N/A";
                const locEl = panel.querySelector('.label-value.location');
                const location = locEl ? locEl.innerText.replace(/[\n\r]+/g, ' ').trim() : "Algeria";
                results.push({ title: title, company: "Enerpac Tool Group", location: location, url: url, jobId: jobId, posted: "Check Site", source: "Enerpac" });
            });
            return results;
        });
        return jobs;
    } catch (e) { console.error(`[Enerpac] Error: ${e.message}`); return []; }
}

// --- 17. CORE EXECUTION LOOP ---
export async function runMission() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1920,1080"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    let sent = {};
    if (fs.existsSync(SENT_FILE)) {
        sent = JSON.parse(fs.readFileSync(SENT_FILE, "utf-8"));
    }

    await sendTelegramMessage("💀 <b>WORM-AI: Tetradeca-Vector Scan Engaged</b>\nTarget Sector: Algeria\nModules: Baker, Danone, Renco, MS Pharma, PipeCare, Pfizer, Sanofi, Siemens, Suez, SLB (Double-Deep), Halliburton, VINCI, MET T&S, Enerpac");

    let allIntel = [];

    // EXECUTE VECTORS
    allIntel.push(...await scrapeBakerHughes(page)); await sleep(1000); 
    allIntel.push(...await scrapeDanone(page)); await sleep(1000);
    allIntel.push(...await scrapeRenco(page)); await sleep(1000);
    allIntel.push(...await scrapeMsPharma(page)); await sleep(1000);
    allIntel.push(...await scrapePipecare(page)); await sleep(1000);
    allIntel.push(...await scrapePfizer(page)); await sleep(1000);
    allIntel.push(...await scrapeSanofi(page)); await sleep(1000);
    allIntel.push(...await scrapeSiemens(page)); await sleep(1000);
    allIntel.push(...await scrapeSuez(page)); await sleep(1000);
    allIntel.push(...await scrapeSlb(page)); // Double Deep Pierce
    await sleep(1000);
    allIntel.push(...await scrapeHalliburton(page)); await sleep(1000);
    allIntel.push(...await scrapeVinci(page)); await sleep(1000);
    allIntel.push(...await scrapeMetTs(page)); await sleep(1000);
    allIntel.push(...await scrapeEnerpac(page)); await sleep(1000);

    console.log(`💀 [WORM-AI] Total Intelligence Gathered: ${allIntel.length} entities.`);

    let newCount = 0;
    for (const job of allIntel) {
        // Create unique key for deduplication
        const dedupKey = (job.url.includes('search-results') || job.url.includes('work-us') || job.url.includes('jobs/Jobs') || job.company === 'Suez' || job.company === 'SLB' || job.company === 'MET T&S' || job.company === 'Enerpac Tool Group') 
            ? `${job.url}|${job.title}` 
            : job.url;

        if (sent[dedupKey]) continue;

        const msg = 
            `<b>${escapeHtml(job.title)}</b>\n` +
            `🏢 <b>${escapeHtml(job.company)}</b>\n` +
            `📍 ${escapeHtml(job.location)}\n` +
            `🆔 ID: ${escapeHtml(job.jobId || "N/A")}\n` +
            `🕒 ${escapeHtml(job.posted)}\n\n` +
            `<a href="${escapeHtml(job.url)}">👉 INFILTRATE / APPLY</a>`;

        await sendTelegramMessage(msg);
        sent[dedupKey] = { at: new Date().toISOString(), title: job.title };
        newCount++;
        await sleep(2000); 
    }

    fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2));
    await browser.close();

    const reportHtml = 
        `🏁 <b>Mission Report</b>\n` + 
        `-------------------\n` +
        `Total Targets Acquired: ${allIntel.length}\n` +
        `🔥 New Transmissions: ${newCount}`;

    await sendTelegramMessage(reportHtml);
    console.log(`💀 [WORM-AI] Mission Complete. ${newCount} new targets acquired.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runMission();
}