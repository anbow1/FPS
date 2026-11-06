# Pojazdy z gotowych modeli (Sketchfab CC-BY / CC0, Poly Haven, BlenderKit free)

`prepare_vehicle.py` zamienia pobrany model w pojazd gotowy dla gier: metry,
oś Y w górę, przód w stronę −Z, środek na ziemi pod środkiem rozstawu osi;
koła wydzielone i wycentrowane na osiach (`wheel_FL/FR/RL/RR` — gra je obraca),
światła zebrane w `lights_head` / `lights_rear` (światła stopu i reflektory),
reszta w `body`; poziomy LOD przez decymację symetryczną względem X, AO
wypalone Cyclesem (OptiX na RTX) w kolor wierzchołków `ao`, tekstury
przeskalowane, glTF z kompresją Draco.

```bat
blender -b --python prepare_vehicle.py -- C:\modele\hatchback.glb --out out\hatchback --length 4.05 --forward -y --preview
```

- `--length` — prawdziwa długość pojazdu w metrach (modele bywają w cm albo w skali zabawki),
- `--forward` — oś, w którą patrzy przód modelu w Blenderze po imporcie (`x`, `-x`, `y`, `-y`);
  sprawdź na podglądzie (`out\hatchback_preview.png`): przód ma być po prawej stronie u dołu kadru,
- `--wheels`, `--lights` — słowa w nazwach obiektów lub materiałów kół i świateł, jeśli
  model używa innych (np. `--wheels "koło,wheel_"`); bez nazw skrypt szuka czterech okrągłych
  części przy narożnikach,
- `--lod 60000,15000,3000` — budżety trójkątów nadwozia (koła po 1/6, światła po 1/10),
- `--tex 2048` — maksymalny rozmiar tekstur.
- `--tex-far 512` — rozmiar tekstur `lod1` (każdy dalszy poziom o połowę); domyślnie połowa `--tex`.
- `--part "bonnet:x0,y0,z0,x1,y1,z1,min"` — luźne elementy leżące całe w pudełku (układ gry, metry) i dłuższe
  niż `min` jako osobny węzeł (maska, drzwi), który gra obraca na zawiasie; opcję można powtórzyć.

Jeep z Castaway Lagoon (gwiazda, numery i tabliczka najpierw zamalowane w kolorze **i** w mapie
chropowatości — tam też były):

```bat
python -I scrub_marks.py tex\jeep.001_baseColor.png tex\jeep.001_baseColor.png --circle 3590,2200,168 --rect 3138,2100,3248,2490 --rect 3895,2140,4030,2490 --grain-patch 3250,2290,3400,2420
python -I scrub_marks.py tex\jeep.001_metallicRoughness.png tex\jeep.001_metallicRoughness.png --circle 449,275,23 --rect 391,261,407,312 --rect 486,266,505,312 --grain-patch 407,286,425,302
blender -b --python prepare_vehicle.py -- jeep\scene.gltf --out out\jeep_open --length 3.36 --forward=x --lod 12000 --tex 2048 --part "bonnet:-0.54,0.9,-1.42,0.58,1.09,-0.57,0.8" --preview
```

Cały proces od pobrania do gry (licencja, rozpakowanie, oznaczenia, Blender, podgląd, napisy, kod, render,
APK) opisuje `docs/graphics-playbook.md`, §6q2.

Wynik: `out\hatchback_lod0.glb`, `_lod1.glb`, `_lod2.glb` i `out\hatchback.json`
(wymiary, środki i promienie kół, rozstaw osi). **Wpisz do `.json` autora, adres
strony i licencję** — CC-BY wymaga podpisu w grze (w napisach / README gry).

## Co szukać (realizm, bez marek)

Modele z logo i nazwami producentów trzeba „odmarkowić” (zdjąć znaczki, zmienić
napisy) — gry używają wymyślonych pojazdów. Na Sketchfabie filtr: *Downloadable*,
licencja *CC Attribution* lub *CC0*, najlepiej 50–300 tys. trójkątów z teksturami PBR.

