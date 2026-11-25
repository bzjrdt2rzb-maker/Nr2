# Papierfresser

Ein Browser-Spiel, in dem du Gebiet eroberst – allein gegen Bots oder mit Freunden auf verschiedenen Geräten.

## Spielmodi

| Modus | Wie | Was du brauchst |
| --- | --- | --- |
| **Allein spielen** | Du gegen 10 Bots | nichts – `index.html` öffnen reicht |
| **Raum erstellen / Beitreten** | Einer erstellt einen Raum und bekommt einen 4-stelligen Code (oder einen Einladungslink). Die anderen geben den Code ein. Das Gerät des Gastgebers rechnet das Spiel. | Seite auf GitHub Pages (siehe unten) |
| **Online spielen** | Alle verbinden sich mit einem gemeinsamen Spielserver. Jeder, der die Seite öffnet, landet in derselben Welt. | Server auf Render.com (siehe unten) |

In allen Modi füllen Bots die Welt auf, damit immer etwas los ist. Kommen mehr Menschen dazu, verschwinden entsprechend Bots.

### Tempo

Im Menü lässt sich das Tempo vor dem Spiel wählen: **1×, 1,25×, 1,5×, 2×, 2,5×, 5× oder 10×**. Es gilt für alle Figuren,
also auch für die Bots. Bei hohem Tempo zoomt die Ansicht etwas heraus, damit du mehr siehst.

- **Allein spielen:** dein gewähltes Tempo
- **Raum:** das Tempo des Gastgebers gilt für alle im Raum
- **Online-Server:** feste Einstellung des Servers über die Umgebungsvariable `SPEED` (Standard `1`),
  bei Render unter *Environment* einstellbar

### Geheimnamen

Bestimmte Namen geben deiner Figur ein eigenes Aussehen und eine Spezialkraft. Während des Spiels erscheint
dann unten links ein Knopf dafür (am Computer auch Taste **U** oder **Leertaste**). Groß- und Kleinschreibung
ist egal. Das gilt in allen Modi, und Mitspieler sehen Aussehen und Effekte ebenfalls. Im Mehrspieler-Modus
prüft der Server bzw. Gastgeber den Namen – wer anders heißt, kann die Kräfte nicht benutzen.

| Name | Aussehen | Knopf |
| --- | --- | --- |
| **Einhorn** 🦄 | Glitzerndes Regenbogen-Gebiet, Horn | **Unsterblich** an/aus |
| **Kaktus** 🌵 | Grün mit Stacheln und Blüte, Gebiet wird zur Sandwüste mit Kakteen und Kaktusblüten | **Stacheln** an/aus – solange sie an sind, wird jeder automatisch ausgeschaltet, der in den Umkreis von 6 Feldern kommt (grüne Zone mit Stachelkranz) |
| **Lightning McQueen** ⚡ | Rot mit Blitz, Gebiet wird zur Rennstrecke mit rot-weißen Randsteinen, Flammen beim Turbo | **Turbo** an/aus – 5× so schnell (Kurven bleiben gleich eng). Außerdem kann McQueen immer gefahrlos über die eigene Spur fahren |

Einhorn, Kaktus und McQueen schalten sich nicht gegenseitig aus: Ein unsterbliches Einhorn übersteht auch die Kaktus-Stacheln.

#### Einhorn im Detail

Heißt ein Spieler **Einhorn**, wird sein Gebiet zum glitzernden Regenbogen, und seine Figur bekommt ein Horn.
Das gilt in allen Modi und ist für alle Mitspieler sichtbar.

Als Einhorn erscheint während des Spiels zusätzlich der Knopf **„Unsterblich“** (oder Taste **U**). Solange er an ist,
kann dich nichts ausschalten: weder fremde noch die eigene Spur, kein Zusammenstoß. Wird dein ganzes Gebiet erobert,
bekommst du an deiner Position ein neues Startgebiet. Ein goldener Leuchtring zeigt allen, dass du gerade unsterblich bist.
Nochmal drücken schaltet es wieder aus.

## Regeln

