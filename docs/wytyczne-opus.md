# Wytyczne dla modelu Opus — prace rutynowe w repozytorium FPS

Ten plik spisuje zadania, które **nie wymagają mocniejszego modelu**: są
opisane krok po kroku, mają kryterium odbioru i sposób pomiaru. Mocniejszy
model (Fable) zostaje do projektowania nowych technik, sporów o ocenę obrazu i
debugowania wnętrza three.js — lista w §5.

Plany, do których te zadania należą: `docs/przebudowa-gier-aaa.md`
(przebudowa pięciu gier, etapy 0–5) i `docs/nowa-gra-aaa.md` (nowa gra, etapy
0–8). Oba mają tabelę „podział pracy między modele”: to, co stoi w kolumnie
lżejszego modelu, wykonujesz wg §1 i §2 tego pliku.

**Jak użyć:** pierwsza wiadomość do modelu:

> Przeczytaj `AGENT.md`, `games-ts-threejs.md` i `docs/wytyczne-opus.md`.
> Wykonaj zadanie `<numer>` z §3 (albo §4) dokładnie według §1 i §2. Odpowiadaj po polsku.

---

## 1. Zasady stałe (obowiązują w każdym zadaniu)

1. **Gałąź** `claude/tropical-lagoon-game-h5b2h5`. Po każdym zakończonym kroku:
   commit, `git push -u origin claude/tropical-lagoon-game-h5b2h5`, potem
   `git fetch origin main && git push origin HEAD:main` (gdy `origin/main` jest
   przodkiem; inaczej najpierw `git merge origin/main`). Wypchnięcie na `main`
   buduje APK (`.github/workflows/android.yml`) — sprawdź, że przebieg się
   powiódł. Bez force-push, bez PR, chyba że użytkownik poprosi.
2. **Warunek użytkownika: żadna zmiana nie może zwiększyć obciążenia** (czasu
   klatki, czasu ładowania, pamięci). Dozwolone bez pytania są tylko zmiany,
   które nie dodają: przebiegu renderowania, tekstury, światła, draw calla,
   materiału ani potoku (pipeline). Zmiana stałych, kolorów, wag i wzorów w
   istniejącym shaderze jest w porządku, o ile nie dodaje próbkowania tekstury.
   Wszystko inne: opisz zysk i koszt, zapytaj.
3. **Dowód zamiast opinii.** Każda zmiana obrazu: zrzut przed i po w tych samych
   widokach. Każda zmiana, która dotyka materiałów, instancji, tekstur lub
   kamer: liczba potoków i draw calli przed i po (§2). „Powinno działać” nie
   jest wynikiem.
4. TypeScript strict, bez `any`; komentarze tłumaczą **dlaczego** (z liczbą z
   pomiaru, jeśli była); jednostki w nazwach. Kod i komentarze po angielsku,
   jak reszta repozytorium.
5. **Nie edytuj plików, które serwuje działający serwer deweloperski Vite** w
   trakcie pomiaru. Mierz build (`tools/measure/serve.mjs`).
6. Tylko wymyślone marki i oznaczenia; modele i tekstury wyłącznie CC0 / CC BY
   z wpisem w `shared/*/CREDITS.md`; licencję NC zgłoś użytkownikowi i nie używaj.
7. Pobrane pliki są niezaufane: każdy rozpakuj do własnego pustego katalogu,
   Pythona uruchamiaj z `-I`, skrypty trzymaj w innym katalogu.
8. Pliki wspólne (`render/warmup.ts`, `render/instancing.ts`, `render/perf.ts`,
   `render/benchRecorder.ts`, `render/webgpuCompat.ts`, `core/noise.ts`) są
   **identyczne we wszystkich grach**: poprawkę robisz w jednej i kopiujesz do
   pozostałych w tym samym commicie (`diff` ma nic nie pokazać).
