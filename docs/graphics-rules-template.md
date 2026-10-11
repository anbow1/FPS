# Reguły graficzne — szablon dla nowej gry (three.js, WebGPU + TSL)

> Szablon do skopiowania na start nowego projektu. Uzupełnij pola `‹…›`,
> resztę traktuj jako **obowiązujące reguły** dla ludzi i agentów.
> Źródło: Field Line, Castaway Lagoon i Tanks (anbow1/FPS, anbow1/tanks),
> szczegóły techniczne i kod: `docs/graphics-playbook.md`.

---

## 0. Karta gry (uzupełnij)

| Pole | Wartość |
|---|---|
| Nazwa | ‹…› |
| Gatunek / kamera | ‹FPS / TPP / pojazd / izometria› |
| Świat | ‹rozmiar mapy w m, np. 2 × 2 km› |
| Pora dnia / pogoda | ‹stała / cykl / presety› |
| Docelowe urządzenie | ‹np. telefon z Androidem (APK przez Capacitor) + desktop› |
| Presety jakości | Wysoka / Niska (Niska domyślna na ekranach dotykowych) |
| Budżet — Wysoka | ‹≤ 700 draw calli, ≤ 4 M trójkątów, 60 fps› |
| Budżet — Niska | ‹≤ 450 draw calli, ≤ 2 M trójkątów, 60 fps na telefonie› |
| Referencje wizualne | ‹linki / zrzuty› |

---

## 1. Architektura (nie negocjuj)

1. **Renderer: `WebGPURenderer`** (import z `three/webgpu`) — WebGPU, a bez niego
   jego własny backend WebGL2. Jedna ścieżka kodu, żadnego `WebGLRenderer`.
2. **Shadery tylko w TSL** (`three/tsl`) na materiałach węzłowych
   (`MeshStandardNodeMaterial`, `MeshSSSNodeMaterial`, `MeshBasicNodeMaterial`,
   `SpriteNodeMaterial`). Zakazane: `onBeforeCompile`, `ShaderMaterial`,
   łatki `ShaderChunk`, `EffectComposer`.
3. **Post-processing: jeden `RenderPipeline`**:
   scena HDR (half float, MRT z velocity) → TRAA (każdy preset) → [GTAO (Wysoka)] →
   promienie słońca → bloom → ekspozycja + ACES (AgX jako A/B) + sRGB **raz**,
   na końcu → wyostrzenie (Wysoka 0,3, Niska 0,25). FXAA zostawiało obraz na
   telefonie miękki; velocity i tak jest rysowane.
4. **Reversed depth** (`reversedDepthBuffer: true`), gdy bliska płaszczyzna
   < 0,5 m albo daleka > 2 km. Niebo = głębokość 0.
5. **Wspólne pliki kopiowane 1:1 między grami** (nie forkuj, poprawiaj u
   źródła i kopiuj dalej):
   - `render/perf.ts` — czas GPU na przebieg (inspektor + timestamp query), regulator klatek,
   - `render/benchRecorder.ts` — tabela testu wydajności,
   - `render/warmup.ts` — kompilacja wszystkich shaderów przy ładowaniu,
   - `render/webgpuCompat.ts` — obejście błędu `swizzle` w starszych WebView,
   - `render/impostor.ts` — impostory drzew + dithering przejścia,
   - `render/grassField.ts` — trawa z prawdziwych źdźbeł,
   - `render/rippleField.ts` — interaktywne zmarszczki na wodzie,
   - `render/ocean.ts` — fale wiatrowe FFT (Tessendorf),
   - `render/instanceStream.ts` — instancjonowanie strumieniowe;
   w grach o dużej mapie (lot, pojazdy) także:
   - `render/terrainShadow.ts` — cienie gór i widoczność nieba, liczone raz na GPU,
   - `render/forest.ts` — lasy generowane na GPU z mapy pokrycia terenu,
   - `render/atmosphere.ts`, `render/clouds.ts` — niebo Hillaire'a i chmury wolumetryczne,
   - `render/trails.ts` — wstęgi dymu i smug.
6. **TypeScript strict**, bez `any`, jednostki SI w nazwach (`radiusM`, `dtS`,
   `lux`, `ev100`), komentarze wyjaśniają *dlaczego*.

## 2. Światło i kolor

1. **Jednostki fizyczne**: słońce w luksach, niebo w luksach na poziomie,
   lampy w kandelach, temperatura barwowa w kelwinach.
