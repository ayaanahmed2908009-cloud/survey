const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load settings (passwords etc.) from a .env file next to this script, if one exists.
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'responses.jsonl');
const SURVEY_PASSWORD = process.env.SURVEY_PASSWORD;
const MAP_PASSWORD = process.env.MAP_PASSWORD;
// Placeholder well location near Khairpur until the real coordinates are set.
const WELL_LAT = Number(process.env.WELL_LAT || 27.514);
const WELL_LNG = Number(process.env.WELL_LNG || 68.7905);

if (!SURVEY_PASSWORD || !MAP_PASSWORD) {
  console.error('Set SURVEY_PASSWORD and MAP_PASSWORD in a .env file or the environment before starting.');
  process.exit(1);
}
if (!Number.isFinite(WELL_LAT) || !Number.isFinite(WELL_LNG)) {
  console.error('WELL_LAT and WELL_LNG must be numbers.');
  process.exit(1);
}

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- storage: one JSON object per line ----------

function readAll() {
  if (!fs.existsSync(DB_FILE)) return [];
  return fs
    .readFileSync(DB_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function append(record) {
  fs.appendFileSync(DB_FILE, JSON.stringify(record) + '\n');
}

// ---------- copy to Google Sheet (optional, see apps-script/Code.gs) ----------
// Every saved survey is sent to the Apps Script. Households it has confirmed are listed in
// SYNCED_FILE. Households deleted on the map are queued in DELETE_QUEUE_FILE until the sheet
// confirms the row is gone. Anything unconfirmed is retried on the next change and every 10 minutes.

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const SHEETS_SECRET = process.env.SHEETS_SECRET;
const SYNCED_FILE = path.join(DATA_DIR, 'synced-to-sheet.txt');
const DELETE_QUEUE_FILE = path.join(DATA_DIR, 'sheet-deletes-pending.txt');
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' };
let syncRunning = false;
let syncAgain = false;

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
}

function syncedIds() {
  return new Set(readLines(SYNCED_FILE));
}

async function callSheet(payload) {
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SHEETS_SECRET, ...payload }),
  });
  const result = await res.json().catch(() => null);
  if (!result || !result.ok) throw new Error(result ? result.error : `HTTP ${res.status}`);
}

async function syncToSheet() {
  if (!SHEETS_WEBHOOK_URL || !SHEETS_SECRET) return;
  if (syncRunning) {
    syncAgain = true;
    return;
  }
  syncRunning = true;
  try {
    // Deletions first, so a household ID that is deleted and entered again ends up as one fresh row.
    for (const id of readLines(DELETE_QUEUE_FILE)) {
      try {
        await callSheet({ action: 'delete', household_id: id });
      } catch (err) {
        console.error(`Google Sheet delete failed for ${id}:`, err.message);
        return; // try again later
      }
      writeLines(DELETE_QUEUE_FILE, readLines(DELETE_QUEUE_FILE).filter((x) => x !== id));
    }

    const done = syncedIds();
    for (const record of readAll()) {
      if (done.has(record.household_id)) continue;
      const photoPath = path.join(PHOTO_DIR, record.photo);
      try {
        await callSheet({
          action: 'add',
          record,
          photo_base64: fs.existsSync(photoPath) ? fs.readFileSync(photoPath).toString('base64') : '',
          photo_type: PHOTO_TYPES[path.extname(record.photo)] || 'application/octet-stream',
        });
      } catch (err) {
        console.error(`Google Sheet copy failed for ${record.household_id}:`, err.message);
        return; // try again later
      }
      // Skip marking it copied if it was deleted on the map while it was being sent.
      if (readAll().some((r) => r.household_id === record.household_id)) {
        fs.appendFileSync(SYNCED_FILE, record.household_id + '\n');
      }
    }
  } catch (err) {
    console.error('Google Sheet sync failed:', err.message);
  } finally {
    syncRunning = false;
    if (syncAgain) {
      syncAgain = false;
      syncToSheet();
    }
  }
}

if (SHEETS_WEBHOOK_URL) {
  syncToSheet();
  setInterval(syncToSheet, 10 * 60 * 1000);
}

// ---------- password protection (HTTP Basic Auth, any username) ----------

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requirePassword(password, realm) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const given = decoded.slice(decoded.indexOf(':') + 1);
      if (sameSecret(given, password)) return next();
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    res.status(401).send('Password required.');
  };
}