9. Po każdej zmianie `docs/graphics-playbook.md`, `docs/graphics-rules-template.md`,
   `tools/measure/`, skryptów Blendera albo pliku wspólnego:
   `bash docs/model-kit/sync.sh` i commit kopii razem ze zmianą.

## 2. Procedura standardowa (kopiuj polecenia)

```bash
export PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright/index.mjs   # w chmurze; lokalnie: npm i -D playwright
G=castaway-lagoon                      # field-line | castaway-lagoon | tanks | contrail | ridgeline
OUT=/tmp/measure/$G && mkdir -p $OUT

# 1. stan wyjściowy
(cd $G && npx tsc --noEmit -p . && npx vite build --base ./ --outDir $OUT/dist-before --emptyOutDir)
node tools/measure/serve.mjs $OUT/dist-before 4173 &
node tools/measure/shots.mjs --game $G --out $OUT/before --views '<WIDOKI z zadania>'
node tools/measure/load.mjs  --game $G --json $OUT/load-before.json
kill %1

# 2. zmiana w kodzie, potem to samo z "after"
(cd $G && npx tsc --noEmit -p . && npx vitest run && npx vite build --base ./ --outDir $OUT/dist-after --emptyOutDir)
node tools/measure/serve.mjs $OUT/dist-after 4173 &
node tools/measure/shots.mjs --game $G --out $OUT/after --views '<te same WIDOKI>'
node tools/measure/load.mjs  --game $G --json $OUT/load-after.json
kill %1
```

- **Obejrzyj** oba zrzuty (narzędzie Read na plikach PNG). Jeśli „po” nie jest
  wyraźnie lepsze albo psuje coś obok — cofnij zmianę, nie poprawiaj na siłę.
- **Porównaj** w `load-*.json`: liczba potoków (`pipelines`) i modułów nie może
  wzrosnąć; `gpu idle` nie może wzrosnąć ponad szum (±5 %).
- Draw calle i trójkąty: `node $G/scripts/benchView.mjs --save before` /
  `--save after --compare before` (Field Line, Lagoon, Tanks). Liczby mają być
  równe.
- Adaptery gier (jak pominąć menu, jak ustawić kamerę) i opis widoków:
  `tools/measure/lib.mjs`, `tools/measure/README.md`.
- Programowe GPU liczy klatkę sekundami: ładowanie gry trwa 0,5–2 min, zrzut
  kilkanaście sekund. Długie polecenia uruchamiaj w tle i czekaj na wynik; nie
  uruchamiaj trzech przeglądarek naraz (4 rdzenie).
- Commit: jedna sprawa na commit, w treści liczby przed/po. Stopka commita jak
  w dotychczasowej historii (`git log -3`), z nazwą modelu, który pisał.

---

## 3. Zadania z obchodu grafiki (listopad 2026)

Obchód: `tools/measure/shots.mjs` na buildach wszystkich pięciu gier, WebGPU
programowe, 800 × 450, preset High. Lagoon wypadła najlepiej (jeden zrzut kontrolny, bez nowych uwag — zostają
drobiazgi z G11). Każde zadanie niżej jest **tanie w sensie
§1.2** (stałe i wzory w istniejących shaderach albo geometria doklejona do
istniejącej siatki). Kolejność = stosunek zysku do ryzyka.

Zrzuty wyjściowe odtworzysz poleceniami z kolumny „widok” (adapter gry w
`tools/measure/lib.mjs`). Dla każdego zadania: zrzut przed, zmiana, zrzut po,
liczby wg §2. **Jedno zadanie = jeden commit.**

### G1. Field Line, las — prześwietlone plamy słońca (największy zysk)

- **Widok:** `--game field-line --extra '&map=forest' --views '[{"name":"spawn"},{"turn":3.14,"name":"back"}]'`
- **Objaw:** pod koronami ekspozycja otwiera się tak mocno, że oświetlona
  ściółka jest prawie biała, rękaw kombinezonu blado-miętowy zamiast oliwkowego.
