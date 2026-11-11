# Wyniki testów

Dziennik pomiarów i sprawdzeń, od najnowszych. Każdy wpis ma: datę, commit, czym mierzono, liczby
przed i po, zrzuty. Surowe pliki z pomiarów leżą w folderze z datą obok (JSON z `tools/measure/load.mjs
--json` i `field-line/scripts/benchView.mjs --save`, porównania zrzutów jako JPG: przed | po |
różnica ×8).

**Jak dopisać wpis** (każdy model, każda zmiana mierzona): nowy rozdział na górze, tabela przed/po,
folder `RRRR-MM-DD/<temat>/` z plikami JSON (`load.mjs --json <plik>`) i zrzutami. Liczby z programowego
GPU (SwiftShader) porównują przebiegi na jednej maszynie; prawdziwe są z telefonu (Benchmark w grze,
„Loaded in X s”) — wpisuj je, gdy użytkownik je poda, z modelem telefonu.

**Zasady pomiaru** (z tych testów):

- Przebiegi przed/po **na przemian** (przed, po, po, przed): maszyna zwalnia w serii; stała kolejność raz
  pokazała 5 % straty, którą odwrócona zamieniła w zysk.
- Tekstury KTX2 mierz z `--hide-features texture-compression-astc,texture-compression-etc2`: SwiftShader
  dekoduje ASTC i ETC2 przy każdym odczycie (tabela niżej) i zawyża czas.
- `benchView.mjs --gpu webgpu --no-present`: bez `--no-present` urządzenie WebGPU ginie i wiersze mają 0.
- Pełna gra na WebGL2 w trybie bezgłowym nie dochodzi do „ready” w 7 min (z KTX2 i bez) — zaplecze
  WebGL sprawdzaj na stronie testowej z jedną teksturą.

---

## 2026-11-11 · Lagoon: cienie głazów i pni dżungli z uproszczonych siatek

Sonda `passes.mjs --game castaway-lagoon`: na High 8,49 z 13,42 mln trójkątów w cieniach (3 kaskady);
największe: paprocie 2,7 M (cień zależy od wycięcia liści — bez zmian), pnie dżungli 1,45 M, głazy
~0,9 M. Zastępcze siatki tylko dla kaskad: głazy (`shadow_mesh.mjs`, błąd 1 % dla dużych, 2 % dla
kamieni: 2400 → 714–1854, 900 → 232–328 trójkątów), pnie dżungli generowane razem z widocznymi (ten sam
los, połowa pierścieni, 6 boków zamiast 9, te same atrybuty kołysania).

| | High przed | High po | Low przed | Low po |
|---|---|---|---|---|
| Trójkąty w klatce | 13,42 M | 12,19 M | 5,39 M | 4,57 M |
| — w cieniach | 8,49 M | 7,26 M | 2,93 M | 2,11 M |
| Wywołania | 720 | 720 | 472 | 472 |
| Potoki | 271 | 271 | | |
| Pamięć tekstur | 380,4 MB | 380,4 MB | | |
| GPU idle (na przemian) | 136,2 / 131,8 s | 122,8 / 124,3 s | | |
| Build | 36,81 MB | 36,91 MB | | |

Zrzuty (`2026-11-11/lagoon-cienie/`): zatoka i dżungla z cieniami pni na zboczu — bez różnicy poza
roślinnością i wodą w ruchu.

## 2026-11-11 · Las: cienie skanów (skały, pnie, kłoda) z uproszczonych siatek

Sonda `passes.mjs` (las, start): z 7,66 mln trójkątów na High 5,02 mln w cieniach; skany z całej mapy
(skały 1,0 M, pnie 1,0 M, kłoda 0,6 M) w każdej kaskadzie. Zastępcze siatki cienia
(`tools/assets/shadow_mesh.mjs`, meshoptimizer, błąd ≤ 2 % rozmiaru: 1500–2500 → 256–847 trójkątów,
pliki `*_shadow.bin`, razem 97 KB) na warstwie tylko dla kaskad; widoczne skany bez zmian.

| | High przed | High po | Low przed | Low po |
|---|---|---|---|---|
| Trójkąty w klatce | 7,66 M | 5,69 M | 3,47 M | 2,64 M |
| — w cieniach | 5,02 M | 3,05 M | 1,84 M | 1,01 M |
| Wywołania | 202 | 199 | 123 | 123 |
| Potoki | 171 | 171 | | |
| Pamięć tekstur | 254,4 MB | 254,4 MB | | |
| GPU idle (na przemian) | 171,6 / 166,5 s | 165,1 / 172,4 s | | |
| Build | 77,26 MB | 77,36 MB | | |

