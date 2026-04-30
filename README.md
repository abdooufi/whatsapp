# 📱 WhatsApp XLSX Sender

Send WhatsApp messages to a list of phone numbers read from an Excel (.xlsx) file using [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).

---

## 📁 Project Structure

```
whatsapp-xlsx-sender/
├── index.js              # Entry point — initialises WA client
├── xlsxReader.js         # Reads & validates contacts from Excel
├── messageSender.js      # Sends messages with retry & rate-limiting
├── createSampleXlsx.js   # Helper to generate a sample contacts.xlsx
├── package.json
└── README.md
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

> **Note:** `whatsapp-web.js` uses Puppeteer, which downloads Chromium automatically.
> On Linux servers you may need:
> ```bash
> sudo apt-get install -y chromium-browser
> ```

### 2. Prepare your Excel file

The file must have a header row. Supported column names (case-insensitive):

| Column     | Required | Description                                        |
|------------|----------|----------------------------------------------------|
| `phone`    | ✅        | Phone number with country code (e.g. `96812345678`) |
| `name`     | ❌        | Contact name (for logging)                         |
| `message`  | ❌        | Per-contact custom message (overrides global)      |

Generate a sample file:
```bash
node createSampleXlsx.js
```

### 3. Run

```bash
# Basic usage — uses contacts.xlsx and a default message
node index.js

# Custom file and message
node index.js contacts.xlsx "Hello, this is a reminder about your appointment!"

# npm shortcut
npm run send
```

### 4. Scan the QR code

On first run a QR code is printed in the terminal. Open WhatsApp on your phone → **Linked Devices** → **Link a Device** and scan it.

Your session is saved locally in `.wwebjs_auth/` so you only need to scan once.

---

## ⚙️ Configuration

Edit the constants at the top of `messageSender.js`:

| Constant        | Default | Description                          |
|-----------------|---------|--------------------------------------|
| `DELAY_MS`      | 3000    | Milliseconds between messages        |
| `RETRY_DELAY_MS`| 5000    | Milliseconds before retrying a fail  |
| `MAX_RETRIES`   | 2       | How many times to retry a failed send|

---

## 📊 Features

- ✅ Reads phone numbers from `.xlsx`
- ✅ Supports per-contact custom messages
- ✅ Checks if number is registered on WhatsApp before sending
- ✅ Rate-limited sending to avoid spam detection
- ✅ Automatic retry on failure
- ✅ Session persistence (scan QR only once)
- ✅ Summary report after all sends

---

## ⚠️ Disclaimer

This tool uses an unofficial WhatsApp API. Use responsibly and in compliance with WhatsApp's Terms of Service. Sending bulk unsolicited messages may result in your number being banned.