- **Przyczyna:** `field-line/src/config.ts`, `minEvBelowPreset: 7` — siedem
  przysłon w dół jest dla wnętrza budynku; pod koronami drzew realna różnica
  to 2–3 EV.
- **Zmiana:** dolna granica zależna od mapy: las i strzelnica `2.5`, miasto
  zostaje `7` (pole w danych mapy albo tabela `Record<MapId, number>` w
  `config.ts`; wartość trafia do `exposure.update(…)` w
  `field-line/src/render/view.ts:389`). Żadnej zmiany w shaderach.
- **Odbiór:** plamy słońca mają fakturę (nie są wypalone), rękaw oliwkowy,
  cień pod koronami nadal czytelny. Wejście do budynku w mieście adaptuje się
  jak wcześniej (zrzut `&map=city` bez zmian).

### G2. Field Line, strzelnica — czarny spód dachu i słupy

- **Widok:** `--extra '&map=range' --views '[{"name":"spawn"},{"turn":3.14,"name":"back"}]'`
- **Objaw:** dach wiaty i słupy są smoliście czarne (ok. 2 % jasności), choć
  spód dachu oświetla odbicie od jasnego betonu i trawy.
- **Przyczyna:** `field-line/src/maps/range.ts:35` — cała bryła dachu
  (`boxOnBase('roofTar', …)`) ma materiał papy, także od spodu; słupy podobnie.
- **Zmiana:** papa zostaje tylko jako cienka warstwa na wierzchu (np. 0,04 m);
  spód i słupy z materiału drewna/desek, który mapa już ma (sprawdź listę
  `look` w `render/materials.ts`; wybierz istniejący, żeby nie przybył materiał
  ani draw call — budowniczy scala bryły po materiale).
- **Odbiór:** spód dachu to ciemne, ale czytelne deski z rysunkiem słojów;
  liczba draw calli i potoków bez zmian.

### G3. Field Line, strzelnica — żółte „iskry” na trawie

- **Widok:** jak G2, zwłaszcza `back`.
- **Objaw:** łąka w pasie 15–60 m jest usiana jasnożółtymi pojedynczymi
  pikselami („szum telewizyjny”).
- **Gdzie szukać:** `field-line/src/render/grassField.ts` (suche końcówki
  źdźbeł: `tipDry`, wiersze ~309–316) oraz gęstość/zasięg trawy na strzelnicy;
  porównaj z pułapką „Grass shimmer and static” w playbooku §5.6.
- **Zmiana (po kolei, do pierwszej, która działa):** (a) domieszka koloru
  suchych końcówek maleje z odległością tak jak `far` (już liczone w tym
  shaderze) — bez nowych próbek; (b) minimalna szerokość źdźbła w pikselach
  +20 % w dalszym pierścieniu.
- **Odbiór:** łąka z 30 m ma łagodną zmienność koloru, bez pojedynczych
  jasnych pikseli; z bliska źdźbła bez zmian. Plik jest wspólny z Lagoon —
  skopiuj i sprawdź też `castaway-lagoon` (widok `spawn`).

### G4. Tanks i Ridgeline — trawa jak „grzebień” i w rzędach

- **Widok:** `--game tanks --extra '&q=high' --views '[{"spot":"road","name":"road"},{"spot":"village","name":"village"}]'`;
  `--game ridgeline --views '[{"mode":"chase","name":"chase"}]'`
- **Objaw:** z kamery kilka metrów nad ziemią źdźbła stoją w widocznych
  rzędach i odcinają się kolorem od podłoża (zielone kreski na słomkowym tle
  w Tanks, ciemne kreski na jasnej łące w Ridgeline).