Zrzuty (`2026-11-11/las-cienie-skanow/`): pień z bliska z cieniem — sylwetka i cień te same; różnica
pikseli duża (8,9/255), bo plamy słońca spod koron poruszanych wiatrem są w innym miejscu w każdym
przebiegu (czas gry do zrzutu różni się o kilkanaście sekund). Granica geometryczna: stand-in odbiega od
skanu najwyżej o 2 % jego rozmiaru (~2 cm na pniu metrowej wysokości, mniej niż teksel bliskiej kaskady).

## 2026-11-11 · Cienie dalekich aut z lod2 (Etap 1b, Field Line, miasto)

Sonda `tools/measure/passes.mjs` (wywołania i trójkąty na przejście): z 16,5 mln trójkątów klatki na High
13,5 mln szło na przejścia cieni (4 kaskady słońca + cień latarki broni), z tego 9 mln to dalekie
zaparkowane auta (`lod1`, każde auto na mapie w każdej kaskadzie). `lod2` (1/3 trójkątów `lod1`) leżał
nieużywany.

**Próba 1 — widoczny trzeci poziom** (`lod2` dalej niż 120 m, z poprawką na lunetę): trójkąty 16,5 →
10,6 mln, ale wywołania 742 → 913 (każdy poziom = część × przejście × model). Z odrzucaniem po sferze
instancji: 854. **Odrzucona** (więcej wywołań, reguła 2 wytycznych).

**Wersja przyjęta — `lod2` tylko w cieniu**: w kadrze bez zmian (`lod0` / `lod1`), dalekie `lod1` nie
rzuca cienia, rzuca go `lod2` na warstwie widocznej tylko dla kamer kaskad (`render/layers.ts`); na Low
(jeden zestaw aut) cień każdego auta z `lod2`. Materiał zastępcy = materiał `lod1` (inaczej +18 tekstur,
+1,5 MB).

| | High przed | High po | Low przed | Low po |
|---|---|---|---|---|
| Trójkąty w klatce (spawn) | 16,50 M | 9,66 M | 8,27 M | 5,64 M |
| — w kadrze | 3,04 M | 3,04 M | 2,99 M | 2,99 M |
| — w cieniach | 13,46 M | 6,62 M | 5,28 M | 2,65 M |
| Wywołania rysowania | 742 | 715 | 328 | 328 |
| Potoki | 205 | 205 | 167 | 167 |
| Pamięć tekstur | 469,9 MB | 469,9 MB | 233,2 MB | 233,2 MB |
| GPU idle (przebiegi przed / po na przemian) | 171,6 / 169,3 / 193,8 s | 162,2 / 170,8 / 187,6 s | 121,5 s | 118,2 s |
| Build | 75,6 MB | 77,3 MB (+ pliki `lod2`) | | |

Zrzuty (`2026-11-11/auta-cien-lod2/`): auta przy ulicy z cieniami bez różnicy (`auta-ulica-high.jpg`),
auto z bliska na Low 0,19/255 (`auto-z-bliska-low.jpg`); na placu różnice tylko w koronach drzew na
wietrze (`plac-high.jpg`). Host był tego dnia wolniejszy (obciążenie ~2,8 bez pracy), stąd wyższe sekundy
niż 2026-11-10 — porównuj tylko pary z tego samego dnia.

 (commit 136f8ee)

Narzędzie `tools/assets/ktx2_glb.mjs`, tryb `auto` (ETC1S, poniżej 40 dB UASTC; broń 45 dB), mapy
normalnych zawsze UASTC. Wszystkie gry biorą loader z `render/gltf.ts`.

**Szacunek przed decyzją** (pamięć GPU na telefonie, ASTC/ETC2; pliki: tylko tekstury):

| Model | Pamięć GPU | Tekstury w pliku | Zostaje w KTX2 (≥ 10 MB na 1 MB) |
|---|---|---|---|
| carbine_ar | 32,0 → 8,0 MB | 1,49 → 5,96 MB | nie |
| knife_clip | 16,0 → 4,0 | 0,54 → 2,62 | nie |
| pistol_9mm | 48,0 → 10,0 | 0,55 → 2,92 | tak |
| rifle_ak | 64,0 → 16,0 | 1,56 → 7,48 | nie |
| rifle_bolt | 64,0 → 16,0 | 2,15 → 10,02 | nie |
| boat_cutter | 58,7 → 14,7 | 1,07 → 5,22 | tak |
| boat_skiff | 64,0 → 16,0 | 1,63 → 7,67 | nie |
| cargo_truck | 32,0 → 6,7 | 1,17 → 3,29 | tak |
| heli_bulat | 26,7 → 6,7 | 0,65 → 3,52 | nie |
| heli_warden | 32,0 → 5,3 | 1,00 → 1,89 | nie (zmierzone w grze: −8 MB za +1,6 MB) |
| ifv_east | 42,7 → 10,7 | 1,69 → 6,34 | nie |
| ifv_west | 27,0 → 4,1 | 0,65 → 1,28 | tak |
| jeep_open | 25,3 → 3,7 | 0,88 → 1,24 | tak |
| jet_talon | 88,0 → 19,3 | 1,38 → 7,47 | tak |
| jet_wraith | 53,3 → 10,0 | 0,22 → 0,23 | tak |
| mbt_east | 26,7 → 6,0 | 0,80 → 3,24 | nie |
| mbt_west | 30,8 → 5,2 | 1,43 → 2,58 | tak |
| staff_car | 48,0 → 10,7 | 3,14 → 5,40 | tak |
| sport (lod0/1/2) | 99,1 → 15,7 | 1,71 → 2,11 | tak |

