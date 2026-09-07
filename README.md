# Organizer

Ein Schul-Organizer: WebUntis synchronisiert sich automatisch, und unter jedem
Fach lassen sich Notizen, Audio-Aufnahmen und Dokumente ablegen — mit
KI-Zusammenfassungen, Lernkarten und Suche über alles.

Läuft als Cloudflare Worker. Das Frontend bleibt abhängigkeitsfreies HTML, CSS
und ES-Module; der Worker hält alles, was Zugangsdaten braucht.

## Warum ein Server nötig ist

Die erste Fassung war eine reine Browser-App. Das geht hier nicht mehr, aus zwei
Gründen:

1. **WebUntis sendet keine CORS-Header.** Ein `fetch` aus dem Browser wird
   blockiert — auch der offizielle JS-Client zielt ausdrücklich auf Node.
2. **API-Schlüssel gehören nicht ins Frontend.** Ein ausgelieferter Claude-Key
   ist ein öffentlicher Key.

Beides landet deshalb im Worker.

## Aufbau

```
web/                  Frontend (unverändert abhängigkeitsfrei)
  index.html
  css/styles.css
  js/{store,filters,ui,app}.js
worker/
  schema.sql          D1-Schema
  src/index.js        Router, Cron-Sync, Transkriptions-Queue
  src/auth.js         Single-User-Login, signiertes Cookie
  src/untis.js        WebUntis JSON-RPC + REST (fetch injizierbar)
  src/sync.js         Reconciliation (rein, ohne DB)
  src/db.js           D1-Adapter
  src/ai.js           Claude + Whisper
  src/srs.js          SM-2 und Transkript-Zusammenführung (rein)
tests/                Unit-Tests, headless und im Browser
```

Der Zuschnitt folgt einer Regel: **Entscheidungen sind rein, Seiteneffekte sind
dünn.** `sync.js`, `srs.js` und die Normalisierung in `untis.js` enthalten die
eigentliche Logik und kennen weder Datenbank noch Netzwerk — deshalb sind sie
ohne Cloudflare testbar. `db.js` und `index.js` sind bewusst dumm.

## Features

- **WebUntis-Sync** alle 30 Minuten während der Schulzeit: Fächer, Stundenplan,
  Hausaufgaben, Klausuren. Entfall und Vertretung werden erkannt und markiert.
- **Pro Fach**: Notizen (Markdown), Audio-Aufnahmen, Dokumente.
- **Transkription** von Aufnahmen über Workers AI (Whisper). Lange Aufnahmen
  werden in Stücke geteilt, parallel transkribiert und nach Index wieder
  zusammengesetzt.
- **Zusammenfassungen** über Claude. PDFs gehen direkt an das Modell — kein
  eigener PDF-Parser, also auch keine kaputte Textextraktion.
- **Lernkarten** mit SM-2-Wiederholung, per Structured Outputs erzeugt.
- **Suche** über Notizen, Transkripte und Zusammenfassungen (FTS5).
- Der bestehende Aufgaben-Teil bleibt: Today/Upcoming, Prioritäten, `#tags`,
  Undo, Hell/Dunkel, Offline-Betrieb.

### Was ein Sync nie anfasst

Alles aus Untis trägt seine `untis_id` und wird per Upsert abgeglichen. Ein
zweiter Sync ändert deshalb nichts. Vor allem: **eine lokal abgehakte Hausaufgabe
bleibt abgehakt**, auch wenn Untis sie weiter als offen meldet. Notizen,
Aufnahmen und Zusammenfassungen haben keine Untis-Id und werden nie überschrieben.

## Einrichtung

```sh
npm install
npx wrangler d1 create organizer          # ID in wrangler.toml eintragen
npx wrangler r2 bucket create organizer-media
npx wrangler queues create organizer-transcribe
npm run db:init                            # Schema lokal anlegen
```

Zugangsdaten als Secrets — niemals in `wrangler.toml`:

```sh
npx wrangler secret put UNTIS_USER
npx wrangler secret put UNTIS_PASSWORD
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SESSION_SECRET     # lange Zufallszeichenkette
npx wrangler secret put PASSWORD_SALT
npx wrangler secret put PASSWORD_HASH      # SHA-256 von "<salt>:<passwort>"
```

`UNTIS_HOST` und `UNTIS_SCHOOL` stehen als `vars` in `wrangler.toml` (z.B.
`nessa.webuntis.com` und das Schulkürzel aus der Untis-URL).

```sh
npm run dev      # lokal, http://localhost:8787
npm run deploy   # veröffentlichen
```

Für den Deploy aus GitHub Actions: `CLOUDFLARE_API_TOKEN` und
`CLOUDFLARE_ACCOUNT_ID` als Repository-Secrets. Fehlen sie, überspringt der
Workflow den Deploy mit einem Hinweis, statt rot zu werden.

**Kosten:** Queues und Vectorize gibt es nicht im Free-Tier, und das CPU-Limit
dort ist für Sync- und KI-Läufe knapp. Für den vollen Funktionsumfang ist der
Workers-Paid-Plan (~5 $/Monat) nötig; dazu die Claude-Nutzung (Opus 5:
5 $ / 25 $ pro Mio. Token).

## Tests

```sh
npm test          # oder: node tests/run.js
```

Oder `tests/test.html` im Browser für denselben Umfang mit sichtbarem Bericht.

Abgedeckt sind unter anderem: WebUntis-Datums- und Zeitkodierung (`830` = 08:30),
Session- und Cookie-Handling gegen einen Fetch-Stub, Erkennung von Entfall und
Vertretung, Idempotenz des Syncs, das Überleben lokaler Änderungen, Ablauf und
Fälschung von Session-Tokens, SM-2-Intervalle samt Ease-Untergrenze und die
Zusammenführung von Transkript-Stücken.

## Datenformat

Der Aufgaben-Teil im Browser nutzt weiterhin `organizer.v1` in `localStorage`
und lässt sich als JSON exportieren und importieren. Importe werden feldweise
validiert; defekte Datensätze werden verworfen statt übernommen.
