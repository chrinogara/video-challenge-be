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
 * Seconda funzione (dal 17/10/2026): azione "reminder". Il controllo settimanale del lunedì
 * manda qui i dati dell'arbitro senza modulo e lo script invia il promemoria in inglese
 * DALL'INDIRIZZO cnogara25@gmail.com, con il pulsante verso l'app. Richiede il segreto
 * condiviso salvato nelle Proprietà dello script (Impostazioni progetto > Proprietà dello
 * script): chiave REMINDER_SECRET. Il valore sta nel prompt della routine, non nel repo.
 *
 * Funzioni da eseguire a mano dall'editor (menu "Esegui"):
 *   createRefereeFolders()     crea le sottocartelle per tutti gli arbitri attivi (vcbe_referees)
 *   migrateFromLegacyFolder()  copia i PDF già archiviati il 17/10/2026 nella cartella
 *                              "Challenge Video VB - Rapporti arbitri (PDF)" del Drive di srlchrisa
 *   sendTestReminder()         manda a cnogara25 un promemoria di prova [TEST] (serve anche per
 *                              autorizzare l'invio email la prima volta)
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
    return jsonOut(data.action === 'reminder' ? sendReminder(data) : saveReport(data));
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

/* ---------- Promemoria agli arbitri (inviato da cnogara25@gmail.com) ---------- */

var APP_URL = 'https://video-challenge-be.vercel.app/';
var APP_HOST = 'video-challenge-be.vercel.app';

/**
 * Payload atteso (POST JSON):
 * { action:'reminder', secret:'…', to:'arbitro@…', referee_name:'Nome Cognome',
 *   week_start:'YYYY-MM-DD' (lunedì della settimana controllata), total_missing: N,
 *   matches:[{ weekday:'Saturday', date:'dd/mm/yyyy', time:'hh:mm', home:'…', away:'…',
 *              series:'Liga Heren' | 'Liga Dames' }], test:false,
 *   cc:'cnogara25@gmail.com' (facoltativo: copia del promemoria) }
 */
function sendReminder(d) {
  var secret = PropertiesService.getScriptProperties().getProperty('REMINDER_SECRET');
  if (!secret) return { ok: false, error: 'REMINDER_SECRET not set in script properties' };
  if (String(d.secret || '') !== secret) return { ok: false, error: 'unauthorized' };
  var to = String(d.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: 'invalid recipient' };
  var matches = Array.isArray(d.matches) ? d.matches : [];
  if (!matches.length) return { ok: false, error: 'no matches' };
  var name = String(d.referee_name || '').replace(/\s+/g, ' ').trim() || 'Video Referee';
  var total = parseInt(d.total_missing, 10) || matches.length;
  var mail = buildReminder(name, weekLabels(d.week_start), matches, total, !!d.test);
  // Copia facoltativa (dal 20/10/2026): l'admin riceve in copia ogni promemoria.
  var cc = String(d.cc || '').trim();
  if (cc && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cc)) return { ok: false, error: 'invalid cc' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'daily email quota exhausted' };
  var msg = { to: to, subject: mail.subject, body: mail.text, htmlBody: mail.html, name: 'Video Challenge BE' };
  if (cc && cc.toLowerCase() !== to.toLowerCase()) msg.cc = cc;
  MailApp.sendEmail(msg);
  return { ok: true, to: to, cc: msg.cc || null, subject: mail.subject, from: Session.getEffectiveUser().getEmail() };
}

function weekLabels(weekStart) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekStart || ''));
  var mon;
  if (m) {
    mon = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  } else {                       // fallback: lunedì della settimana precedente
    var now = new Date(), dow = (now.getUTCDay() + 6) % 7;
    mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow - 7));
  }
  var sun = new Date(mon.getTime() + 6 * 86400000);
  return {
    monday: Utilities.formatDate(mon, 'UTC', 'd MMMM yyyy'),
    mondayShort: Utilities.formatDate(mon, 'UTC', 'd MMMM'),
    sunday: Utilities.formatDate(sun, 'UTC', 'd MMMM yyyy')
  };
}

function matchLine(x) {
  return (x.weekday ? x.weekday + ' ' : '') + (x.date || '') + (x.time ? ', ' + x.time : '') +
         ' – ' + (x.home || '?') + ' vs ' + (x.away || '?') + (x.series ? ' (' + x.series + ')' : '');
}

function buildReminder(name, week, matches, total, isTest) {
  var many = matches.length > 1;
  var subject = (isTest ? '[TEST] ' : '') + 'Video Challenge BE – End-of-match report missing (week of ' + week.monday + ')';
  var intro = 'According to the official VolleyAdmin designations, you were the Video Referee for the following ' +
              (many ? 'matches' : 'match') + ' in the week of Monday ' + week.mondayShort + ' – Sunday ' + week.sunday + ':';
  var notYet = 'We have not yet received your end-of-match Video Challenge report for ' + (many ? 'these matches' : 'this match') + '.';
  var closing = 'If you have already sent it, or you did not officiate ' + (many ? 'these matches' : 'this match') +
                ', please reply to this email so we can correct our records.';
  var lines = matches.map(matchLine);

  var text = (isTest ? 'THIS IS A TEST MESSAGE – the match below is an example only, no action is needed.\n\n' : '') +
    'Dear ' + name + ',\n\n' + intro + '\n' + lines.map(function (l) { return '- ' + l; }).join('\n') + '\n\n' +
    notYet + '\n\nPlease fill it in as soon as possible in the app: ' + APP_URL + '\n' +
    'If the link opens a blank page, copy it and paste it into your browser, or type ' + APP_HOST + ' in the address bar.\n\n' +
    'Total reports missing: ' + total + '\n\n' + closing + '\n\nThank you,\nVideo Challenge BE';

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px">' +
    (isTest ? '<div style="background:#fff3cd;border:1px solid #f0c36d;padding:10px 14px;border-radius:6px;margin-bottom:16px"><b>THIS IS A TEST MESSAGE</b> – the match below is an example only, no action is needed.</div>' : '') +
    '<p>Dear ' + esc(name) + ',</p><p>' + esc(intro) + '</p><ul>' +
    lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
    '<p>' + esc(notYet) + '</p>' +
    '<p style="text-align:center;margin:26px 0"><a href="' + APP_URL + '" style="background:#1a73e8;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:8px;display:inline-block">Open the Video Challenge BE app</a></p>' +
    '<p style="font-size:13px;color:#555">If the button opens a blank page or does not work, press and hold it, choose Copy, and paste the link into your browser – or type <b>' + APP_HOST + '</b> in the address bar.</p>' +
    '<p><b>Total reports missing: ' + total + '</b></p>' +
    '<p>' + esc(closing) + '</p><p>Thank you,<br>Video Challenge BE</p></div>';
  return { subject: subject, text: text, html: html };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

/** Invia a cnogara25 un promemoria di prova; alla prima esecuzione Google chiede l'autorizzazione all'invio email. */
function sendTestReminder() {
  var secret = PropertiesService.getScriptProperties().getProperty('REMINDER_SECRET');
  var res = sendReminder({
    action: 'reminder', secret: secret, to: 'cnogara25@gmail.com', referee_name: 'Christian Nogara',
    week_start: Utilities.formatDate(new Date(Date.UTC(2026, 9, 5)), 'UTC', 'yyyy-MM-dd'), total_missing: 1, test: true,
    matches: [{ weekday: 'Saturday', date: '10/10/2026', time: '20:30', home: 'VC Oudegem', away: 'Asterix AVO Beveren', series: 'Liga Dames' }]
  });
  Logger.log(JSON.stringify(res));
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
