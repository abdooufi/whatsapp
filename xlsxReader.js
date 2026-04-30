// xlsxReader.js — supports file path OR Buffer
const XLSX = require('xlsx');
const path = require('path');

/**
 * Reads phone numbers (and optional names/messages) from an Excel file.
 *
 * Expected columns in the sheet:
 *   - phone   (required) : phone number with country code, e.g. 96812345678
 *   - name    (optional) : contact name
 *   - message (optional) : per-contact custom message (overrides global message)
 *
 * The first row is treated as the header row.
 */
function readPhoneNumbers(filePath, buffer) {
  let workbook;
  try {
    if (buffer) {
      workbook = XLSX.read(buffer, { type: 'buffer' });
    } else {
      workbook = XLSX.readFile(path.resolve(filePath));
    }
  } catch (err) {
    console.error('❌ Could not read Excel file:', err.message);
    return [];
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rows.length === 0) {
    console.warn('⚠️  The spreadsheet is empty.');
    return [];
  }

  // Normalise header keys to lowercase
  const contacts = rows
    .map((row, idx) => {
      const normalised = {};
      for (const [key, value] of Object.entries(row)) {
        normalised[key.toLowerCase().trim()] = String(value).trim();
      }

      const phone = normalised['phone'] || normalised['number'] || normalised['mobile'] || normalised['tel'] || '';
      const name = normalised['name'] || normalised['contact'] || `Row ${idx + 2}`;
      const customMsg = normalised['message'] || normalised['msg'] || '';

      if (!phone) {
        console.warn(`⚠️  Row ${idx + 2}: No phone number found — skipping.`);
        return null;
      }

      // Strip non-digit characters except leading +
      const cleaned = phone.replace(/[^\d+]/g, '');
      if (cleaned.length < 7) {
        console.warn(`⚠️  Row ${idx + 2}: "${phone}" doesn't look like a valid number — skipping.`);
        return null;
      }

      return { phone: cleaned, name, customMessage: customMsg };
    })
    .filter(Boolean);

  return contacts;
}

module.exports = { readPhoneNumbers };
