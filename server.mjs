import express from "express";
import cron from "node-cron";
import { runOnce } from "./run-once.mjs";

const app = express();

const PORT = Number(process.env.PORT || 10000);

// Security
const RUN_TOKEN = process.env.RUN_TOKEN || ""; // set on Render env
const AUTO_RUN = (process.env.AUTO_RUN ?? "true").toLowerCase() === "true";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 20 * * *"; // 20:00 daily
const TZ = process.env.TZ || "Africa/Algiers";

// Keep-alive (helps prevent Render free sleep)
const SELF_PING_URL = process.env.SELF_PING_URL || ""; // e.g. https://jobscrapredz.onrender.com/health
const SELF_PING_INTERVAL_MIN = Number(process.env.SELF_PING_INTERVAL_MIN || 12);

// Runtime lock
let running = false;
let lastRun = null;

// Tiny health response (prevents cron-job.org "output too large")
app.get("/health", (req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.get("/", (req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("jobscrapredz is up. Use /health or /run?token=YOUR_RUN_TOKEN");
});

// Manual trigger (protected)
app.get("/run", async (req, res) => {
  const token = String(req.query.token || "");
  if (!RUN_TOKEN || token !== RUN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (running) {
    return res.status(409).json({ ok: false, error: "busy", lastRun });
  }

  running = true;
  try {
    const result = await runOnce({ reason: "manual" });
    lastRun = { at: new Date().toISOString(), ...result };
    return res.json(lastRun);
  } catch (e) {
    lastRun = {
      at: new Date().toISOString(),
      ok: false,
      error: String(e?.message || e),
    };
    return res.status(500).json(lastRun);
  } finally {
    running = false;
  }
});

// Optional: see what keywords bank is used (small output)
app.get("/bank", async (req, res) => {
  const token = String(req.query.token || "");
  if (!RUN_TOKEN || token !== RUN_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const result = await runOnce({ reason: "bank", bankOnly: true });
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`[Config] AUTO_RUN=${AUTO_RUN} CRON="${CRON_SCHEDULE}" TZ=${TZ}`);
  console.log(`[Config] SELF_PING_INTERVAL_MIN=${SELF_PING_INTERVAL_MIN} SELF_PING_URL=${SELF_PING_URL || "(disabled)"}`);
});

// Self-ping loop (keeps the service active *while it is running*)
async function selfPing() {
  if (!SELF_PING_URL) return;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    await fetch(SELF_PING_URL, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "jobscrapredz-self-ping" },
    });
    clearTimeout(t);
  } catch (e) {
    console.warn("[SelfPing] failed:", e?.message || e);
  }
}

if (SELF_PING_URL) {
  setTimeout(selfPing, 10_000);
  setInterval(selfPing, SELF_PING_INTERVAL_MIN * 60 * 1000);
}

// Auto-run daily schedule (works if the process stays awake)
if (AUTO_RUN) {
  cron.schedule(
    CRON_SCHEDULE,
    async () => {
      if (running) {
        console.warn("[AutoRun] skipped (already running)");
        return;
      }
      running = true;
      console.log(`[AutoRun] triggered (${CRON_SCHEDULE} TZ=${TZ})`);
      try {
        const result = await runOnce({ reason: "scheduled" });
        lastRun = { at: new Date().toISOString(), ...result };
        console.log("[AutoRun] done:", { ok: lastRun.ok, sent: lastRun.sent, matched: lastRun.matched, scanned: lastRun.scanned });
      } catch (e) {
        console.error("[AutoRun] error:", e?.message || e);
      } finally {
        running = false;
      }
    },
    { timezone: TZ }
  );
}
