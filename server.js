const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const http       = require('http');
const fs         = require('fs');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode     = require('qrcode');
const { readPhoneNumbers } = require('./xlsxReader');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('📁 App directory  :', __dirname);
console.log('🌐 Static from    :', path.join(__dirname, 'public'));

// ── Paths — use absolute paths so PM2 never gets confused ────────────────────
const APP_DIR     = __dirname;
const SESSION_DIR = path.join(APP_DIR, '.wwebjs_auth');
const CACHE_DIR   = path.join(APP_DIR, '.wwebjs_cache');
const LOGS_DIR    = path.join(APP_DIR, 'logs');

// Make sure logs folder exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Anti-ban randomised timing ────────────────────────────────────────────────
const MSG_DELAY   = { min: 8000,      max: 20000     }; // 8s–20s between messages
const BATCH_SIZE  = { min: 30,        max: 70        }; // 30–70 messages per batch
const BATCH_PAUSE = { min: 4 * 60000, max: 8 * 60000 }; // 4–8 min between batches
const MAX_RETRIES    = 2;
const RETRY_DELAY_MS = 6000;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toChatId(phone) {
  return phone.replace(/[^\d]/g, '') + '@c.us';
}

function deleteSession() {
  [SESSION_DIR, CACHE_DIR].forEach((dir) => {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('🗑  Deleted:', dir);
      }
    } catch (e) {
      console.warn('Could not delete', dir, ':', e.message);
    }
  });
}

