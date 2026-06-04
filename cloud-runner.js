/**
 * cloud-runner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Headless Playwright runner for mediasoup proctoring load tests.
 * Creates users via API, then runs the full proctoring flow per worker.
 * * * Y4M Optimized for low-CPU load testing.
 * * CommonJS (CJS) version with dotenv support.
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL       = process.env.BASE_URL         || 'http://localhost:5173';
const API_BASE_URL   = process.env.API_BASE_URL      || `${BASE_URL}/api`;
const TEMPLATE_ID    = process.env.TEMPLATE_ID       || 'advanced-proctoring';
const NUM_WORKERS    = parseInt(process.env.NUM_WORKERS     || '5',      10);
const WAITING_TIME   = parseInt(process.env.WAITING_TIME    || '600000', 10);
const STAGGER_TIME   = parseInt(process.env.STAGGER_TIME_MS || '8000',   10);
const CONCURRENCY    = parseInt(process.env.CONCURRENCY     || String(NUM_WORKERS), 10);
const HEADED         = process.env.HEADED === 'true';

// Step toggles — default ON, set env var to 'false' to disable
const RUN_PHOTO_CAPTURE    = process.env.RUN_PHOTO_CAPTURE    !== 'false';
const RUN_ID_VERIFICATION  = process.env.RUN_ID_VERIFICATION  !== 'false';
const RUN_MOBILE_RECORDING = process.env.RUN_MOBILE_RECORDING !== 'false';
const RUN_ROOM_SCAN        = process.env.RUN_ROOM_SCAN        !== 'false';

// Point directly to the Y4M file
const VIDEO_FILE_PATH = path.join(__dirname, 'assets', 'face-test.y4m');
const FACE_IMAGE_PATH = path.join(__dirname, 'assets', 'face.png');

// ── Metrics ───────────────────────────────────────────────────────────────────

const metrics = { created: 0, started: 0, passed: 0, failed: 0, errors: [] };

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(idx, user, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] Worker ${idx} (${user}): ${msg}`);
}

async function makeRequest(url, opts, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try { 
      return await fetch(url, opts); 
    }
    catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}

// ── Create user + session via API ─────────────────────────────────────────────

async function createUser(idx) {
  const t0       = Date.now();
  const username = `stress_test_user_${idx}_${t0}`;
  const fullName = `Stress Test User ${idx}`;
  const password = `StressTest_${idx}_${t0}!`;

  log(idx, username, '🔧 Registering...');
  const regRes = await makeRequest(`${API_BASE_URL}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, fullName, password, role: 'student' }),
  });
  if (!regRes.ok) throw new Error(`Register failed: ${await regRes.text()}`);
  const userId = (await regRes.json()).user?.id;

  log(idx, username, '🔑 Logging in...');
  const loginRes = await makeRequest(`${API_BASE_URL}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${await loginRes.text()}`);
  const { accessToken: token } = await loginRes.json();
  if (!token) throw new Error('No accessToken returned');

  log(idx, username, '📋 Creating session...');
  const sessRes = await makeRequest(`${API_BASE_URL}/create-session-from-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, fullName, templateId: TEMPLATE_ID }),
  });
  if (!sessRes.ok) throw new Error(`Create session failed: ${await sessRes.text()}`);
  const sessData = await sessRes.json();

  metrics.created++;
  log(idx, username, `✅ Session created: ${sessData.sessionId}`);
  return { userId, username, fullName, password, token,
           sessionId: sessData.sessionId, roomId: sessData.roomId,
           template: sessData.template, idx };
}

// ── Playwright worker ─────────────────────────────────────────────────────────

async function runWorker(user) {
  const { username, password, idx } = user;

  // Stagger startup to avoid thundering herd on the mediasoup server
  if (idx > 0) {
    log(idx, username, `⏳ Staggering start by ${(idx * STAGGER_TIME) / 1000}s...`);
    await new Promise(r => setTimeout(r, idx * STAGGER_TIME));
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${VIDEO_FILE_PATH}`, // Natively loads the .y4m
      '--use-fake-ui-for-media-stream',      
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',             
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    metrics.started++;

    // ── Inject Native Fake Stream Overrides ──────────────────────────────────
    await page.addInitScript(() => {
      if (navigator.mediaDevices) {
        // Override getDisplayMedia to return the native Y4M fake webcam stream
        navigator.mediaDevices.getDisplayMedia = async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          const [track] = stream.getVideoTracks();
          
          // Clone the track and mock the settings to appear as a screen share
          const clone = track.clone();
          const origSettings = clone.getSettings.bind(clone);
          clone.getSettings = () => ({ 
            ...origSettings(), 
            displaySurface: 'monitor', 
            logicalSurface: true 
          });
          
          return new MediaStream([clone]);
        };
      }

      // Fake multi-screen API (some proctoring apps check for it)
      window.getScreenDetails = async () => ({
        screens: [{ label: 'Primary Monitor', isPrimary: true, isInternal: true }],
      });
    });

    // ── Navigate to exam (with retry) ─────────────────────────────────────────
    log(idx, username, '🌐 Navigating to exam...');
    let loaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(`${BASE_URL}/exam?templateId=${TEMPLATE_ID}`);
        loaded = true; break;
      } catch {
        log(idx, username, `⚠️ goto failed (attempt ${attempt}/3), retrying in 5s...`);
        await page.waitForTimeout(5000);
      }
    }
    if (!loaded) throw new Error('Failed to load page after 3 attempts');

    // ── Login ─────────────────────────────────────────────────────────────────
    await page.waitForURL(/.*login/, { timeout: 15000 });
    log(idx, username, '🔒 On login page, filling credentials...');
    await page.getByPlaceholder('Username').fill(username);
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await page.waitForURL(/.*exam.*/, { timeout: 30000 });
    log(idx, username, '✅ Logged in.');

    // Share screen button (appears on some templates)
    const screenShareBtn = page.getByRole('button', { name: /share screen/i });
    if (await screenShareBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await screenShareBtn.click();
    }

    // ── Step 1: Photo capture ─────────────────────────────────────────────────
    if (RUN_PHOTO_CAPTURE) {
      log(idx, username, '⏳ Waiting for AI models to load...');
      await page.getByRole('button', { name: /capture/i })
        .waitFor({ state: 'visible', timeout: 300000 });
      log(idx, username, '✅ AI models ready. Uploading photo...');
      await page.locator('input[type="file"]').first().setInputFiles(FACE_IMAGE_PATH);
      const next1 = page.getByLabel('Identity verification').getByRole('button', { name: 'Next' });
      await next1.waitFor({ state: 'visible', timeout: 60000 });
      await next1.dispatchEvent('click');
      log(idx, username, '✅ Step 1 done.');
    }

    // ── Step 1.1: ID verification ─────────────────────────────────────────────
    if (RUN_ID_VERIFICATION) {
      log(idx, username, '📤 Step 1.1: Uploading ID photo...');
      await page.waitForTimeout(5000);
      const count  = await page.locator('input[type="file"]').count();
      const fileIn = page.locator('input[type="file"]').nth(count - 1);
      await fileIn.setInputFiles(FACE_IMAGE_PATH);
      try {
        await fileIn.evaluate(e => e.dispatchEvent(new Event('change', { bubbles: true })));
        await fileIn.evaluate(e => e.dispatchEvent(new Event('input',  { bubbles: true })));
      } catch (_) {}
      await page.waitForTimeout(5000);
      const next2 = page.getByLabel('Identity verification').getByRole('button', { name: 'Next' });
      await next2.waitFor({ state: 'visible', timeout: 60000 });
      await next2.dispatchEvent('click');
      log(idx, username, '✅ Step 1.1 done.');
    }

    // ── Step 3: Environment / room scan ───────────────────────────────────────
    if (RUN_MOBILE_RECORDING || RUN_ROOM_SCAN) {
      log(idx, username, '➡️ Step 3: Environment scan...');

      const qrUrlPromise = new Promise(resolve => {
        const handler = msg => {
          const match = msg.text().match(/QR Code URL:.*?(https?:\/\/\S+)/);
          if (match) { page.removeListener('console', handler); resolve(match[1]); }
        };
        page.on('console', handler);
      });

      await page.locator('.p-dialog-title').filter({ hasText: /Record your environment/i })
        .waitFor({ state: 'visible', timeout: 300000 });

      log(idx, username, '📡 Waiting for QR code URL...');
      let mobileUrl = await qrUrlPromise;

      try {
        const parsed = new URL(mobileUrl);
        const base   = new URL(BASE_URL);
        parsed.hostname = base.hostname;
        parsed.port     = base.port;
        mobileUrl = parsed.toString();
      } catch (_) {}

      log(idx, username, `📱 Opening mobile tab: ${mobileUrl}`);
      const mobilePage = await context.newPage();
      await mobilePage.goto(mobileUrl);

      if (RUN_ROOM_SCAN) {
        log(idx, username, '📱 Step 3.2: Starting room scan...');
        const startBtn = mobilePage.getByRole('button', { name: /start recording room/i });
        await startBtn.waitFor({ state: 'visible', timeout: 30000 });
        await startBtn.click();

        log(idx, username, '⏳ Step 3.2: Recording for 1 minute...');
        const uploadBtn = mobilePage.getByRole('button', { name: /^Upload$/i });
        await uploadBtn.waitFor({ state: 'visible', timeout: 75000 });
        await mobilePage.waitForTimeout(5000);
        await uploadBtn.click();
        await mobilePage.waitForTimeout(5000);
        log(idx, username, '✅ Step 3.2: Room scan uploaded.');
      } else if (RUN_MOBILE_RECORDING) {
        log(idx, username, '📱 Step 3.1: Mobile recording started (hold mode).');
      }

      log(idx, username, '💻 Step 3: Clicking desktop Next...');
      const next4 = page.getByRole('button', { name: 'Next' }).last();
      await next4.waitFor({ state: 'visible', timeout: 60000 });
      await next4.waitFor({ state: 'enabled', timeout: 60000 });
      await next4.click();
    }

    // ── Step 4: Equipment check ───────────────────────────────────────────────
    log(idx, username, '➡️ Step 4: Equipment check...');
    await page.locator('.p-dialog-title').filter({ hasText: /Equipment check/i })
      .waitFor({ state: 'visible', timeout: 300000 });

    log(idx, username, '🛑 Pausing 8s for WebRTC stabilisation...');
    await page.waitForTimeout(8000);

    const next5 = page.getByRole('button', { name: 'Next' }).last();
    const deadline = Date.now() + 120000;

    while (await next5.isDisabled()) {
      if (Date.now() > deadline) throw new Error('Equipment checks never passed within 2 minutes');
      const retryBtn = page.getByRole('button', { name: /retry/i }).first();
      if (await retryBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        log(idx, username, '🔄 Retrying failed equipment check...');
        await retryBtn.click();
        await page.waitForTimeout(6000);
      } else {
        await page.waitForTimeout(2000);
      }
    }

    await next5.click({ force: true });
    log(idx, username, '✅ Step 4: Equipment check passed.');

    // ── Hold on live exam page ────────────────────────────────────────────────
    log(idx, username, `🛑 Holding on exam page for ${WAITING_TIME / 60000} minute(s)...`);
    await page.waitForTimeout(WAITING_TIME);

    // Finish session
    const finishBtn = page.getByRole('button', { name: /Finish Session/i });
    if (await finishBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await finishBtn.click();
      await page.waitForTimeout(2000);
    }

    metrics.passed++;
    log(idx, username, '🎉 Session complete.');

  } catch (err) {
    metrics.failed++;
    metrics.errors.push({ idx, username, error: err.message });
    log(idx, username, `❌ ERROR: ${err.message}`);
  } finally {
    await browser.close();
  }
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  const results   = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(results);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(62));
  console.log('  Cloud Playwright Runner (Y4M Optimized - CommonJS)');
  console.log('═'.repeat(62));
  console.log(`  BASE_URL     : ${BASE_URL}`);
  console.log(`  API_BASE_URL : ${API_BASE_URL}`);
  console.log(`  TEMPLATE_ID  : ${TEMPLATE_ID}`);
  console.log(`  NUM_WORKERS  : ${NUM_WORKERS}`);
  console.log(`  CONCURRENCY  : ${CONCURRENCY}`);
  console.log(`  WAITING_TIME : ${WAITING_TIME / 60000} min`);
  console.log(`  STAGGER      : ${STAGGER_TIME / 1000}s per worker`);
  console.log(`  HEADED       : ${HEADED}`);
  console.log(`  Steps        : photo=${RUN_PHOTO_CAPTURE} id=${RUN_ID_VERIFICATION} mobile=${RUN_MOBILE_RECORDING} room=${RUN_ROOM_SCAN}`);
  console.log('═'.repeat(62));

  console.log(`\n📋 Creating ${NUM_WORKERS} user accounts...\n`);
  const users = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    try {
      users.push(await createUser(i));
    } catch (err) {
      console.error(`❌ Failed to create user ${i}: ${err.message}`);
      metrics.errors.push({ idx: i, username: `worker_${i}`, error: err.message });
    }
    if (i < NUM_WORKERS - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n✅ Created ${users.length}/${NUM_WORKERS} users. Launching browsers...\n`);

  const tasks = users.map(user => () => runWorker(user));
  await runWithConcurrency(tasks, CONCURRENCY);

  console.log('\n' + '═'.repeat(62));
  console.log('  Run Summary');
  console.log('═'.repeat(62));
  console.log(`  Users created   : ${metrics.created}`);
  console.log(`  Workers started : ${metrics.started}`);
  console.log(`  Passed          : ${metrics.passed}`);
  console.log(`  Failed          : ${metrics.failed}`);
  if (metrics.errors.length) {
    console.log('\n  Errors:');
    metrics.errors.forEach(e => console.log(`    Worker ${e.idx} (${e.username}): ${e.error}`));
  }
  console.log('═'.repeat(62));

  process.exit(metrics.failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });