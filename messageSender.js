/**
 * Sends WhatsApp messages to a list of contacts with rate-limiting and retry logic.
 */

const DELAY_MS = 3000;      // 3 seconds between messages (avoids spam detection)
const RETRY_DELAY_MS = 5000; // 5 seconds before retrying a failed send
const MAX_RETRIES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formats a phone number into the WhatsApp chat ID format.
 * Removes leading '+' and appends '@c.us'.
 * @param {string} phone
 * @returns {string}
 */
function toChatId(phone) {
  return phone.replace(/^\+/, '') + '@c.us';
}

/**
 * Attempts to send a single message, retrying on failure.
 */
async function sendWithRetry(client, chatId, text, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await client.sendMessage(chatId, text);
      return true;
    } catch (err) {
      const isLast = attempt === retries + 1;
      if (isLast) {
        throw err;
      }
      console.warn(`   ⚠️  Attempt ${attempt} failed: ${err.message}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Sends messages to all contacts in the list.
 * @param {import('whatsapp-web.js').Client} client
 * @param {Array<{phone: string, name: string, customMessage: string}>} contacts
 * @param {string} globalMessage  - fallback message when contact has no custom message
 */
async function sendMessages(client, contacts, globalMessage) {
  const results = { success: [], failed: [] };

  for (let i = 0; i < contacts.length; i++) {
    const { phone, name, customMessage } = contacts[i];
    const chatId = toChatId(phone);
    const text = customMessage || globalMessage;

    process.stdout.write(`[${i + 1}/${contacts.length}] 📤 Sending to ${name} (${phone})... `);

    try {
      // Check if number exists on WhatsApp
      const isRegistered = await client.isRegisteredUser(chatId).catch(() => null);
      if (isRegistered === false) {
        console.log('⚠️  Not on WhatsApp — skipped.');
        results.failed.push({ phone, name, reason: 'Not registered on WhatsApp' });
      } else {
        await sendWithRetry(client, chatId, text);
        console.log('✅ Sent!');
        results.success.push({ phone, name });
      }
    } catch (err) {
      console.log(`❌ Failed: ${err.message}`);
      results.failed.push({ phone, name, reason: err.message });
    }

    // Delay between messages (skip after last one)
    if (i < contacts.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Summary
  console.log('\n─────────────────────────────────────');
  console.log(`📊 Summary:`);
  console.log(`   ✅ Sent:   ${results.success.length}`);
  console.log(`   ❌ Failed: ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log('\n   Failed contacts:');
    results.failed.forEach(({ phone, name, reason }) => {
      console.log(`   • ${name} (${phone}): ${reason}`);
    });
  }

  return results;
}

module.exports = { sendMessages };