2. **Ekspozycja z EV100**: `exposure = 1 / (1.2 · 2^EV100)`; **pre-exposure**
   każdego światła przed renderem, żeby FP16 nigdy się nie przepełnił
   (dysk słońca ograniczony).
3. Niebo, mgła i sonda środowiska (PMREM) liczone **tą samą funkcją nieba** —
   horyzont, mgła i odbicia muszą się zgadzać.
4. Mgła = `scene.fogNode` (wysokościowa + rozpraszanie Mie w stronę słońca),
   nigdy biała „mleczna” — kolor z horyzontu nieba.
5. Cienie: `CSMShadowNode` (3 kaskady Wysoka / 2 Niska), cienie chmur
   mnożone w `shadowNode` słońca. Cienie rzuca tylko to, co blisko.
6. Stała liczba świateł od startu gry; zmiana natężenia zamiast
   dodawania/usuwania świateł; `castShadow` nie przełączamy w trakcie gry.
7. Sonda środowiska: przebudowa **do tego samego render targetu**
   (tekstura nie zmienia tożsamości → brak rekompilacji).
8. Paleta materiałów z arkusza PBR (kolor sRGB + roughness + metalness);
   farba, rdza, guma = metalness 0.

## 3. Materiały i tekstury

1. **Proceduralnie** (kanwa / DataTexture / TSL), bez zewnętrznych plików, chyba
   że gra je przewiduje ‹tak/nie›.
2. **≤ 16 próbkowanych tekstur na etap shadera** (telefony tego wymagają).
3. Warstwy terenu w `DataArrayTexture`, mieszanie po wysokości (height blend),
   stochastyczne kafelkowanie na Wysokiej, skała triplanarnie/na płaszczyźnie
   stoku.
4. Wartości wspólne dla wielu węzłów licz **raz** w `colorNode` (w `Fn`) i
   przekazuj przez `property()` (roughness, normalna, ciepło).
5. `Loop`, `If`, `toVar()` tylko wewnątrz `Fn`.
6. **WGSL**: pochodne (`dFdx`, `fwidth`) i próbkowanie z automatycznym LOD
   tylko w jednorodnym przepływie sterowania — licz je przed gałęzią; w
   gałęzi używaj `.grad()`/`.level()`. W shaderze wierzchołków zawsze `.level(0)`.
7. `smoothstep` zawsze z rosnącymi krawędziami (malejące: `1 − smoothstep`).
8. Liście: alpha-test + **utrzymanie alfy w mipmapach**, normalne nieodwrócone
   na tylnych ścianach (`normalViewGeometry`), prześwit (`MeshSSSNodeMaterial`)
   tylko na Wysokiej.
9. Nie klonuj `NodeMaterial` bez przywrócenia `alphaTest` (r186 go gubi).

## 4. Roślinność i odległość (krytyczne dla telefonów)

1. **Jeden `InstancedMesh` na rodzaj rośliny** (strumień odświeżany przy
   zmianie komórki siatki 16–32 m) — nigdy setki meshy per chunk (każdy
   `InstancedMesh` to osobny build shadera i draw call na kaskadę).
2. Poziomy szczegółów drzew: pełne korony blisko ‹110 / 60 m›, lekkie dalej,
   **impostory** od ‹200 / 125 m› (8 widoków, mieszanie dwóch najbliższych,
   jeden draw call na wszystkie gatunki).
3. **Przejście LOD = komplementarny dithering** w paśmie ‹24 m›, ta sama
   odległość per piksel po obu stronach.
4. Małe rośliny zapadają się w ziemię na końcu zasięgu (bez „pykania”).
5. **Trawa z prawdziwych źdźbeł** (`grassField.ts`): kafle 4 m w 3 pierścieniach
   (3 draw calle), kolejność R2 + `drawRange` do przerzedzania, korzenie na
   trójkątach siatki terenu, mapa gęstości, wiatr, deptanie. Na Niskiej
   ‹300› źdźbeł/kafel, zasięg ‹24 m›; dopasuj `widthScale/heightScale` do
   wysokości kamery.
6. Kolizje (kule, pociski) testują **proste kolidery logiki**, nigdy geometrię
   renderu.
7. **Atlas impostorów: tekstury render targetów są adresowane od góry** na obu
   backendach — pień jest przy większym v: `row = (gatunek + 1 − corner.y) / liczba`.
   Sprawdź zbliżenie samych impostorów, nie las z daleka (u nas wszystkie drzewa
   za 200 m stały do góry nogami).