| Gra | Pojazdy |
| --- | --- |
| Paris | europejski hatchback i kombi, taksówka (sedan), miejski autobus niskopodłogowy, furgonetka dostawcza, skuter, rower miejski |
| Field Line | sedan, pickup, furgonetka, ciężarówka skrzyniowa, wrak samochodu, karetka bez oznaczeń |
| Tanks | czołg podstawowy, BWP, ciężarówka wojskowa, wraki (oznaczenia wymyślone) |

## Ciężarówki (Tanks: dekoracja do zniszczenia)

`prepare_truck.py` — jedna bryła `body` z kołami (gra nie jeździ ciężarówkami, więc dowolna liczba osi),
skala, orientacja, normalne na zewnątrz, decymacja, AO jak przy czołgach; zostawia tylko kolor bazowy
(z alfą) i mapę normalnych. Prawdziwe oznaczenia najpierw zamalować `scrub_marks.py`:

```bat
python -I scrub_marks.py tex\Material2_baseColor.jpeg tex\Material2_baseColor.jpeg --circle 1824,1359,80 --circle 1824,1769,80 --grain-patch 1790,1220,1930,1290
python -I scrub_marks.py tex\Material_baseColor.png tex\Material_baseColor.png --rect 946,1568,1046,1622 --rect 1442,1670,1494,1770
python -I scrub_marks.py m939\textures\Body1Mtl_baseColor.png m939\textures\Body1Mtl_baseColor.png --rect 543,412,598,460 --grain-from 0,60
blender -b --python prepare_truck.py -- military_truck\scene.gltf --out out\staff_car --length 5.6 --forward=-x --triangles 18000 --preview
blender -b --python prepare_truck.py -- m939\scene.gltf --out out\cargo_truck --length 7.75 --forward=-x --preview
```

(`--forward=-x` ze znakiem równości: argparse bierze samo `-x` za opcję.)

## Śmigłowce i myśliwce: opcje dla trudniejszych modeli

`prepare_heli.py`:
- `--glass glass,mirror` — słowa w nazwach materiałów szyb kabiny,
- `--gun-object Object_20` — działko wymodelowane w pozie skręconej (klatka animacji): skrypt prostuje
  je wokół środka wieżyczki (oś główna wierzchołków),
- `--eyes gz,gy,pz,py` — oczy strzelca i pilota (z, y), gdy szyba nie dzieli się na dwie sekcje,
- `--stores "pod x,y,z,przód;launcher x,y,z,długość"` — zasobniki i zamknięte wyrzutnie wtopione
  w kadłub (lustrzane na obie strony), zmierzone na pliku z pierwszego przebiegu.
- obiekty bez żadnego materiału (pomocnicze sfery, bryły kolizji) są pomijane.

```bat
blender -b --python prepare_heli.py -- mi28\scene.gltf --out out\heli_bulat --rotor-radius 8.6 --forward=-y --glass glass,mirror --gun-object Object_20 --eyes=-2.8,2.72,-1.0,3.17 --stores "pod 1.745,1.24,0.85,0.09;launcher 2.92,1.98,0.75,1.42"
```

`prepare_jet.py`:
- `--glass` — słowa w nazwie materiału owiewki (domyślnie paleta F-35),
- `--drop landingon` — części do pominięcia po nazwie (z dziećmi), np. drugie, wypuszczone podwozie,
- `--no-surfaces` — stery nie są osobnymi bryłami: zostają w kadłubie,
- `--engines 2` — dwie dysze obok siebie,
- `--main-gear-z 1.6` — przesuwa model wzdłuż, by koła główne stały tam, gdzie w modelu lotu,
- `--surfaces "stab=elevator;flaperon=aileron,flap;rudder=rudder"` — stery po nazwach części (strona
  według położenia); tak nazwany ster kierunku to cały ruchomy statecznik (oś przez 30 % cięciwy).

```bat
blender -b --python prepare_jet.py -- su57\scene.gltf --out out\jet_talon --length 21.9 --forward=-y --glass glass --drop gear_down,probe_on --surfaces "stab=elevator;flaperon=aileron,flap;rudder=rudder" --engines 2 --main-gear-z 1.6
```
