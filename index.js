const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { readPhoneNumbers } = require('./xlsxReader');
const { sendMessages } = require('./messageSender');

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'whatsapp-xlsx-sender' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
  process.exit(1);
});

client.on('ready', async () => {
  console.log('🚀 WhatsApp client is ready!\n');

  const xlsxFile = process.argv[2] || 'contacts.xlsx';
  const message = process.argv[3] || 'Hello! This is an automated message.';

  console.log(`📂 Reading contacts from: ${xlsxFile}`);
  console.log(`💬 Message to send: "${message}"\n`);

  const contacts = readPhoneNumbers(xlsxFile);

  if (!contacts || contacts.length === 0) {
    console.error('❌ No contacts found in the Excel file.');
    process.exit(1);
  }

  console.log(`📋 Found ${contacts.length} contact(s).\n`);
  await sendMessages(client, contacts, message);

  console.log('\n✅ All messages processed. Closing...');
  await client.destroy();
  process.exit(0);
});

client.on('disconnected', (reason) => {
  console.log('🔌 Client disconnected:', reason);
});

console.log('🔄 Initializing WhatsApp client...');
client.initialize();