async function sendOne(chatId, message, mediaBuffer, mediaMime, mediaName) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      if (mediaBuffer) {
        const b64    = mediaBuffer.toString('base64');
        const media  = new MessageMedia(mediaMime, b64, mediaName);
        const isPdf  = mediaMime === 'application/pdf';
        if (isPdf) {
          if (message) await client.sendMessage(chatId, message);
          await client.sendMessage(chatId, media, { sendMediaAsDocument: true });
        } else {
          await client.sendMessage(chatId, media, { caption: message });
        }
      } else {
        await client.sendMessage(chatId, message);
      }
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES + 1) throw err;
      console.warn(`  ⚠️  Attempt ${attempt} failed: ${err.message}. Retrying...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// ── WhatsApp client factory ───────────────────────────────────────────────────
let client;
let waReady = false;
let waQr    = null;

function createClient() {
  console.log('🔧 Creating WhatsApp client...');
  console.log('💾 Session path:', SESSION_DIR);

  const c = new Client({
    authStrategy: new LocalAuth({
      clientId: 'wa-sender',
      dataPath:  SESSION_DIR,   // absolute path — safe with PM2
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',     // prevents crashes on low-memory servers
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });

  c.on('qr', async (qr) => {
    console.log('📱 QR code ready — waiting for scan...');
    waQr = await qrcode.toDataURL(qr);
    io.emit('qr', waQr);
    io.emit('status', { state: 'qr', message: 'Scan QR code with WhatsApp' });
  });

  c.on('authenticated', () => {
    waQr = null;
    console.log('🔐 Authenticated successfully');
    io.emit('status', { state: 'authenticated', message: 'Authenticated — loading...' });
  });

  c.on('ready', () => {
    waReady = true;
    waQr    = null;
    console.log('✅ WhatsApp client ready');
    io.emit('qr_clear');
    io.emit('status', { state: 'ready', message: 'WhatsApp connected ✓' });
  });

  c.on('auth_failure', (msg) => {
    waReady = false;
    console.error('❌ Auth failure:', msg);
    // Delete bad session so next restart shows fresh QR
    deleteSession();
    io.emit('status', { state: 'error', message: 'Auth failed — restart server to scan QR again.' });
  });

  c.on('disconnected', (reason) => {
    waReady = false;
    console.log('🔌 Disconnected:', reason);
    io.emit('status', { state: 'disconnected', message: 'Disconnected. Reconnecting...' });

    // Auto reconnect after 5 seconds
    setTimeout(() => {
      console.log('🔄 Auto-reconnecting...');
      try {
        client = createClient();
        client.initialize();
      } catch (e) {
        console.error('Auto-reconnect failed:', e.message);
      }
    }, 5000);
  });

  return c;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
client = createClient();
client.initialize();

// ── API: status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ready: waReady, qr: waQr });
});

// ── API: single send ──────────────────────────────────────────────────────────
app.post('/api/send-single', upload.single('image'), async (req, res) => {
  if (!waReady) return res.status(503).json({ ok: false, error: 'WhatsApp not ready yet.' });

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'phone and message are required.' });

  const chatId = toChatId(phone);
  try {
    const registered = await client.isRegisteredUser(chatId).catch(() => true);
    if (!registered) return res.status(400).json({ ok: false, error: 'Number not registered on WhatsApp.' });

    await sendOne(
      chatId, message,
      req.file?.buffer       || null,
      req.file?.mimetype     || null,
      req.file?.originalname || null
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('send-single error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── API: bulk send (SSE) ──────────────────────────────────────────────────────
app.post(
  '/api/send-bulk',
  upload.fields([{ name: 'xlsx', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  async (req, res) => {
    if (!waReady) return res.status(503).json({ ok: false, error: 'WhatsApp not ready yet.' });

    const xlsxFile = req.files?.xlsx?.[0];
    if (!xlsxFile) return res.status(400).json({ ok: false, error: 'Excel file is required.' });

    const globalMessage = (req.body.message || '').trim();
    const imageFile     = req.files?.image?.[0] || null;

    const contacts = readPhoneNumbers(null, xlsxFile.buffer);
    if (!contacts.length) return res.status(400).json({ ok: false, error: 'No valid contacts found in the file.' });

    // Server-Sent Events
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    emit({ type: 'total', total: contacts.length });
    console.log(`\n📤 Bulk send started — ${contacts.length} contacts`);

    let success = 0;
    let failed  = 0;

    for (let i = 0; i < contacts.length; i++) {
      const { phone, name, customMessage } = contacts[i];
      const chatId = toChatId(phone);
      const text   = customMessage || globalMessage;

      // Batch pause
      const batchSize = rand(BATCH_SIZE.min, BATCH_SIZE.max);
      if (i > 0 && i % batchSize === 0) {
        const batchPause = rand(BATCH_PAUSE.min, BATCH_PAUSE.max);
        console.log(`⏸  Batch pause — waiting ${Math.round(batchPause / 60000)}m ${Math.round((batchPause % 60000) / 1000)}s...`);
        emit({ type: 'batch_pause', index: i, pause_ms: batchPause });
        await sleep(batchPause);
        emit({ type: 'batch_resume', index: i });
      }

      if (!text) {
        failed++;
        emit({ type: 'result', index: i, phone, name, ok: false, error: 'No message text' });
        continue;
      }

      try {
        const registered = await client.isRegisteredUser(chatId).catch(() => true);
        if (registered === false) throw new Error('Not registered on WhatsApp');

        await sendOne(
          chatId, text,
          imageFile?.buffer       || null,
          imageFile?.mimetype     || null,
          imageFile?.originalname || null
        );

        success++;
        console.log(`  ✅ [${i + 1}/${contacts.length}] ${name} (${phone})`);
        emit({ type: 'result', index: i, phone, name, ok: true });
      } catch (err) {
        failed++;
        console.log(`  ❌ [${i + 1}/${contacts.length}] ${name} (${phone}): ${err.message}`);
        emit({ type: 'result', index: i, phone, name, ok: false, error: err.message });
      }

      if (i < contacts.length - 1) {
        await sleep(rand(MSG_DELAY.min, MSG_DELAY.max));
      }
    }

    console.log(`\n📊 Done — ✅ ${success} sent, ❌ ${failed} failed\n`);
    emit({ type: 'done', success, failed });
    res.end();
  }
);

// ── API: logout — destroys session + forces fresh QR on reconnect ─────────────
app.post('/api/logout', async (req, res) => {
  console.log('👋 Logout requested...');

  // 1. Mark not ready immediately
  waReady = false;
  waQr    = null;

  // 2. Gracefully stop the client
  try { await client.logout();  } catch (_) {}
  try { await client.destroy(); } catch (_) {}

  // 3. Wipe ALL session & cache files (.wwebjs_auth + .wwebjs_cache)
  deleteSession();

  // 4. Notify all browser tabs
  io.emit('status', { state: 'logged_out', message: 'Logged out — scan QR to reconnect' });
  console.log('✅ Session wiped — waiting for new QR scan');

  res.json({ ok: true });

  // 5. Reinitialise client after a short delay so fresh QR appears in browser
  setTimeout(() => {
    try {
      client = createClient();
      client.initialize();
      console.log('🔄 New client initializing...');
    } catch (e) {
      console.error('Reinit failed:', e.message);
    }
  }, 3000);
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  if (waQr) socket.emit('qr', waQr);
  socket.emit('status', {
    state:   waReady ? 'ready'   : 'loading',
    message: waReady ? 'WhatsApp connected ✓' : 'Connecting to WhatsApp...',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.\nRun: kill -9 $(lsof -ti :${PORT})\n`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server running → http://localhost:${PORT}\n`);
});
