# Servizio Apps Script: archivio PDF su Drive e promemoria agli arbitri

Ogni modulo di fine partita inviato dall'app viene salvato in PDF dalla edge function
`send-report` (bucket privato `vcbe-reports`). Per averne una copia anche su Drive, nella
cartella dell'arbitro, l'app chiama un piccolo servizio Google Apps Script che gira con
l'account cnogara25@gmail.com e scrive in **Challenge Video VB / NOME ARBITRO /**.

Codice del servizio: `docs/drive-hook.gs`.

## Attivazione (una sola volta, account cnogara25@gmail.com)

1. Aprire https://script.google.com e creare un **Nuovo progetto**.
2. Cancellare il contenuto di `Codice.gs`, incollare tutto `docs/drive-hook.gs`, salvare.
   Rinominare il progetto, ad esempio "Video Challenge BE – Drive hook".
3. Nel menu a tendina delle funzioni scegliere `createRefereeFolders` e premere **Esegui**.
   Alla prima esecuzione Google chiede l'autorizzazione (Drive + connessione a servizi
   esterni): accettare. Crea le sottocartelle mancanti per gli arbitri attivi.
4. Scegliere `migrateFromLegacyFolder` e premere **Esegui**: copia i PDF già archiviati il
   17/10/2026 (cartella nel Drive di srlchrisa) nelle sottocartelle giuste.
5. **Distribuisci → Nuova distribuzione**, tipo **App web**:
   - Esegui come: **Me** (cnogara25@gmail.com)
   - Chi ha accesso: **Chiunque**
   Premere Distribuisci e copiare l'**URL dell'app web** (termina con `/exec`).
6. Incollare l'URL in chat: va inserito in `index.html` nella costante `DRIVE_HOOK_URL`
   e pubblicato. Finché la costante è vuota la funzione è spenta e l'app si comporta
   come prima.

Verifica rapida: aprendo l'URL `/exec` nel browser si deve vedere
`{"ok":true,"service":"vcbe-drive-hook",...}`.

## Come funziona

- Dopo la risposta positiva di `send-report`, l'app manda al servizio: `pdf_url` (link
  firmato 7 giorni), `referee_name`, `match_date`, `host_team`, `league`.
- Il servizio accetta solo link del bucket `vcbe-reports` del progetto CityLens, scarica
  il PDF, trova (o crea) la sottocartella dell'arbitro e salva il file come
  `AAAA-MM-GG - Squadra di casa - NOME ARBITRO.pdf`.
- Il percorso del file nel bucket viene scritto nella descrizione del file Drive: se lo
  stesso rapporto arriva due volte non viene duplicato.
- Il salvataggio su Drive non blocca mai l'invio del modulo: se fallisce, il PDF resta
  comunque nel bucket e si recupera dall'area admin dell'app ("View PDF").

## Manutenzione

- Modifiche al codice: dopo aver incollato la nuova versione, **Distribuisci → Gestisci
  distribuzioni → matita → Versione: Nuova versione → Distribuisci**. L'URL non cambia.
- Nuovo arbitro in `vcbe_referees`: la sottocartella viene creata automaticamente al primo
  modulo inviato; in alternativa rieseguire `createRefereeFolders`.
- Quota Apps Script (account gratuito): 20.000 richieste esterne al giorno, più che
  sufficienti.
- Evoluzione consigliata: spostare la chiamata al servizio dentro la edge function
  `send-report` (lato server, con un segreto condiviso), così non dipende dal browser
  dell'arbitro. Richiede una sessione con il connettore Supabase collegato al progetto
  CityLens.

## Promemoria agli arbitri inviati da cnogara25@gmail.com (dal 17/10/2026)

Il controllo settimanale del lunedì gira in una sessione Claude collegata alla casella
srlchrisa. I promemoria agli arbitri devono però partire da **cnogara25@gmail.com**: per
questo la routine non li spedisce più da sola, ma manda i dati allo stesso servizio Apps
Script (azione `reminder`), che compone l'email in inglese con il pulsante verso l'app e la
invia dall'account cnogara25 (`MailApp`, copia nella posta inviata di cnogara25, limite
100 email al giorno).

Attivazione (account cnogara25, nel progetto Apps Script esistente):
1. **Impostazioni progetto** (ingranaggio a sinistra) → **Proprietà dello script** →
   **Aggiungi proprietà dello script**: chiave `REMINDER_SECRET`, valore = il segreto
   comunicato in chat (lo stesso che sta nel prompt della routine). Salvare.
2. Nell'editor sostituire tutto il codice con la versione aggiornata di `docs/drive-hook.gs`
   e salvare.
3. Menu funzioni → `sendTestReminder` → **Esegui**: Google chiede l'autorizzazione
   all'invio email (accettare). Arriva a cnogara25 un promemoria di prova con il riquadro
   TEST, spedito da cnogara25 stesso.
4. **Esegui il deployment → Gestisci deployment → matita → Versione: Nuova versione →
   Esegui il deployment**. L'URL non cambia.

Chiamata usata dalla routine (POST JSON all'URL `/exec`, `Content-Type: text/plain`,
seguendo i redirect):

```json
{"action":"reminder","secret":"<REMINDER_SECRET>","to":"arbitro@example.com",
 "referee_name":"Nome Cognome","week_start":"2026-10-05","total_missing":1,
 "matches":[{"weekday":"Saturday","date":"10/10/2026","time":"20:30",
             "home":"VC Oudegem","away":"Asterix AVO Beveren","series":"Liga Dames"}]}
```

Risposta: `{"ok":true,"to":…,"subject":…,"from":"cnogara25@gmail.com"}` oppure
`{"ok":false,"error":…}` (`unauthorized` = segreto errato, `REMINDER_SECRET not set` =
proprietà mancante). Con `"test":true` l'oggetto riceve il prefisso `[TEST]` e il riquadro
giallo. Il testo dell'email vive solo nello script (`buildReminder`): per cambiarlo si
modifica lì e si pubblica una nuova versione.