- **Kroki:**
  1. Ujednolić plik: `tanks` i `ridgeline` mają starszą kopię
     `render/grassField.ts` niż `field-line`/`castaway-lagoon` (różnica: opcja
     `shadeOcclusion`). Skopiuj nowszą (jest nadzbiorem), `tsc`, zrzuty — obraz
     ma się nie zmienić.
  2. Rzędy: w `grassField.ts` pozycja źdźbła to ciąg R2 + drgnięcie
     `spacing * 0.9`. Zrób najpierw zrzut 1600 × 900 (`--size 1600x900`), żeby
     odróżnić siatkę od aliasingu. Jeśli rzędy zostają: zwiększ drgnięcie do
     `spacing * 1.8` (ciąg R2 nadal daje równomierne przerzedzanie przez
     `drawRange`). To zmiana stałej w shaderze wierzchołków, koszt zerowy.
  3. Kolor: w obu grach kolor nasady źdźbła zbliż do koloru podłoża, na którym
     rośnie (opcje koloru przy tworzeniu `GrassField` w grze; w Tanks podłoże
     jest słomkowe — trawa ma być bardziej oliwkowo-żółta niż soczyście
     zielona; w Ridgeline jaśniejsza). Dobierz na zrzucie.
- **Odbiór:** z kamery pościgowej łąka jest jedną powierzchnią o zmiennej
  fakturze; nie widać rzędów ani „deszczu” kresek. Draw calle bez zmian.

### G5. Field Line, miasto — korony drzew z wielkich wielokątów

- **Widok:** `--extra '&map=city' --views '[{"name":"spawn"},{"turn":1.57,"name":"side"}]'`,
  plus jedno zbliżenie korony (`"pitch": 0.5`).
- **Objaw:** liście to płaskie, kanciaste płaty wielkości ~0,5 m; korona
  wygląda jak origami.
- **Kroki:** znajdź, skąd mapa `city` bierze drzewa (zacznij od
  `field-line/src/render/` — `vegetation`, `meshkit`, oraz
  `field-line/src/paris/city/trees.ts` z `leafTexture`). Jeśli płaty to karty z
  teksturą liści: zmniejsz pozorny rozmiar liścia, rysując na tej samej kanwie
  więcej mniejszych liści albo powtarzając teksturę 2× na karcie (stała UV).
  Rozmiar tekstury, liczba kart i trójkątów bez zmian. Jeśli płaty to sama
  geometria bez tekstury alfa — **nie rób**, opisz i oddaj (§5).
- **Odbiór:** z 10 m korona czyta się jako masa drobnych liści; z 60 m sylwetka
  bez zmian; brak migotania (dwa zrzuty w odstępie 20 klatek).

### G6. Contrail — fioletowe pola w cieniu chmur, białe kropki lasu

- **Widok:** `--game contrail --extra '&spawn=air&alt=900' --views '[{"mode":"chase","name":"chase","frames":20}]'`
- **Objaw 1:** zaorane pola w cieniu chmury są fioletowo-bordowe. Paleta gleby
  (`contrail/src/render/terrainMesh.ts`, `lin(0x6b5a47)`) jest poprawna; kolor
  psuje światło w cieniu chmury — samo niebieskie niebo, bez światła
  rozproszonego przez chmury.
- **Zmiana 1:** `contrail/src/render/clouds.ts:422` (`shadeReceivers`): cień
  chmury nie schodzi do zera — zamiast `shadow.mul(cloud())` użyj
  `shadow.mul(mix(CLOUD_SHADOW_FLOOR, 1, cloud()))` z `CLOUD_SHADOW_FLOOR` =
  0,12–0,18 (światło rozproszone przez samą chmurę; stała z komentarzem), w
  obu gałęziach (z `own` i bez). Bez nowych próbek. Ridgeline ma tę samą
  funkcję — przenieś tam, jeśli zrzut `rg_air` też na tym zyskuje.