8. **Mapa ≥ 10 km**: lasy generowane na GPU (pierścienie instancji impostorów,
   hash komórki przez `fract(sin(…))` — TSL `hash()` psuje się dla ujemnych),
   gęstość z mapy pokrycia, widok z góry dla wysokiego pułapu. Obiekty gry
   (cele, znajdźki, lądowiska) stawiaj tam, gdzie lasu nie ma — pytając tę samą
   funkcję pokrycia.

## 5. Woda (jeśli jest)

1. Fale przy brzegu z pola odległości od brzegu (eikonal/FMM, liczone przy
   ładowaniu): refrakcja, shoaling, łamanie (γ = 0,78).
2. Optyka: Fresnel (F0 ≈ 0,02), Beer–Lambert per kanał, rozpraszanie w toni,
   refrakcja widoku dna.
3. Swash z mokrym pasem schnącym z opóźnieniem, piana jako tekstura
   „koronki” (nie surowy szum).
4. Kaustyki: rozpryski fotonów (stosunek pól powierzchni) do małego RT,
   próbkowane na dnie — albo, gdy dno widać tylko przez wodę, soczewkowanie
   pierwszego rzędu w shaderze wody (dywergencja nachylenia fali).
5. Daleka / głęboka woda: FFT (przebiegi quad, jeden materiał na etap
   motylkowy, `ocean.ts`) na normalne detalu, dwie kopie łatki w innej skali
   i obrocie; na płyciźnie zostają zmarszczki, z których liczone są kaustyki.
   Geometria z Gerstnerów — wysokość na CPU musi zgadzać się z GPU.
6. **Zmarszczki interaktywne** (`rippleField.ts`): siatka ‹128²› wokół kamery,
   równanie falowe z tłumieniem na CPU (stały krok 30 Hz), ląd trzymany na 0
   (odbicia od brzegu), nachylenia do tekstury RGBA8 — jeden odczyt na piksel.
   Źródła: nogi w wodzie, kadłuby, kule, kamienie, wybuchy; ruch skalowany
   przez `dt·60`. Po uspokojeniu nic się nie liczy ani nie wysyła.

## 6. Płynność — zero przycięć w grze

1. **Wszystkie shadery kompilują się przy ładowaniu**: `revealOnePerPipeline` +
   `compileAsync` (z limitem czasu) + po jednej prawdziwej klatce każdego
   łańcucha postu (i wariantu np. termowizji), **każda w osobnej klatce
   animacji** (przebieg sceny renderuje się raz na klatkę).
2. Instancjonowane meshe napełnione (count ≥ 1) przed pre-kompilacją.
3. Wszystko, co może pojawić się później (broń w kaburze, efekty, deszcz,
   światła nocne), istnieje w scenie od startu.
4. Przełączniki w trakcie gry = **uniformy**, nigdy zmiana grafu węzłów.
5. Brak alokacji w gorących pętlach; odczyty GPU→CPU dławione.
6. Dowód: tracer potoków (`renderer._pipelines`) pokazuje **0 nowych potoków**
   po załadowaniu przy każdej akcji gracza.

## 7. Pomiar i regulacja (od pierwszego dnia)

1. **Stałe punkty testu wydajności** (`app/bench.ts`): spawn, spawn obrócony,
   ‹3–4 najcięższe widoki gry›. Pozycja + kierunek, nic losowego.
2. **Test wydajności**: przycisk w menu pauzy + `?bench` dla skryptu;
   45 klatek na ustabilizowanie, 120 pomiaru; tabela do skopiowania
   (fps, p95, CPU, draw calle, trójkąty, GPU na przebieg).
3. **F3**: fps, ms klatki, poziom regulatora, CPU i GPU na sekcję/przebieg,
   draw calle, trójkąty, EV, backend.
4. **Regulator klatek** (`FrameGovernor`): najpierw efekty (AO, promienie),
   potem skala renderu 100 → 58 % (42 % na telefonach renderujących w 2×); w górę powoli, bez oscylacji; krok bez
   zysku jest cofany. Przełącznik „Adaptacyjna rozdzielczość” w ustawieniach.
5. Każda zmiana wydajności: **liczby przed i po w tych samych punktach**
   (`scripts/benchView.mjs --save before` / `--compare before`).

## 8. Presety jakości (wypełnij liczby)