Mocniejsze RDO prawie nie zmniejsza UASTC (kuter: RDO 1 → 3 → 6: 5,35 → 4,89 → 4,62 MB tekstur).

**Wszystkie modele w KTX2** (pomiar przed decyzją użytkownika; WebGPU programowy, formaty BC, przebiegi
przed / po / po / przed, `gpu idle`):

| Gra | Pamięć tekstur | GPU idle przed | GPU idle po | Build |
|---|---|---|---|---|
| Field Line (strzelnica, High) | 234 → 126 MB | 61,9 / 61,8 s | 62,2 / 61,6 s | 73,1 → 88,5 MB |
| Castaway Lagoon (High) | 438 → 288 MB | 109,4 / 99,0 s | 105,0 / 102,8 s | 32,1 → 51,5 MB |
| Tanks (High) | 179 → 65 MB | 91,7 / 93,5 s | 97,3 / 93,8 s | 35,2 → 49,1 MB |
| Contrail (High) | 184 → 94 MB | 30,2 / 29,6 s | 31,2 / 32,6 s | 21,8 → 28,9 MB |
| Ridgeline (High) | 85 → 77 MB | 34,9 / 36,7 s | 34,9 / 37,6 s | 7,9 → 12,5 MB |

**Wypchnięty wariant** (reguła użytkownika: ≥ 10 MB pamięci na 1 MB pliku; jeden przebieg po):

| Gra | Pamięć tekstur | Build | Ostrzeżenia „did not load” |
|---|---|---|---|
| Field Line (strzelnica, High) | 234 → 198 MB | 73,1 → 75,6 MB | 0 |
| Castaway Lagoon (High) | 438 → 380 MB | 32,1 → 36,8 MB | 0 |
| Tanks (High) | 179 → 97 MB | 35,2 → 41,6 MB | 0 |
| Contrail (High) | 184 → 94 MB | 21,8 → 28,9 MB | 0 |
| Ridgeline | bez zmian | bez zmian | — |

Zrzuty (1280×720, ten sam widok przed/po): różnice tylko w poruszającej się roślinności —
`2026-11-10/zrzuty/fl-karabinek.jpg` (średnia różnica 1,5/255), `lagoon-start.jpg` (2,2/255, palmy),
`tanks-wioska.jpg` (3,5/255, drzewa i trawa), `contrail-poscig.jpg` (0,07/255).

Contrail: pierwsze klatki +2 s (wczytywanie 5,3 / 4,8 s → 5,5 / 5,9 s, reszta w rozgrzewce). Przyczyna
prawdopodobna: SwiftShader próbkuje BC7 o 27 % wolniej, a myśliwiec wypełnia kadr. Do potwierdzenia na
telefonie.

## 2026-11-10 · Programowy GPU a tekstury skompresowane (mikrotest)

Strona testowa: 12 tekstur 2048² z pełnymi mipmapami, wysyłka, potem 12 rysowań na cel 1024²
(SwiftShader, WebGPU). Czasy w ms:

| Format | Wysyłka | Próbkowanie |
|---|---|---|
| RGBA8 (dwa przebiegi) | 333 / 230 | 204 / 191 |
| ASTC 4×4 | 85 | 580 |
| ETC2 RGB8 | 58 | 549 |
| BC7 | 79 | 255 |

Wniosek: na programowym GPU ASTC/ETC2 są 2,8× wolniejsze przy odczycie; telefon dekoduje je sprzętowo.

## 2026-11-10 · Samochody w mieście i atlasy Lagoon / Tanks (commit e98fb53)

WebGPU programowy, formaty BC (`--hide-features`), przebiegi na przemian; pliki: `2026-11-10/ktx2-ab/`.