- **Objaw 2:** las po prawej to ciemna plama z białawymi kropkami.
- **Zmiana 2:** `contrail/src/render/forest.ts` — kolory wierzchołków koron
  (funkcja `paint`, ~wiersz 65, i kolory przekazywane do niej przy budowie
  gatunków) oraz jasność impostora: przyciemnij i nasyć jasny koniec zakresu
  tak, by korona w słońcu była zielona (luminancja liniowa ≤ 0,12), nie
  szarobiała. `ridgeline/src/render/forest.ts` to podobny, ale **nie
  identyczny** plik — nie kopiuj całości, przenieś tylko stałe, jeśli tam też
  widać białe kropki.
- **Odbiór:** pola w cieniu są ciemniejsze, ale brązowe; las z 900 m to
  zielona faktura koron. Zrzut `ct_gnd` (nad chmurami) bez zmian.

### G7. Ridgeline — rzeka bez brzegu, łąka jednolita

- **Widok:** `--game ridgeline --extra '&spawn=air&alt=60' --views '[{"mode":"chase","name":"chase","frames":20}]'`
- **Objaw:** rzeka jest granatowym kształtem o ostrej krawędzi, bez pasa
  brzegu; łąki to jeden odcień zieleni aż po las.
- **Zmiana:** w `ridgeline/src/render/terrainMesh.ts` (i `render/landCover.ts`,
  playbook §7.12c) dane o wodzie już są (`land.water`, kolor wody: `waterColour`, wiersz ~131). (a) Pas brzegu: w
  wąskim przedziale `land.water` (np. 0,05–0,35) domieszaj kolor mułu/żwiru
  (`means[1]`, warstwa gleby) i ściemnij o 15 % — mokry brzeg. (b) Płycizna:
  kolor wody przy brzegu jaśniejszy i zieleńszy niż w nurcie (mix po tym samym
  `land.water`). (c) Łąka: amplitudę plam `sward` (wiersze ~244–250:
  `0.13` i wektor `0.08, 0.035, −0.14`) podnieś o połowę i dodaj trzecią,
  wolną oktawę `mx_noise_float(wp.div(45))` o amplitudzie ~0,10 — to funkcja
  szumu w shaderze, bez tekstury.
- **Odbiór:** rzeka ma jasny pas przy brzegu i ciemny nurt; łąka ma plamy
  suchszej i bujniejszej trawy widoczne z 60 m; z 2 km kolory pól bez zmian
  (zrzut z `alt=600`).

### G8. Tanks — niebo liliowo-szare, asfalt bez faktury

- **Widok:** `--game tanks --extra '&q=high' --views '[{"spot":"town","name":"town"},{"spot":"spawn","name":"spawn"}]'`
- **Objaw 1:** niebo w południe jest płaskie, liliowo-szare (bez gradientu
  zenit → horyzont), przez co cała scena jest „mleczna”.
- **Kroki 1:** `tanks/src/render/atmosphere.ts` i ustawienia `ATMO`
  (`window.__atmo` w trybie debug): porównaj z arkuszem
  `references/lighting-reference.png` (niebo w południe ~10 000 K, zenit
  wyraźnie ciemniejszy i bardziej nasycony niż horyzont). Zmień tylko stałe
  (zmętnienie / współczynnik Mie / wzmocnienie nieba). Sonda środowiska i mgła
  liczą się z tej samej funkcji — zrzut wsi i miasta musi zostać spójny.
- **Objaw 2:** jezdnia w mieście to jednolita ciemna płaszczyzna.
- **Kroki 2:** `tanks/src/render/cityGround.ts` — dodaj do albedo i szorstkości
  asfaltu zmienność z istniejącej tekstury szumu makro (jeśli materiał już ją
  próbkuje — użyj tej samej próbki; jeśli nie — `mx_noise_float` w dwóch
  skalach 3 m i 25 m, amplituda ±8 % albedo, ±0,08 szorstkości). Bez nowej
  tekstury.
- **Odbiór:** niebo niebieskie z gradientem; jezdnia ma łaty i przetarcia;
  potoki i draw calle bez zmian.

### G9. Kokpity — Contrail i Ridgeline