const surveyAuth = requirePassword(SURVEY_PASSWORD, 'Project Paani Survey');
const mapAuth = requirePassword(MAP_PASSWORD, 'Project Paani Map');

// ---------- helpers ----------

function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:sans-serif;max-width:640px;margin:16px auto;padding:0 12px;color:#000;background:#fff">${body}</body></html>`;
}

const OPTIONS = {
  community: ['1 (WELL)', '2 (NO WELL)'],
  q2: ['Community well', 'Household well', 'Borehole or handpump', 'Piped water supply', 'Purchased water', 'Other'],
  q5: ['Adult woman', 'Adult man', 'Girl under 18', 'Boy under 18', 'Shared between household members', 'No collection trips required'],
  q6: ['0 days', '1-2 days', '3-7 days', '8-14 days', '15 or more days', "Don't know"],
  q7: ['0 Pakistani rupees', '1-100 Pakistani rupees', '101-250 Pakistani rupees', '251-500 Pakistani rupees', 'More than 500 Pakistani rupees', "Don't know / Prefer not to answer"],
  q9: ['Unusual thirst', 'Dry mouth', 'Dark yellow urine', 'Dizziness', 'Headaches', 'None of the above'],
};

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const trim = (v) => (typeof v === 'string' ? v.trim() : '');
const wholeNumber = (v) => /^\d+$/.test(trim(v));

function validate(b, file) {
  const errors = [];
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trim(b.survey_date))) errors.push('Survey date is required.');
  if (!trim(b.household_id)) errors.push('Household ID is required.');
  if (!OPTIONS.community.includes(b.community)) errors.push('Community is required.');
  if (!trim(b.lat) || !Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('Latitude is missing or invalid.');
  if (!trim(b.lng) || !Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('Longitude is missing or invalid.');
  if (!file) errors.push('Family photo is required.');
  if (!wholeNumber(b.q1)) errors.push('Q1: number of people is required.');
  if (!OPTIONS.q2.includes(b.q2)) errors.push('Q2: water source is required.');
  if (b.q2 === 'Other' && !trim(b.q2_other)) errors.push('Q2: describe the other water source.');
  if (!wholeNumber(b.q3_minutes) && !b.q3_other) errors.push('Q3: enter minutes or tick an option.');
  if (!wholeNumber(b.q4_trips) && !b.q4_at_home) errors.push('Q4: enter trips per week or tick the option.');
  if (!OPTIONS.q5.includes(b.q5)) errors.push('Q5 is required.');
  if (!OPTIONS.q6.includes(b.q6)) errors.push('Q6 is required.');
  if (!OPTIONS.q7.includes(b.q7)) errors.push('Q7 is required.');
  if (!wholeNumber(b.q8_people) && !b.q8_dont_know) errors.push('Q8: enter number of people or tick Don\'t know.');
  const q9 = asList(b.q9);
  if (q9.length === 0 || !q9.every((s) => OPTIONS.q9.includes(s))) errors.push('Q9: tick at least one option.');
  if (q9.includes('None of the above') && q9.length > 1) errors.push('Q9: "None of the above" cannot be combined with symptoms.');
  return errors;
}

// ---------- upload handling ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' }[file.mimetype] || '.img';
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// ---------- routes ----------

const app = express();
app.disable('x-powered-by');

app.get('/', (req, res) => res.redirect('/survey'));

// Survey (students)
app.get('/survey', surveyAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'survey.html')));

