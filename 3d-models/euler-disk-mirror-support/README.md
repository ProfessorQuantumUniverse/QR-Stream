# Euler's Disk Mirror Support Inlay

## Beschreibung

Dieses 3D-Modell ist eine Stütze für einen konkaven Grafenspiegel (20 cm Durchmesser), wie er bei Euler's Disk verwendet wird. Der Support verhindert, dass der Spiegel bricht, indem er ihn von unten stabilisiert und eine ebene Standfläche bietet.

## Spezifikationen

### Spiegel-Maße
- **Durchmesser**: 20 cm (200 mm)
- **Randhöhe**: 1,5 cm (15 mm) vom Boden
- **Form**: Leicht konkav (konkave Seite nach unten)

### Support-Maße
- **Außendurchmesser**: 21 cm (210 mm) - für stabile Basis
- **Innendurchmesser**: 19,5 cm (195 mm) - passend zum Spiegel
- **Höhe**: 1,8 cm (18 mm) - 15 mm Randhöhe + 3 mm Basis
- **Wandstärke**: 5 mm
- **Basisstärke**: 3 mm

## Design-Merkmale

1. **Konkave Passfläche**: Die Oberseite des Supports ist konkav geformt und passt exakt zur Unterseite des Spiegels
2. **Verstärkungsrippen**: 8 radiale Rippen für zusätzliche Stabilität
3. **Ebene Basis**: Große, flache Unterseite für sicheren Stand
4. **Konische Außenwand**: Verhindert Verkanten und erleichtert das Platzieren des Spiegels

## 3D-Druck Einstellungen

### Empfohlene Einstellungen
- **Material**: PLA oder PETG
  - PLA: Einfacher zu drucken, ausreichend stabil
  - PETG: Höhere Festigkeit und Temperaturbeständigkeit
- **Schichthöhe**: 0,2 mm (gute Balance zwischen Qualität und Geschwindigkeit)
- **Infill**: 20-30% (ausreichend für Stabilität)
- **Wandlinien**: 3-4 für zusätzliche Festigkeit
- **Druckgeschwindigkeit**: 50-60 mm/s
- **Bett-Temperatur**: 
  - PLA: 60°C
  - PETG: 80°C
- **Düsen-Temperatur**: 
  - PLA: 200-210°C
  - PETG: 230-240°C

### Besondere Hinweise
- **Supports**: Nicht erforderlich - das Design ist druckerfreundlich
- **Bett-Haftung**: Brim (5-10 mm) empfohlen wegen großer Grundfläche
- **Orientierung**: Flache Basis auf dem Druckbett (wie im Modell)
- **Druckzeit**: Ca. 3-5 Stunden (je nach Drucker und Einstellungen)
- **Material-Verbrauch**: Ca. 50-80g Filament

## Dateien

- `mirror-support.scad` - OpenSCAD Quellcode (parametrisch, editierbar)
- `mirror-support.stl` - STL-Datei für direkten 3D-Druck

## Anpassungen

Um das Modell anzupassen, öffnen Sie die `.scad` Datei in [OpenSCAD](https://openscad.org/) und ändern Sie die Parameter am Anfang der Datei:

```openscad
mirror_diameter = 200;        // Spiegel-Durchmesser
edge_height = 15;             // Randhöhe
support_diameter = 195;       // Support-Durchmesser
wall_thickness = 5;           // Wandstärke
concave_radius = 3000;        // Radius der konkaven Kurve
```

Nach Änderungen:
1. Drücken Sie F5 für Vorschau
2. Drücken Sie F6 für finales Rendering
3. Exportieren Sie als STL: File → Export → Export as STL

## Alternative Version

Die Datei enthält auch eine vereinfachte Version (`simple_concave_support()`), die:
- Weniger Material verwendet (Aussparungen im Boden)
- Schneller druckt
- Etwas weniger Stabilität bietet

Um die vereinfachte Version zu verwenden, kommentieren Sie die Hauptversion aus und aktivieren Sie die alternative:

```openscad
//concave_support();          // Haupt-Version auskommentiert
simple_concave_support();     // Alternative aktiviert
```

## Verwendung

1. Drucken Sie den Support
2. Entfernen Sie vorsichtig Support-Material falls vorhanden
3. Säubern Sie die Oberfläche bei Bedarf
4. Platzieren Sie den Support auf einer ebenen Fläche
5. Setzen Sie den Spiegel vorsichtig in den Support ein
6. Der Spiegel sollte nun sicher stehen und von unten gestützt sein

## Lizenz

Dieses Modell ist Teil des QR-Stream Projekts und steht unter der gleichen Lizenz wie das Hauptprojekt.

## Hinweis

Dieses Design ist eine theoretische Lösung basierend auf den angegebenen Maßen. Vor dem finalen Druck empfiehlt sich:
- Messen Sie Ihren tatsächlichen Spiegel genau aus
- Drucken Sie ggf. einen kleineren Test-Ring zur Passformprüfung
- Passen Sie die Parameter in der .scad Datei bei Bedarf an
