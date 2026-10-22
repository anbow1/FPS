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