- **Widok:** `--game contrail --extra '&spawn=air&alt=900' --views '[{"mode":"cockpit","name":"cockpit"}]'`,
  to samo dla `ridgeline` (`alt=60`).
- **Objaw:** osłona przyrządów i burty kabiny Contrail to jednolita czerń bez
  detalu; rama kabiny Ridgeline to jednolita szara „glina”, hełm strzelca —
  gładka szara kula.
- **Zmiana (tylko stałe materiałów):** Contrail `render/cockpitModel.ts` —
  podnieś albedo czarnych tworzyw do zakresu arkusza PBR (guma/tworzywo
  ≥ 0,03 liniowo), szorstkość zróżnicuj istniejącym wzorem zużycia (playbook
  §6y). Ridgeline `render/heliCockpit.ts` — rama w kolorze ciemnej farby
  kabinowej (ciemny szaro-zielony lub czarny mat, nie średni szary), hełm:
  kolor i szorstkość farby, nie plastik.
- **Odbiór:** w kokpicie widać krawędzie i płaszczyzny (światło z owiewki),
  nic nie świeci; wyświetlacze bez zmian jasności.

### G10. Field Line, miasto — cegła i szyby

- **Widok:** `--extra '&map=city' --views '[{"turn":3.14,"name":"back"},{"turn":1.57,"name":"side"}]'`
- **Kroki:** (a) sprawdź albedo `brick` / `brickDark` w
  `field-line/src/render/materials.ts:50–60` z arkuszem PBR
  (`references/pbr-material-reference.png`; cegła czerwona ~0,15–0,25
  luminancji liniowej). Jeśli ciemniejsze — podnieś do zakresu. (b) Szyby w
  cieniu są jednolicie ciemne: sprawdź, czy materiał okien ma niską szorstkość
  i odbija sondę środowiska (jasne niebo na szybach pod kątem); jeśli szorstkość
  > 0,2 — obniż do ~0,08. Tylko stałe.
- **Odbiór:** zacienione elewacje są ciemne, ale ceglaste, nie czarne; część
  szyb odbija niebo.

### G11. Lagoon — drobiazgi z poprzedniego przeglądu

- Spód otwartej maski jeepa jest prawie czarny (`castaway-lagoon/src/render/jeepModel.ts`,
  AO z `color_1`): ogranicz dolną wartość AO dla węzła `bonnet` do ~0,35.
- Drewno AK jest zbyt pomarańczowe (`render/rifleModel.ts` `materialFor`):
  pomnóż kolor części drewnianych tak, by nasycenie spadło o ~25 %
  (rozpoznaj je po niskiej metaliczności z mapy — bez nowej tekstury), albo
  popraw teksturę w `shared/weapons/rifle_ak/` skryptem i zapisz krok w
  `CREDITS.md`.
- Kropka kolimatora na AK nie jest widoczna na zrzutach (`render/weaponModels.ts`
  `addRedDot`, `DOT_Y`): zrób zrzut z celowaniem i popraw położenie/jasność.
- **Widok:** `--game castaway-lagoon --views '[{"pitch":-0.1,"name":"spawn"},{"turn":3.14,"name":"back"},{"dx":12,"dz":34,"name":"jungle"}]'`
  jako kontrola, że nic innego się nie zmieniło.

### G12. Field Line, las — gałęzie sosen jak „pióra”

- **Widok:** jak G1 (po wykonaniu G1, bo prześwietlenie maskuje ten objaw).
- **Objaw:** igliwie na gałęziach to grube, równoległe prążki — gałąź wygląda
  jak pióro albo liść paproci; ściółka w cieniu ma ziarnisty, „mrowiący” wzór.
- **Kroki:** znajdź teksturę/wzór igieł sosny (`field-line/src/render/` —
  `foliagePatterns`, materiały roślin, playbook §5.2–5.3). Zagęść wzór igieł
  na karcie gałęzi 2× (stała skali wzoru lub UV), bez zmiany rozmiaru tekstury
  i geometrii. Dla ściółki: sprawdź, czy detal normalnej zanika z rozmiarem
  piksela (`fwidth`), jak wymaga playbook §2; jeśli nie — dodaj zanik.
