# Farbrevier

Ein Browser-Spiel, in dem du Gebiet eroberst – gegen 10 computergesteuerte Bots.

## Spielen

Einfach `index.html` im Browser öffnen. Es wird nichts installiert und kein Server gebraucht.

Optional mit lokalem Server:

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Über GitHub Pages lässt sich das Spiel direkt online stellen (Settings → Pages → Branch auswählen).

### Als App auf dem Home-Bildschirm

Die Seite bringt App-Icon und Manifest mit. Auf dem iPhone in Safari: Teilen-Symbol → „Zum Home-Bildschirm“.
Auf Android in Chrome: Menü (⋮) → „Zum Startbildschirm hinzufügen“. Das Spiel startet dann im Vollbild
ohne Browserleiste.

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
| P / Esc | Pause |

## Bots

Die Bots planen Ausflüge aus ihrem Gebiet (raus, seitwärts, zurück), kehren heim, wenn ein Gegner
ihrer Spur gefährlich nahe kommt, und greifen fremde Spuren in ihrer Nähe an. Jeder Bot hat eine
zufällige Risikobereitschaft – manche spielen vorsichtig, andere gierig. Ausgeschiedene Bots kommen
nach ein paar Sekunden mit neuem Namen zurück.

## Dateien

- `index.html` – Seite und Menüs
- `style.css` – Aussehen der Oberfläche
- `game.js` – Spiellogik, Bot-KI und Darstellung
- `manifest.webmanifest`, `icon.png` – App-Icon und Einstellungen für den Home-Bildschirm
