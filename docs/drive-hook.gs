/**
 * Video Challenge BE – Drive hook (Google Apps Script, web app)
 * ------------------------------------------------------------
 * Gira come cnogara25@gmail.com. Ogni volta che un arbitro invia il modulo,
 * l'app (index.html, funzione saveReportToDrive) manda qui un POST JSON con
 * il link firmato del PDF appena creato da `send-report`; lo script scarica il
 * PDF e lo salva in Drive dentro:
 *   Challenge Video VB / <NOME ARBITRO> / "<data> - <squadra di casa> - <NOME ARBITRO>.pdf"
 * creando la sottocartella dell'arbitro se non esiste ancora.
 *
 * Funzioni da eseguire a mano una sola volta dall'editor (menu "Esegui"):
 *   createRefereeFolders()     crea le sottocartelle per tutti gli arbitri attivi (vcbe_referees)
 *   migrateFromLegacyFolder()  copia i PDF già archiviati il 17/10/2026 nella cartella
 *                              "Challenge Video VB - Rapporti arbitri (PDF)" del Drive di srlchrisa
 * Distribuzione: Deploy > Nuova distribuzione > App web > Esegui come: Me,
 * Chi ha accesso: Chiunque. L'URL /exec va copiato in index.html (DRIVE_HOOK_URL).
 * Dopo ogni modifica al codice: Gestisci distribuzioni > matita > Nuova versione.
 */

var ROOT_FOLDER_ID = '1RoziJRp4tE7SAlnnQ04AXq_x3uCGp_pe';    // Challenge Video VB (proprietario cnogara25)
var LEGACY_FOLDER_ID = '1G2_u-l-rwLchNfhDZpMu9Z-5Jr-CS3Ao';  // archivio del 17/10/2026 (Drive srlchrisa, condiviso con cnogara25)
var SB_URL = 'https://apbusqbeneppepfkvklv.supabase.co';
var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwYnVzcWJlbmVwcGVwZmt2a2x2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNDI5MTcsImV4cCI6MjA5NDkxODkxN30.fRXGuqOrFIY0OAX7ZX2moe6RzG807vLM490FU1JTNnU';
var ALLOWED_PDF_PREFIX = SB_URL + '/storage/v1/object/sign/vcbe-reports/';

/* ---------- Web app ---------- */

function doGet(e) {
  return jsonOut({ ok: true, service: 'vcbe-drive-hook', root: ROOT_FOLDER_ID });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return jsonOut(saveReport(data));
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ---------- Logica principale ---------- */

function saveReport(d) {
  var pdfUrl = String(d.pdf_url || '');
  if (pdfUrl.indexOf(ALLOWED_PDF_PREFIX) !== 0) return { ok: false, error: 'pdf_url not allowed' };
  var referee = normalizeName(d.referee_name);
  if (!referee) return { ok: false, error: 'referee_name missing' };

  // Chiave univoca del rapporto = percorso del file nel bucket (senza token).
  var key = decodeURIComponent(pdfUrl.substring(ALLOWED_PDF_PREFIX.length).split('?')[0]);
  var folder = getRefereeFolder(referee);

  var dup = findFileByDescription(folder, key);
  if (dup) return { ok: true, duplicate: true, file_id: dup.getId(), folder: folder.getName() };

  var res = UrlFetchApp.fetch(pdfUrl, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'download failed ' + res.getResponseCode() };
  var bytes = res.getContent();
  if (bytes.length < 5 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') {
    return { ok: false, error: 'not a pdf' };
  }

  var date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.match_date || '')) ? d.match_date
           : Utilities.formatDate(new Date(), 'Europe/Brussels', 'yyyy-MM-dd');
  var base = sanitize(date + ' - ' + (d.host_team || 'match') + ' - ' + referee);
  var name = uniqueName(folder, base, '.pdf');

  var blob = Utilities.newBlob(bytes, 'application/pdf', name);
  var file = folder.createFile(blob);
  file.setDescription(key);
  return { ok: true, file_id: file.getId(), name: name, folder: folder.getName() };
}

/* ---------- Manutenzione (da eseguire a mano) ---------- */

function createRefereeFolders() {
  var res = UrlFetchApp.fetch(SB_URL + '/rest/v1/vcbe_referees?select=name&active=eq.true&order=sort_order',
    { headers: { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('vcbe_referees ' + res.getResponseCode() + ': ' + res.getContentText());
  var created = [];
  JSON.parse(res.getContentText()).forEach(function (r) {
    var n = normalizeName(r.name);
    if (!n) return;
    if (!findSubfolder(DriveApp.getFolderById(ROOT_FOLDER_ID), n)) { getRefereeFolder(n); created.push(n); }
  });
  Logger.log('Sottocartelle create: ' + (created.length ? created.join(', ') : 'nessuna (già tutte presenti)'));
}

function migrateFromLegacyFolder() {
  var legacy = DriveApp.getFolderById(LEGACY_FOLDER_ID);
  var subs = legacy.getFolders(), copied = 0, skipped = 0;
  while (subs.hasNext()) {
    var src = subs.next();
    var referee = normalizeName(src.getName());
    var dest = getRefereeFolder(referee);
    var files = src.getFilesByType(MimeType.PDF);
    while (files.hasNext()) {
      var f = files.next();
      if (dest.getFilesByName(f.getName()).hasNext() || findFileByDescription(dest, 'legacy:' + f.getId())) { skipped++; continue; }
      f.makeCopy(f.getName(), dest).setDescription('legacy:' + f.getId());
      copied++;
    }
  }
  Logger.log('Migrazione: copiati ' + copied + ', saltati (già presenti) ' + skipped);
}

/* ---------- Utilità ---------- */

function normalizeName(s) { return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase(); }

function sanitize(s) { return String(s).replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim(); }

function findSubfolder(parent, name) {
  var it = parent.getFolders(), want = normalizeName(name);
  while (it.hasNext()) { var f = it.next(); if (normalizeName(f.getName()) === want) return f; }
  return null;
}

function getRefereeFolder(referee) {
  var root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  return findSubfolder(root, referee) || root.createFolder(referee);
}

function findFileByDescription(folder, key) {
  var it = folder.getFiles();
  while (it.hasNext()) { var f = it.next(); if (f.getDescription() === key) return f; }
  return null;
}

function uniqueName(folder, base, ext) {
  var name = base + ext, n = 2;
  while (folder.getFilesByName(name).hasNext()) { name = base + ' (' + n + ')' + ext; n++; }
  return name;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