| Ustawienie | Wysoka | Niska |
|---|---|---|
| Pixel ratio | urządzenie × skala (2 na dotyku) | 2 na dotyku (preset „Szybka”: 1) |
| TRAA / GTAO / wyostrzenie | tak / tak / 0,3 | tak / nie / 0,25 |
| Dno regulatora (skala renderu) | 0,58 | 0,42 |
| Promienie słońca | ‹24–40› próbek | ‹0–12› |
| Kaskady cieni × rozmiar | 3 × ‹2048› | 2 × ‹1024› |
| Prześwit liści | tak | nie |
| Korony blisko / impostory od | ‹110 / 200 m› | ‹60 / 125 m› |
| Trawa: źdźbła/kafel, zasięg | ‹700, 40 m› | ‹300, 24 m› |
| Kaustyki RT | 256² | 128² |
| Sonda środowiska | 256 px | 128 px |

## 9. Weryfikacja każdej zmiany

1. `tsc --noEmit` + testy jednostkowe.
2. Build produkcyjny serwowany statycznie (nie dev server).
3. Headless Chromium: WebGL2 przez SwiftShader **i** WebGPU programowe
   (`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader
   --use-webgpu-adapter=swiftshader`; gdy urządzenie ginie przy konfiguracji
   canvasa — skrypt `--no-present`).
4. Obejrzyj zrzut ekranu; dla ruchomych rzeczy kilka zrzutów w odstępach.
   Emulacja telefonu (`deviceScaleFactor: 3, isMobile, hasTouch`): canvas ma
   mieć 2× szerokość CSS.
   Zachowania lotu i jazdy **nie** oceniaj w headless (SwiftShader liczy kilka
   klatek na sekundę, więc symulacja biegnie wielokrotnie wolniej) — testuj je
   w testach jednostkowych symulacji.
5. Zero błędów w konsoli; liczby z testu wydajności w opisie commita.
6. Na końcu: test wydajności na docelowym telefonie (jedyne prawdziwe liczby).

## 10. Lista kontrolna odbioru sceny

- [ ] Kontrast i nasycenie jak w referencji, niebo niebieskie, bez mleka.
- [ ] Cienie ostre blisko, miękną z odległością; brak „pływania”.
- [ ] Brak „pykania” LOD, roślin, trawy przy ruchu kamery.
- [ ] Brak migotania/aliasingu na liściach i kraty na odległość.
- [ ] Woda: przejście płytko → głęboko, piana tylko na brzegu, kaustyki na dnie.
- [ ] Budżety presetów dotrzymane w każdym punkcie testu.
- [ ] 0 nowych potoków po załadowaniu.
- [ ] Wysoka i Niska wyglądają spójnie (Niska prostsza, nie inna).

## 10b. Sterowanie (pojazdy, samoloty, śmigłowce)

Fizyka zostaje prawdziwa; sterowanie decyduje, czy da się latać. Każdy punkt
wynika ze skargi gracza.

- **Klawisze nigdy się nie odwracają**: W = nos w dół / do przodu, S = nos w
  górę. Odwracanie dotyczy tylko drążka na ekranie.
- **A/D skręcają** (w zawisie głównie obrót, z prędkością zakręt z
  przechyleniem); Q/E to pedały (czysty obrót).
- Gdy gra ma broń, **mysz celuje, a nie steruje lotem** — przesuwa celownik
  po ekranie, kamera zostaje przy pojeździe. Na dotyku prawy kciuk tylko
  celuje, nigdy nie dokłada się do drążka.
- **Komputer lotu domyślnie włączony** (wyłączalny): utrzymanie położenia,
  kursu (śmigło ogonowe ze sprzężeniem w przód od momentu wirnika) i
  **wysokości z neutralną pozycją dźwigni mocy** — poniżej kreski opadanie, na
  kresce trzymanie wysokości, powyżej wznoszenie. Limit momentu, ochrona przed
  pierścieniem wirowym przy małej prędkości, miękkie przyziemienie. Dźwignia
  na dotyku wraca na kreskę po puszczeniu.
- Broń stała (rakiety niekierowane) leci **w osi pojazdu**, nie znoszona przez
  jego dryf; znacznik balistyczny liczony tym samym integratorem co pociski.
- Sterowanie przechyłem telefonu włączane w trakcie gry (TILT + kalibracja).
- Wyświetlacze w kabinie: stała jasność, mipmapy, nigdy w tej samej płaszczyźnie
  co ramka (migotanie).

## 11. Specyfika tej gry (uzupełnij)

- Styl / nastrój: ‹…›
- Kluczowe materiały: ‹…›
- Własne efekty (np. termowizja, luneta, pogoda): ‹…› — zawsze jako uniformy
  w istniejącym łańcuchu, skompilowane przy ładowaniu.
- Odstępstwa od reguł (z uzasadnieniem): ‹…›
