// Euler's Disk Mirror Support Inlay
// 3D-druckbare Stütze für konkaven Grafenspiegel
// 
// Dieser Support stabilisiert einen konkaven 20cm Spiegel von unten
// und gibt ihm eine ebene Standfläche

// ===== PARAMETER =====
// Alle Maße in mm

// Spiegel-Spezifikationen
mirror_diameter = 200;        // Durchmesser des Spiegels: 20 cm
edge_height = 15;             // Höhe am Rand: 1.5 cm vom Boden
center_height = 0;            // Höhe in der Mitte (Referenzpunkt)

// Support-Spezifikationen
support_diameter = 195;       // Etwas kleiner als Spiegel für gute Passung
support_thickness = 3;        // Dicke des Support-Materials
wall_thickness = 5;           // Dicke der Außenwand
base_diameter = 210;          // Durchmesser der Basis (größer für Stabilität)
base_thickness = 3;           // Dicke der Basis

// Konkave Kurve - Annahme: leicht sphärische Konkavität
// Berechnung: Für eine sphärische Oberfläche mit Radius R, Durchmesser d=200mm, Höhe h=15mm
// Näherung für flache Kurven: R ≈ (d²)/(8h) + h/2 = (200²)/(8*15) + 15/2 ≈ 341mm
// Da die genaue Krümmung unbekannt ist, verwenden wir einen größeren Radius für
// eine konservative (flachere) Kurve, die an verschiedene Spiegelformen anpassbar ist
concave_radius = 3000;        // Großer Radius für sanfte, anpassbare Kurve
                               // Reduzieren für stärkere Krümmung, erhöhen für flachere

// Qualitätseinstellungen
$fn = 100;                    // Anzahl der Fragmente für glatte Kurven

// ===== HAUPTMODELL =====

module concave_support() {
    difference() {
        // Basis mit Außenwand
        union() {
            // Flache kreisförmige Basis
            cylinder(h = base_thickness, r = base_diameter/2);
            
            // Außenwand für zusätzliche Stabilität
            translate([0, 0, base_thickness])
            cylinder(h = edge_height, r = support_diameter/2 + wall_thickness, r2 = support_diameter/2);
        }
        
        // Entferne das Innere, aber lasse eine konkave Oberfläche
        translate([0, 0, base_thickness - 0.1])
        cylinder(h = edge_height + 1, r = support_diameter/2 - wall_thickness);
    }
    
    // Konkave Stützfläche - invertierte Sphäre die zur Spiegelform passt
    translate([0, 0, base_thickness]) {
        difference() {
            // Füllzylinder bis zur Randhöhe
            cylinder(h = edge_height, r = support_diameter/2);
            
            // Konkave Aussparung (Sphäre von oben)
            translate([0, 0, edge_height + concave_radius])
            sphere(r = concave_radius);
        }
    }
    
    // Verstärkungsrippen für zusätzliche Stabilität
    for (angle = [0:45:315]) {
        rotate([0, 0, angle])
        translate([0, -wall_thickness/4, base_thickness])
        cube([support_diameter/2 - wall_thickness, wall_thickness/2, edge_height]);
    }
}

// ===== ALTERNATIVE: VEREINFACHTE VERSION =====
// Kommentieren Sie das obige Modell aus und verwenden Sie dieses für eine einfachere Version

module simple_concave_support() {
    difference() {
        union() {
            // Basis
            cylinder(h = base_thickness, r = base_diameter/2);
            
            // Hauptkörper - konischer Übergang
            translate([0, 0, base_thickness])
            cylinder(h = edge_height, r1 = support_diameter/2, r2 = support_diameter/2 - 5);
        }
        
        // Innere konkave Form
        translate([0, 0, base_thickness + edge_height + concave_radius])
        sphere(r = concave_radius);
        
        // Leichtere Konstruktion - Aussparungen im Boden
        for (angle = [0:60:300]) {
            rotate([0, 0, angle])
            translate([support_diameter/3, 0, -0.5])
            cylinder(h = base_thickness + 1, r = 15);
        }
    }
}

// ===== RENDERING =====
// Wählen Sie welches Modell gerendert werden soll

concave_support();  // Haupt-Version mit Rippen
//simple_concave_support();  // Vereinfachte Version

// ===== HINWEISE FÜR DEN DRUCK =====
// 1. Material: PLA oder PETG empfohlen
// 2. Schichthöhe: 0.2mm für gute Balance zwischen Qualität und Geschwindigkeit
// 3. Infill: 20-30% für ausreichende Stabilität
// 4. Supports: Wahrscheinlich nicht nötig bei diesem Design
// 5. Bett-Haftung: Brim empfohlen für große Grundfläche
// 6. Orientierung: Mit der Basis auf dem Druckbett (wie modelliert)
