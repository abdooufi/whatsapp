/**
 * Run this once to generate a sample contacts.xlsx file.
 * Usage: node createSampleXlsx.js
 */

const XLSX = require('xlsx');

const data = [
  { phone: '96898216618', name: 'Alice',   message: '' },
  { phone: '96898216618', name: 'Bob',     message: 'Hey Bob, special message just for you!' },
  { phone: '96898216618', name: 'Charlie', message: '' },
];

const worksheet = XLSX.utils.json_to_sheet(data);
const workbook  = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'Contacts');

XLSX.writeFile(workbook, 'contacts.xlsx');
console.log('✅ contacts.xlsx created successfully!');
