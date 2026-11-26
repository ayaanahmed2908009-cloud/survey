// Project Paani: receives each survey from the website and copies it into the Google Sheet.
// Setup steps are in README.md ("Copying surveys to Google Sheets").

const SHEET_ID = '1NifjC0rM7BjT6hFsF-9srjgdcRE70ay4hVMXaFdE-sI';
const PHOTO_FOLDER_ID = '1v_QutzkIGpn7LwVasyZk9FNBOzsYZ5lo';
const SECRET = 'PASTE-SHEETS_SECRET-HERE'; // must match SHEETS_SECRET on Railway

const COLUMNS = [
  'household_id', 'survey_date', 'community', 'lat', 'lng', 'gps_accuracy_m',
  'q1_household_size', 'q2_water_source', 'q3_round_trip_minutes', 'q4_trips_per_week',
  'q5_who_collects', 'q6_days_not_enough_water', 'q7_willing_to_pay',
  'q8_people_with_diarrhoea', 'q9_symptoms', 'photo', 'photo_link', 'submitted_at',
];

// Stored as plain text so Sheets does not turn them into numbers or dates.
const TEXT_COLUMNS = ['household_id', 'survey_date', 'community', 'q6_days_not_enough_water', 'q7_willing_to_pay', 'photo', 'submitted_at'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return reply({ ok: false, error: 'wrong secret' });
    const r = body.record;
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];

    // Skip households already in the sheet, so re-sending never creates duplicates.
    const last = sheet.getLastRow();
    if (last > 1) {
      const ids = sheet.getRange(2, 1, last - 1, 1).getDisplayValues().map((row) => row[0]);
      if (ids.indexOf(String(r.household_id)) !== -1) return reply({ ok: true, duplicate: true });
    }

    let photoLink = '';
    if (body.photo_base64) {
      const blob = Utilities.newBlob(Utilities.base64Decode(body.photo_base64), body.photo_type, r.household_id + ' - ' + r.photo);
      photoLink = DriveApp.getFolderById(PHOTO_FOLDER_ID).createFile(blob).getUrl();
    }

    const row = COLUMNS.map((c) => {
      if (c === 'photo_link') return photoLink;
      if (c === 'q9_symptoms') return (r.q9_symptoms || []).join('; ');
      return r[c] === null || r[c] === undefined ? '' : r[c];
    });

    const rowIndex = last + 1;
    TEXT_COLUMNS.forEach((c) => sheet.getRange(rowIndex, COLUMNS.indexOf(c) + 1).setNumberFormat('@'));
    sheet.getRange(rowIndex, 1, 1, COLUMNS.length).setValues([row]);
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