app.post('/survey', surveyAuth, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    const b = req.body || {};
    const errors = err ? ['Photo upload failed: ' + err.message] : validate(b, req.file);

    if (!errors.length) {
      const id = trim(b.household_id);
      if (readAll().some((r) => r.household_id.toLowerCase() === id.toLowerCase())) {
        errors.push(`Household ID "${id}" has already been submitted.`);
      }
    }

    if (errors.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res
        .status(400)
        .send(page('Not saved', `<h1>Not saved</h1><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul><p>Go back in your browser, fix the answers and submit again. The photo may need to be selected again.</p>`));
    }

    const q3 = asList(b.q3_other)[0] || '';
    const record = {
      household_id: trim(b.household_id),
      survey_date: trim(b.survey_date),
      community: b.community,
      lat: Number(b.lat),
      lng: Number(b.lng),
      gps_accuracy_m: trim(b.gps_accuracy) ? Number(b.gps_accuracy) : null,
      photo: req.file.filename,
      q1_household_size: Number(b.q1),
      q2_water_source: b.q2 === 'Other' ? 'Other: ' + trim(b.q2_other) : b.q2,
      q3_round_trip_minutes: wholeNumber(b.q3_minutes) ? Number(b.q3_minutes) : q3,
      q4_trips_per_week: wholeNumber(b.q4_trips) ? Number(b.q4_trips) : 'Water is delivered or available at home',
      q5_who_collects: b.q5,
      q6_days_not_enough_water: b.q6,
      q7_willing_to_pay: b.q7,
      q8_people_with_diarrhoea: wholeNumber(b.q8_people) ? Number(b.q8_people) : "Don't know",
      q9_symptoms: asList(b.q9),
      submitted_at: new Date().toISOString(),
    };
    append(record);
    syncToSheet();
    res.send(page('Saved', `<h1>Saved</h1><p>Household ${esc(record.household_id)} has been recorded.</p><p><a href="/survey">Enter another household</a></p>`));
  });
});

// Map (project team)
app.get('/map', mapAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'map.html')));

app.get('/map/data.json', mapAuth, (req, res) => {
  const households = readAll().map((r) => ({ ...r, distance_to_well_m: distanceMetres(r.lat, r.lng, WELL_LAT, WELL_LNG) }));
  const synced = syncedIds();
  const sheet = SHEETS_WEBHOOK_URL
    ? { waiting: households.filter((h) => !synced.has(h.household_id)).length, deletesWaiting: readLines(DELETE_QUEUE_FILE).length }
    : null;
  res.json({ well: { lat: WELL_LAT, lng: WELL_LNG }, households, sheet });
});

// Delete a household. The record is moved to deleted.jsonl (its photo is kept) so a mistake can
// be recovered by hand, and its row is removed from the Google Sheet.
app.post('/map/delete', mapAuth, express.json(), (req, res) => {
  // Custom header: browsers will not send it from another website, which blocks forged requests.
  if (req.get('X-Project-Paani') !== 'delete') return res.status(403).json({ ok: false, error: 'Forbidden' });
  const id = req.body && typeof req.body.household_id === 'string' ? req.body.household_id : '';
  const all = readAll();
  const victim = all.find((r) => r.household_id === id);
  if (!victim) return res.status(404).json({ ok: false, error: 'Household not found' });

  fs.appendFileSync(path.join(DATA_DIR, 'deleted.jsonl'), JSON.stringify({ ...victim, deleted_at: new Date().toISOString() }) + '\n');
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, all.filter((r) => r !== victim).map((r) => JSON.stringify(r) + '\n').join(''));
  fs.renameSync(tmp, DB_FILE);

  writeLines(SYNCED_FILE, readLines(SYNCED_FILE).filter((x) => x !== id));
  if (SHEETS_WEBHOOK_URL) {
    if (!readLines(DELETE_QUEUE_FILE).includes(id)) fs.appendFileSync(DELETE_QUEUE_FILE, id + '\n');
    syncToSheet();
  }
  res.json({ ok: true });
});

app.get('/map/photos/:file', mapAuth, (req, res) => {
  const file = path.basename(req.params.file);
  res.sendFile(path.join(PHOTO_DIR, file), (err) => err && res.status(404).end());
});

app.get('/map/export.csv', mapAuth, (req, res) => {
  const rows = readAll().map((r) => ({ ...r, distance_to_well_m: distanceMetres(r.lat, r.lng, WELL_LAT, WELL_LNG), q9_symptoms: r.q9_symptoms.join('; ') }));
  const cols = ['household_id', 'survey_date', 'community', 'lat', 'lng', 'gps_accuracy_m', 'distance_to_well_m', 'q1_household_size', 'q2_water_source', 'q3_round_trip_minutes', 'q4_trips_per_week', 'q5_who_collects', 'q6_days_not_enough_water', 'q7_willing_to_pay', 'q8_people_with_diarrhoea', 'q9_symptoms', 'photo', 'submitted_at'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="project-paani-survey.csv"');
  res.send('﻿' + csv);
});

app.listen(PORT, () => console.log(`Project Paani running on port ${PORT}`));
