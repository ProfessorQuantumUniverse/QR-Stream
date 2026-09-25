# Quick Start Guide - Spiegel-Support 3D-Druck

## Sofort-Anleitung

### Was ist das?
Ein 3D-druckbarer Support für deinen 20cm Euler's Disk Grafenspiegel, der ihn von unten stützt und vor Bruch schützt.

### Schnellstart

1. **Datei herunterladen**: `mirror-support.stl`
2. **In Slicer laden** (Cura, PrusaSlicer, etc.)
3. **Empfohlene Einstellungen**:
   - Material: PLA
   - Schichthöhe: 0.2mm
   - Infill: 25%
   - Brim: Ja (10mm)
   - Supports: Nein
4. **Drucken** (~4 Stunden)
5. **Fertig!** Spiegel einlegen und testen

### Maße Check
- Spiegel-Durchmesser: 20cm ✓
- Randhöhe: 1,5cm ✓
- Konkave Form: Ja ✓

### Anpassungen nötig?
Öffne `mirror-support.scad` in OpenSCAD und ändere die Parameter oben in der Datei.

### Probleme?
- **Spiegel passt nicht**: Erhöhe `support_diameter` in der .scad Datei
- **Zu wackelig**: Erhöhe `wall_thickness` oder `infill`
- **Zu hoch**: Reduziere `edge_height`

### Material-Bedarf
- Ca. 60-80g Filament
- Druckzeit: 3-5 Stunden

---

**Tipp**: Drucke zuerst einen Test-Ring (nur die Außenwand, ersten 5mm Höhe) um die Passung zu prüfen!
