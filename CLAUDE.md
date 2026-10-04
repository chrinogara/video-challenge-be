# Video Challenge BE

- Rispondere e scrivere all'utente SEMPRE in italiano.
- App in un unico file: `index.html` (niente build, niente framework separati).
- Live: https://video-challenge-be.vercel.app — repo `chrinogara/video-challenge-be`.
- Trilingue EN / FR / NL: ogni testo UI nuovo va aggiunto in tutte e tre le lingue.
- Backend: Supabase progetto CityLens `apbusqbeneppepfkvklv`; le tabelle dell'app hanno prefisso `vcbe_`.
- Deploy: GitHub Contents API PUT su `index.html`; Vercel si aggiorna da solo.

## Dati Supabase principali
- `vcbe_referees`: elenco Video Referee (name, email, active). Non esiste registrazione individuale: l'arbitro si identifica tramite nome/email di questa tabella.
- `vcbe_reports`: moduli di fine partita inviati dall'app (referee_name, match_date, host_team, league, created_at).
- `vcbe_miss_log`: moduli mancanti (referee_name, week_start = lunedì della settimana, reminded_at).
- Edge function `send-report` (v6, 27/09/2026): salva il modulo + PDF nel bucket privato `vcbe-reports`, invia il PDF a cnogara25@gmail.com e una copia separata all'arbitro (email da `vcbe_referees`, nome confrontato senza distinzione di maiuscole). Risponde con `pdf_url` (link firmato valido 7 giorni, mostrato nell'app come "Download PDF") e `referee_email_status` (`sent` / `no_email` / `blocked_test_mode` / `failed`); l'app mostra il messaggio corrispondente in EN/FR/NL.
  - VERIFICATO 27/09/2026: l'email all'admin arriva; la copia all'arbitro è rifiutata da Resend (403) perché l'account (titolare cnogara25@gmail.com) è in modalità test col mittente `onboarding@resend.dev`, che consegna solo al titolare. Quando la copia non parte, l'email admin contiene una riga rossa con l'indirizzo dell'arbitro da inoltrare a mano.
  - 27/09/2026 sera: dopo un primo dubbio, l'admin CONFERMA di ricevere le email di test su cnogara25@gmail.com (se non compaiono, cercare `from:onboarding@resend.dev` anche in Spam). La chiave `RESEND_API_KEY` è di tipo "sending access only": l'azione `resend_diag` di `admin-write` (GET /emails, /domains) restituisce 401 finché non si crea su resend.com una chiave "full access" e la si salva nel secret. Lo stato di consegna reale va letto su https://resend.com/emails (Delivered / Bounced / Complained). Il connettore Gmail di Claude Code è la casella srlchrisa@gmail.com, non cnogara25: non può ispezionare la casella admin.
  - Per sbloccare la copia all'arbitro: verificare un dominio su https://resend.com/domains (record DNS) e impostare il secret `RESEND_FROM` della funzione (es. `Video Challenge BE <reports@dominio.be>`); nessuna modifica al codice necessaria. Lo stesso mittente andrebbe poi usato anche in `admin-write` (promemoria), che oggi ha `onboarding@resend.dev` fisso nel codice.
- Edge function `admin-write` (service role): azioni admin protette da password in `vcbe_admin_config`.
  - PDF dei rapporti per l'admin (v12, 04/10/2026): azione `report_pdf` {id} → link firmato di 10 minuti al file `pdf_path` nel bucket privato `vcbe-reports`; `list_reports` restituisce `has_pdf`. Nell'app, SOLO dopo lo sblocco admin: in Challenge diagnostics il contatore "N reports" di ogni squadra apre l'elenco dei suoi rapporti, e lì come in Reports & data c'è il pulsante "View PDF" (EN/FR/NL) che apre il PDF nel visualizzatore. Il codice delle edge function non è nel repo: per modificarle leggere la versione attiva con `get_edge_function` e ridistribuirla completa.
- `vcbe_admin_config` e `vcbe_miss_log` hanno RLS attiva senza policy (accesso solo lato server). Non disattivarla.
- DA FARE: cambiare la password admin in `vcbe_admin_config` (è stata leggibile pubblicamente fino al 27/09/2026, prima dell'attivazione della RLS).

## Controllo settimanale Video Referee (ogni domenica 22:00, ora di Bruxelles)
- Cartella Drive "Challenge Video VB": https://drive.google.com/drive/folders/1RoziJRp4tE7SAlnnQ04AXq_x3uCGp_pe (proprietario cnogara25@gmail.com).
- Ogni settimana contiene un PDF con i soli Video Referee che hanno arbitrato in quella settimana (es. "Video arbitri Liga - 2026-09-27.pdf", fonte VolleyAdmin2, serie LIGH/LIGD). Il file viene aggiornato o sostituito: l'ID cambia, va ritrovato ogni volta.
- Il connettore Google Drive NON vede i file della cartella. Metodo funzionante (cartella/file condivisi via link):
  - elenco: `curl -sSL "https://drive.google.com/embeddedfolderview?id=1RoziJRp4tE7SAlnnQ04AXq_x3uCGp_pe" | grep -oE 'file/d/[A-Za-z0-9_-]{20,}|flip-entry-title">[^<]*'`
  - download: `curl -sSL -o vr.pdf "https://drive.google.com/uc?export=download&id=<ID>"`, poi leggere il PDF.
- Routine "Controllo settimanale Video Referee" (trig_01KD4SuUQaMEH7KEdAQKFPek) gira nella sessione Claude Code che l'ha creata, collegata a Drive/Gmail/Supabase.
- Controllo: incrociare i nomi del PDF con `vcbe_referees`, verificare in `vcbe_reports` se hanno inviato il modulo per quella partita/settimana.
- Azioni, tutte e tre: (a) riepilogo via email SOLO a cnogara25@gmail.com (mai a srlchrisa@gmail.com), oggetto con prefisso "[VideoReferees]" per il filtro Gmail che applica l'etichetta VideoReferees, (b) promemoria email trilingue EN/FR/NL a chi non ha inviato, (c) registrazione in `vcbe_miss_log` (una riga per arbitro per settimana, niente duplicati).