- **Odbiór:** gałąź z 5 m czyta się jako kępy drobnych igieł; ściółka z 10 m
  bez ziarna; dwa zrzuty w odstępie 20 klatek bez migotania.

### Po wszystkich zadaniach G

1. Dopisz do `docs/graphics-playbook.md` sekcję „6aa. Tanie poprawki z obchodu
   zrzutami (listopad 2026)”: dla każdej wykonanej poprawki jedno zdanie
   *objaw → przyczyna → zmiana*, po angielsku, w stylu sąsiednich sekcji; a do
   tabeli pułapek §11 te, które są ogólne (np. dolna granica ekspozycji pod
   koronami, materiał dachu od spodu).
2. `bash docs/model-kit/sync.sh`, commit, `main`, sprawdź APK.
3. Poproś użytkownika o test na telefonie: menu pauzy → Benchmark oraz linia
   „Loaded in X s” — to jedyne prawdziwe liczby.


---

## 4. Zadania porządkowe

### P1. Kontrakt debugowania we wszystkich grach (`--game generic`)

`tools/measure/README.md` opisuje kontrakt: `?autostart`, `window.__ready = true`,
`window.__debug.place({x, y, z, yaw, pitch})`, `window.__debug.spot(name)`,
linie `[load] <etap>: <s> s`. Dziś każda gra ma własne haki (adaptery w
`tools/measure/lib.mjs`).

1. W każdej grze, przy `?debug` lub `?autostart`, ustaw `window.__debug` z
   `place` i `spot` (cienka warstwa na istniejących `placePlayer` /
   `benchPlace` / `rig.mode`; w Contrail i Ridgeline `spot` wybiera tryb kamery).
2. Tanks, Contrail, Ridgeline: ustaw `window.__ready = true` tam, gdzie adapter
   dziś sprawdza gotowość (po pierwszych klatkach).
3. Tanks: dodaj `?autostart` (dziś adapter chowa menu ręcznie).
4. Tanks, Contrail, Ridgeline: linie `[load]` na każdy etap ładowania i suma —
   wzór w `field-line/src/main.ts` i `castaway-lagoon/src/main.ts`; w menu pauzy
   „Loaded in X s · cztery najdłuższe etapy” (`field-line/src/ui/menu.ts`).
5. Odbiór: `node tools/measure/shots.mjs --game generic --url … --views '[{"spot":"spawn"}]'`
   działa dla każdej z pięciu gier; potem usuń zbędne adaptery z `lib.mjs`.

### P2. Szablon reguł po polsku (`docs/graphics-rules-template.md`)

Przenieś zmiany, które są już w `games-ts-threejs.md` i w
`docs/model-kit/dla-modelu/rules/`:

- §1 pkt 5 (pliki wspólne): dopisz `render/instancing.ts` (wspólne shadery
  statycznych instancji) i `core/noise.ts` (szum z tablicą gradientów);
  `render/warmup.ts` opisz jako „rozgrzewka potoków klatką renderu”.
- §3 pkt 1: „proceduralnie” zostaje drogą domyślną; dopisz, że powierzchnie
  blisko oka mogą brać tekstury fotograficzne CC0, a pojazdy, broń i ludzie —
  modele przygotowane skryptami z `paris/tools/` (playbook §6o, §6q2).
- §6 pkt 1–2: usuń `compileAsync` — potoki buduje klatka rozgrzewki
  (`revealOnePerPipeline` + prawdziwa klatka każdego łańcucha postu **i każdej
  dodatkowej kamery**: luneta, lustro, sensor).
- Nowy §6b „Czas ładowania” — odpowiednik „§10b Loading time” z
  `docs/model-kit/dla-modelu/rules/games-ts-threejs.md` (6 punktów).
