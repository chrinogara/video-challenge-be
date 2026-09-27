# Video Challenge BE

- App in un unico file: `index.html` (niente build, niente framework separati).
- Live: https://video-challenge-be.vercel.app — repo `chrinogara/video-challenge-be`.
- Trilingue EN / FR / NL: ogni testo UI nuovo va aggiunto in tutte e tre le lingue.
- Backend: Supabase progetto CityLens `apbusqbeneppepfkvklv`; le tabelle dell'app hanno prefisso `vcbe_`.
- Deploy: GitHub Contents API PUT su `index.html`; Vercel si aggiorna da solo.

## Dati Supabase principali
- `vcbe_referees`: elenco Video Referee (name, email, active). Non esiste registrazione individuale: l'arbitro si identifica tramite nome/email di questa tabella.
- `vcbe_reports`: moduli di fine partita inviati dall'app (referee_name, match_date, host_team, league, created_at).
- `vcbe_miss_log`: moduli mancanti (referee_name, week_start = lunedì della settimana, reminded_at).
- Edge function `admin-write` (service role): azioni admin protette da password in `vcbe_admin_config`.
- `vcbe_admin_config` e `vcbe_miss_log` hanno RLS attiva senza policy (accesso solo lato server). Non disattivarla.

## Controllo settimanale Video Referee (ogni domenica 22:00, ora di Bruxelles)
- Cartella Drive "Challenge Video VB": https://drive.google.com/drive/folders/1RoziJRp4tE7SAlnnQ04AXq_x3uCGp_pe (proprietario cnogara25@gmail.com).
- Ogni settimana contiene un PDF con i soli Video Referee che hanno arbitrato in quella settimana.
- Controllo: incrociare i nomi del PDF con `vcbe_referees`, verificare in `vcbe_reports` se hanno inviato il modulo per quella partita/settimana.
- Azioni, tutte e tre: (a) riepilogo via email a srlchrisa@gmail.com, (b) promemoria email trilingue EN/FR/NL a chi non ha inviato, (c) registrazione in `vcbe_miss_log` (una riga per arbitro per settimana, niente duplicati).