- Du startest mit einem kleinen Gebiet in deiner Farbe.
- Verlässt du dein Gebiet, ziehst du eine Spur hinter dir her.
- Kehrst du in dein Gebiet zurück, gehört dir alles, was die Spur umschließt.
- Fährt jemand über deine Spur, bist du raus – und umgekehrt.
- Fährst du über deine eigene Spur, bist du ebenfalls raus.
- Frontalzusammenstoß: Wer im eigenen Gebiet steht, gewinnt. Sind beide draußen, verliert der mit der längeren Spur.
- Wird dein gesamtes Gebiet erobert, ist das Spiel vorbei.

## Steuerung

| Eingabe | Aktion |
| --- | --- |
| Maus | Spielfigur folgt dem Mauszeiger |
| Pfeiltasten / WASD | Richtung wechseln |
| Touch | Finger auf den Bildschirm – die Figur fährt in diese Richtung |
| P / Esc | Pause (nur allein) |
| U / Leertaste | Spezialkraft (nur mit Geheimnamen) |

## Online stellen

### GitHub Pages (Allein spielen + Raumcode)

1. Im Repo auf **Settings → Pages** gehen.
2. Bei *Source* „Deploy from a branch“ wählen, Branch auswählen, Ordner `/ (root)`, speichern.
3. Nach etwa einer Minute ist das Spiel unter `https://<benutzername>.github.io/<repo>/` erreichbar.

Der Raumcode-Modus nutzt [PeerJS](https://peerjs.com/): Ein kostenloser Vermittlungsserver bringt die Geräte zusammen,
danach laufen die Daten direkt von Gerät zu Gerät. Hinweise:

- Der Gastgeber muss das Spiel offen und im Vordergrund lassen, sonst bleibt die Welt für alle stehen.
- Im selben WLAN klappt es am zuverlässigsten. Über Mobilfunk kann die direkte Verbindung manchmal scheitern –
  dann hilft der Online-Server.

### Render.com (Online-Server)

Der Server (`server/server.js`) liefert das Spiel aus **und** betreibt die gemeinsame Welt. Unter seiner Adresse
funktionieren alle drei Modi.

1. Konto auf [render.com](https://render.com) anlegen und mit GitHub verbinden.
2. **New → Blueprint** wählen und dieses Repo auswählen. Render liest `render.yaml` und richtet alles ein (kostenloser Plan).
3. Nach dem Deploy die angezeigte Adresse öffnen (z. B. `https://papierfresser.onrender.com`) – fertig.

Der kostenlose Plan schläft nach etwa 15 Minuten ohne Besucher ein. Der erste Aufruf danach dauert 30–60 Sekunden.

Soll die GitHub-Pages-Version ebenfalls den Online-Server benutzen, trage dessen Adresse in `config.js` ein:

```js
window.FARBREVIER_SERVER = 'https://papierfresser.onrender.com';
```

### Lokal testen

```bash
npm install
npm start            # Server auf http://localhost:8080
```

Ohne Server reicht es auch, `index.html` direkt im Browser zu öffnen (nur „Allein spielen“ und Raumcode).

### Als App auf dem Home-Bildschirm

Die Seite bringt App-Icon und Manifest mit. Auf dem iPhone in Safari: Teilen-Symbol → „Zum Home-Bildschirm“.
Auf Android in Chrome: Menü (⋮) → „Zum Startbildschirm hinzufügen“. Das Spiel startet dann im Vollbild
ohne Browserleiste.

## Bots

Die Bots planen Ausflüge aus ihrem Gebiet (raus, seitwärts, zurück), kehren heim, wenn ein Gegner
ihrer Spur gefährlich nahe kommt, und greifen fremde Spuren in ihrer Nähe an. Jeder Bot hat eine
zufällige Risikobereitschaft – manche spielen vorsichtig, andere gierig. Ausgeschiedene Bots kommen
nach ein paar Sekunden mit neuem Namen zurück.

## Dateien

- `index.html` – Seite und Menüs
- `style.css` – Aussehen der Oberfläche
- `engine.js` – Spiellogik und Bot-KI (läuft im Browser und auf dem Server)
- `game.js` – Darstellung, Steuerung, Menüs und Netzwerk im Browser
- `config.js` – Adresse des Online-Servers
- `server/server.js` – Online-Server (Node.js, WebSocket)
- `package.json`, `render.yaml` – Einstellungen für den Server und Render.com
- `manifest.webmanifest`, `icon.png` – App-Icon und Einstellungen für den Home-Bildschirm