- §7: dopisz `tools/measure/` (zrzuty, raport ładowania, profil CPU).
- §9 pkt 3–4: polecenia z `tools/measure/README.md`.
- Na końcu `bash docs/model-kit/sync.sh`.

### P3. Briefy i arkusze ocen zestawu

W `docs/model-kit/dla-modelu/games/*/BRIEF.md` i
`docs/model-kit/dla-ciebie/grading/*/GRADING.md`: dopisz do „pierwszego
kamienia milowego” kontrakt debugowania i raport ładowania (liczba potoków,
gpu idle), a do oceny — punkt „czas ładowania zmierzony i uzasadniony”
(zabierz 5 punktów z najmniej ważonej pozycji, suma ma zostać 100). Nie
zmieniaj wymagań co do funkcji gier.

### P4. Pomiar ładowania wszystkich gier po zmianach

Dla każdej z pięciu gier `tools/measure/load.mjs` (High i `--extra '&q=low'`).
Wynik (potoki, moduły, gpu idle, najwolniejsze uploady) dopisz jako tabelę
„stan na <data>” na końcu §8.4 playbooka. To punkt odniesienia dla P5 i dla
nowej gry.

### P5. Mniej potoków (dalsze skracanie ładowania)

Tylko mechaniczna część, bez zmiany wyglądu:

1. W raporcie `load.mjs` znajdź etap z największą liczbą potoków. Dodaj w
   skrypcie tymczasowo wypisanie `label` potoków (albo użyj tracera z playbooka
   §9.3), żeby zobaczyć, które materiały i siatki je budują.
2. Każdy `InstancedMesh` wypełniany raz, a nieoznaczony — oznacz
   `markStaticInstances` (Tanks, Contrail, Ridgeline nie mają jeszcze
   `render/instancing.ts`: skopiuj plik i wywołaj `shareStaticInstanceShaders`
   przed pierwszą klatką, jak w `castaway-lagoon/src/render/view.ts`).
3. Materiały identyczne co do parametrów, a tworzone osobno dla każdego
   rekwizytu — połącz przez pamięć podręczną (klucz = parametry).
4. Odbiór: mniej potoków, zrzuty identyczne, zero błędów w konsoli, 0 nowych
   potoków w trakcie gry (playbook §9.3).

Scalanie różnych materiałów w jeden „uber-materiał” z przełącznikami to już
projektowanie — §5.

### P6. Porządek w CI

- Stare artefakty Actions zajmują limit do wygaśnięcia (90 dni). Nie ma do
  nich narzędzia w sesji; jeśli użytkownik poprosi, podaj mu ścieżkę:
  repozytorium → Actions → przebieg → „Artifacts” → usuń.
- Akcje w `.github/workflows/android.yml` działają na Node 20 (ostrzeżenie o
  wycofaniu): podnieś `actions/checkout`, `setup-node`, `setup-java`,
  `upload-artifact`, `gradle/actions/setup-gradle` do bieżących wersji
  głównych, jedna zmiana, sprawdź przebieg.

---

## 5. Czego tu nie robić — oddaj mocniejszemu modelowi

- Nowa technika renderowania albo zmiana łańcucha postu (AO, SSR, mgła
  wolumetryczna, nowy model nieba).
- Wszystko, co wymaga czytania wnętrza three.js (`renderer._pipelines`,
  `NodeBuilder`, klucze pamięci podręcznej, błędy WGSL bez oczywistej
  przyczyny po jednej próbie).
- „Uber-materiał”, KTX2, wypiekanie generacji do plików: projekt i pierwszy
  egzemplarz; powielenie na kolejne gry jest już rutyną.
- Spór o ocenę obrazu: gdy po dwóch próbach zrzut „po” nie jest wyraźnie
  lepszy, zostaw opis i zrzuty zamiast trzeciej próby.
- Każda zmiana, która wg §1.2 zwiększa obciążenie.
