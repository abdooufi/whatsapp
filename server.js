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

console.log('Serving static from:', path.join(__dirname, 'public'));

// ── Anti-ban settings ─────────────────────────────────────────────────────────
const MSG_DELAY_MS   = 10000;
const BATCH_SIZE     = 50;
const BATCH_PAUSE_MS = 5 * 60 * 1000;
const MAX_RETRIES    = 2;
const RETRY_DELAY_MS = 6000;
const SESSION_DIR    = path.join(__dirname, '.wwebjs_auth');

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
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log('🗑  Session files deleted');
    }
  } catch (e) {
    console.warn('Could not delete session files:', e.message);
  }
}

async function sendOne(chatId, message, mediaBuffer, mediaMime, mediaName) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      if (mediaBuffer) {
        const b64   = mediaBuffer.toString('base64');
        const media = new MessageMedia(mediaMime, b64, mediaName);
        await client.sendMessage(chatId, media, { caption: message });
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
// We use a factory so we can re-create the client after logout
let client;
let waReady = false;
let waQr    = null;

function createClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ clientId: 'wa-sender', dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  c.on('qr', async (qr) => {
    waQr = await qrcode.toDataURL(qr);
    io.emit('qr', waQr);
    io.emit('status', { state: 'qr', message: 'Scan QR code with WhatsApp' });
    console.log('📱 QR code generated — waiting for scan...');
  });

  c.on('authenticated', () => {
    waQr = null;
    io.emit('status', { state: 'authenticated', message: 'Authenticated — loading...' });
    console.log('🔐 Authenticated');
  });

  c.on('ready', () => {
    waReady = true;
    waQr    = null;
    console.log('✅ WhatsApp client ready');
    io.emit('qr_clear');
    io.emit('status', { state: 'ready', message: 'WhatsApp connected ✓' });
  });

  c.on('auth_failure', () => {
    waReady = false;
    console.error('❌ Auth failure');
    io.emit('status', { state: 'error', message: 'Authentication failed. Restart server.' });
  });

  c.on('disconnected', (reason) => {
    waReady = false;
    console.log('🔌 Disconnected:', reason);
    io.emit('status', { state: 'disconnected', message: 'Disconnected.' });
  });

  return c;
}

// Boot the client on startup
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

      // Batch pause every BATCH_SIZE messages
      if (i > 0 && i % BATCH_SIZE === 0) {
        const pauseMin = Math.round(BATCH_PAUSE_MS / 60000);
        console.log(`⏸  Batch pause after ${i} messages — waiting ${pauseMin} min...`);
        emit({ type: 'batch_pause', index: i, pause_ms: BATCH_PAUSE_MS });
        await sleep(BATCH_PAUSE_MS);
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

      // Delay with random jitter ±2s to look human
      if (i < contacts.length - 1) {
        const jitter = Math.floor(Math.random() * 4000) - 2000;
        await sleep(MSG_DELAY_MS + jitter);
      }
    }

    console.log(`\n📊 Done — ✅ ${success} sent, ❌ ${failed} failed\n`);
    emit({ type: 'done', success, failed });
    res.end();
  }
);

// ── API: logout ───────────────────────────────────────────────────────────────
app.post('/api/logout', async (req, res) => {
  // 1. Mark as not ready immediately
  waReady = false;
  waQr    = null;

  // 2. Gracefully logout / destroy current client
  try { await client.logout();  } catch (_) {}
  try { await client.destroy(); } catch (_) {}

  // 3. Delete saved session files so QR is always required on next connect
  deleteSession();

  // 4. Tell all browser tabs: logged out, show QR screen
  io.emit('status', { state: 'logged_out', message: 'Logged out — scan QR to reconnect' });
  console.log('👋 Logged out — session cleared');

  // 5. Re-create and re-initialize client so QR appears immediately
  //    without needing a server restart
  setTimeout(() => {
    try {
      client = createClient();
      client.initialize();
      console.log('🔄 New WhatsApp client initializing...');
    } catch (e) {
      console.error('Failed to reinitialize client:', e.message);
    }
  }, 2000); // 2s delay to let destroy() finish cleanly

  res.json({ ok: true });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Send current state to newly connected browser tab
  if (waQr) {
    socket.emit('qr', waQr);
  }
  socket.emit('status', {
    state:   waReady ? 'ready' : 'loading',
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