| | Pamięć tekstur | GPU idle przed | GPU idle po | Build |
|---|---|---|---|---|
| Field Line miasto, High | 1265 → 506 MB (432 MB z ASTC/ETC2) | 125,5 / 126,7 s | 121,2 / 127,5 s | 65,7 → 73,1 MB |
| Field Line miasto, Low | 320 → 262 MB | — | 87,7 s (jeden, ASTC) | |
| Castaway Lagoon, High | 540 → 438 MB | 85,7 / 91,2 / 98,2 / 98,7 s | 92,2 / 93,8 / 97,0 / 95,2 s | 34,0 → 32,1 MB |
| Tanks, High | 185 → 179 MB | 88,4 / 86,8 s | 81,7 / 84,4 s | 34,9 → 35,2 MB |

Pierwszy pomiar miasta z ASTC (bez `--hide-features`): GPU idle 116,3 / 123,1 → 128,6 / 125,6 s —
spowolnienie programowego GPU, nie gry (mikrotest wyżej).

Jakość tekstur aut (RGB PSNR po zdekodowaniu, sedan lod0): nadwozie ETC1S 42,3 dB, reflektory ETC1S 28,6
→ UASTC 37,6 dB, szorstkość kół ETC1S 35,8 → UASTC 54,0 dB. Auto z 3–5 m przed/po: średnia różnica
0,76/255 (High), 0,69/255 (Low), różnice tylko na krawędziach (`zrzuty/auto-miasto-high.jpg`, `-low.jpg`).

## 2026-11-10 · Atlasy postaci Field Line w KTX2 (commit c97e515)

| | Przed | Po |
|---|---|---|
| Las High, pamięć tekstur | 392 MB | 290 MB |
| Las Low | 264 MB | 258 MB |
| Strzelnica High / Low | 336 / 207 MB | 234 / 201 MB |
| Strzelnica ready / GPU idle | 28,0 / 56,9 s | 28,3 / 55,1 s |
| Las High ready / GPU idle (dwie rundy) | 115,0 / 151,4 s; 55,5 / 133,6 s | 105,2 / 141,4 s; 49,6 / 104,1 s |
| Potoki | 170 | 170 |

Format atlasu (karabinier, RGB PSNR, plik): ETC1S q200 35–36 dB 0,37 MB; UASTC 48–50 dB 2,0 MB;
UASTC + RDO 1 45,6 dB 1,65 MB (wybrany); RDO 2 43,3 dB 1,54 MB; RDO 4 41,1 dB 1,44 MB.
WebGL2: strona z jednym atlasem pokazuje to samo co WebGPU (`zrzuty/atlas-webgl2.jpg`; UASTC → ASTC 4×4,
ETC1S → ETC2).

## 2026-11-10 · Etap 0: punkt odniesienia (commit da9cd6e i c97e515)

WebGPU programowy; pliki: `2026-11-10/etap0-load/` i `etap0-bench/`.

| Gra / mapa | Potoki High / Low | Ready / GPU idle High | Ready / GPU idle Low | Tekstury High / Low | Cele renderowania High / Low |
|---|---|---|---|---|---|
| Field Line strzelnica | 156 / 118 | 30,7 / 60,2 s | 25,3 / 40,1 s | 336 / 207 MB | 175 / 52 MB |
| Field Line las | 170 / 129 | 56,8 / 114,8 s | 39,5 / 66,6 s | 392 / 264 MB | — |
| Field Line miasto | 204 / 166 | 113,6 / 128,4 s | 90,1 / 103,4 s | 1265 / 320 MB | 179 / — MB |
| Castaway Lagoon | 268 / 233 | 79,9 / 93,5 s | 65,1 / 70,8 s | 540 / 411 MB | 454 / 56 MB |
| Tanks | 321 / 171 | 72,0 / 94,2 s | 43,6 / 50,5 s | 185 / 184 MB | 156 / 55 MB |
| Contrail | 69 / 64 | 24,0 / 29,6 s | 18,3 / 21,6 s | 184 / 184 MB | 95 / 74 MB |
| Ridgeline | 64 / 62 | 31,3 / 38,3 s | 22,4 / 25,4 s | 85 / 77 MB | 117 / 82 MB |

Draw calle i trójkąty Field Line (punkty testu wydajności):

| Mapa | High: wywołania | High: trójkąty | Low: wywołania | Low: trójkąty |
|---|---|---|---|---|
| strzelnica | 146 / 105 | 1,16 M | 107 / 77 | 0,49 M |
| las | 167–224 | 6,8–8,3 M | 103–123 | 3,0–3,5 M |
| miasto | 573–742 | 15,9–16,5 M | 288–328 | 8,2–8,3 M |

Znane błędy przy okazji: Tanks High loguje błąd WGSL („structures must have at least one member”,
potok `MeshBasicNodeMaterial`) — także przed zmianami tego etapu.

## Telefon

Brak wyników. Do zebrania: APK #127 — Benchmark w grze i „Loaded in X s” w Field Line (miasto), Lagoon,
Tanks i Contrail; widoczność pojazdów, broni i łodzi.
