# Nowa gra blisko AAA — wytyczne i instrukcja krok po kroku

Użytkownik opisuje **rodzaj gry, zasady i otoczenie**. Model z tym zestawem
wytycznych buduje grę tak blisko jakości AAA, jak pozwala platforma
(three.js r186, WebGPU + TSL, przeglądarka i APK na Androida), i na każdym
kroku to mierzy.

Dokument ma dwie części: **A** wypełnia użytkownik (5 minut), **B** wykonuje
model. Reguły techniczne są w `AGENT.md`, `rules/games-ts-threejs.md`,
`rules/graphics-quality.md`; sposób budowy każdej techniki w
`docs/graphics-playbook.md`. Ten plik mówi, **w jakiej kolejności i do jakiej
poprzeczki**, i wygrywa z nimi tylko tam, gdzie mówi o kolejności pracy.

Start: skopiuj cały katalog `docs/nowa-gra-AAA/` do pustego folderu projektu —
ma wszystko, czego trzeba (jego `README.md` prowadzi w trzech krokach).
Wypełnij `games/nowa-gra/OPIS.md`, dołóż zdjęcia do
`games/nowa-gra/references/`, wklej modelowi `FIRST-MESSAGE.md`. To samo z
własną nazwą gry i z wariantem bez gotowych rozwiązań układa
`node docs/model-kit/new-test.mjs --new <nazwa> <folder> [--fair]`.

---

## Reguły poprawy realizmu (wspólne dla przebudowy i dla nowej gry)

Wynik obchodu pięciu gier i pomiarów ładowania. Każda reguła ma powód; numer
(R1–R12) jest przywoływany w etapach niżej.

**Co daje realizm — w tej kolejności**

- **R1. Asset tam, gdzie oko zna kształt; generacja tam, gdzie jest pole,
  zjawisko albo rozmieszczenie.** Drzewa, budynki, pojazdy, ludzie, broń,
  skały i rekwizyty z modeli i skanów; teren, niebo, woda, pogoda, rozsiew,
  trawa i cząstki z kodu. Największa luka gier wzorcowych to to, co wciąż jest
  generowane kodem: korony drzew, płaskie powtarzalne elewacje, jednolite
  podłoże, gładkie kokpity.
- **R2. Światło pośrednie.** Jedna sonda środowiska na cały świat daje czarne
  podcienia i płaskie wnętrza. Światło odbite wypieka się do plików (mapy
  światła dla statycznej architektury, siatka sond dla obiektów ruchomych):
  zero kosztu w klatce, ale wymaga stałej pory dnia albo kilku wypieków
  (presety, klatki kluczowe cyklu dobowego).
- **R3. Okluzja i cienie kontaktowe.** AO wypalone w modelu (kolor
  wierzchołków) zawsze. Ekranowe AO i cienie kontaktowe kosztują czas klatki:
  tylko na presecie Wysoka i dopiero po sprawdzeniu zrzutem (GTAO w three r186
  z odwróconą głębią czerni ściany zwrócone do kamery — dziś wyłączone).
- **R4. Ruch.** Zrzut wybacza więcej niż gra: animacja postaci z prawdziwego
  ruchu, dym, pył, zniszczenia, reakcja roślin i wody. Ocenia się na
  prawdziwym urządzeniu, nie na programowym GPU.
- **R5. Gęstość detalu przy oku**: podłoże z wysokości 0,45 m, zużycie na
  krawędziach, brud w zagłębieniach. Efekty ekranowe są na końcu listy.

**Co musi być najpierw — potok (inaczej każdy asset wydłuża start)**

- **R6. Tekstury skompresowane (KTX2).** Każdy plik tekstury w KTX2, mipmapy
  liczone przy kodowaniu; mapy normalnych i ORM w UASTC jako dane liniowe,
  dalekie mapy koloru w ETC1S; mipmapy roślin z zachowaniem pokrycia alfa.
  Dziś gry dekodują JPG/PNG do RGBA8 — około czterokrotnie więcej pamięci i
  wysyłki do GPU niż format blokowy. Loader: `KTX2Loader().detectSupport(renderer)`
  po `renderer.init()`, bez ścieżki transkodera (three dołącza własny do buildu;
  APK działa offline). Zmierzone w grach wzorcowych: ETC1S tam, gdzie trzyma
  ≥ 40 dB PSNR (≥ 45 dla widoku z pierwszej osoby), inaczej UASTC; mapy normalnych
  zawsze UASTC. UASTC to 8 bitów na teksel i pakuje się tylko ~1,5×, więc
  szczegółowy model rośnie na dysku 4–5×: KTX2 zostaje tam, gdzie oszczędza
  ≥ 10 MB pamięci GPU na 1 MB pliku (`tools/assets/ktx2_glb.mjs`,
  `bake_atlases.mjs`; playbook §8.4).
- **R7. Poziomy szczegółowości.** Trzy LOD + impostor dla wszystkiego, co widać
  z ponad 100 m; przełączanie po rozmiarze na ekranie, przejście
  komplementarnym ditheringiem; siatki skompresowane (Meshopt), tekstury
  dalszych poziomów o połowę mniejsze. **Kaskady cieni rysują każdy obiekt
  rzucający cień jeszcze raz**, w każdej kaskadzie — zmierzone 60–80 %
  trójkątów klatki w mieście, lesie i zatoce: cień rzuca najprostszy poziom z
  warstwy widocznej tylko dla kamer cieni (bez dodatkowego wywołania;
  `tools/assets/shadow_mesh.mjs` dla nieprzezroczystych skanów). Wiele małych
  siatek albo kafli terenu kosztuje wywołania, nie trójkąty: scal po materiale
  po wypieku, dalekie kafle w małe regiony (`tools/measure/passes.mjs` pokazuje,
  dokąd idą wywołania i trójkąty).
- **R8. Mniej wariantów shaderów.** Jeden materiał na *rodzaj* powierzchni z
  przełącznikami jako uniformy i atrybuty, nie materiał na rekwizyt; statyczne
  `InstancedMesh` oznaczone `markStaticInstances`; dodatkowe kamery (luneta,
  lustro) z celem-bliźniakiem przebiegu sceny. Liczba potoków podawana przy
  każdej zmianie, która dodaje materiał, siatkę instancji albo kamerę.
- **R9. Wypiek tego, co liczy się przy każdym starcie.** Siatki wysokości,
  rozsiew, tekstury proceduralne: jeśli profil (`tools/measure/profile.mjs`)
  pokazuje ponad 1 s — do pliku albo na wątek roboczy.

**Jak pracować**

- **R10. Najpierw pilot, potem powielanie.** Jedna gra i jedna mapa (albo
  wycinek 100 × 100 m) doprowadzone do końca i zmierzone; dopiero liczby z
  pilota mówią, ile assetów mieści się w budżecie ładowania i pamięci.
- **R11. Budżet jest umową, telefon jest sędzią.** Żadna zmiana nie zwiększa
  czasu klatki, czasu ładowania ani pamięci bez liczby przed i po i bez zgody
  użytkownika. Liczby z programowego GPU porządkują przebiegi na jednej
  maszynie; prawdziwe są z testu wydajności i linii „Loaded in X s” na
  telefonie.
- **R12. Uczciwy pułap.** Pełnego AAA w przeglądarce na telefonie nie będzie:
  brakuje pamięci i technik w rodzaju wirtualnej geometrii i śledzenia
  promieni. Cel osiągalny: wygląd dobrej gry konsolowej sprzed kilku lat na
  komputerze i jej prostsza, spójna wersja na telefonie. Czego się nie da —
  mówi się wprost.

**Poprzeczka jakości — co zdradza grafikę** (obchody pięciu gier; sprawdzaj w
stałych widokach Etapów 4 i 8, High i Low). Najpierw znajdź właściciela piksela
(ukrywaj po jednym systemie, mierz ekspozycję): połowa przyczyn zgadniętych ze
zrzutów była błędna.

| Szukaj | Zwykła przyczyna → poprawka |
|---|---|
| Przepalone plamy słońca, „pompująca” jasność | oko otwiera się za bardzo w cieniu → na zewnątrz najwyżej 2,5 EV pod presetem |
| Czarne spody dachów, okapów | jeden ciemny materiał na każdej ścianie → własny materiał spodu, nigdy światło otoczenia |
| Drzewa z origami, liście po pół metra | tekstura liścia w skali karty → kilka małych gałązek na kartę, liście 5–15 cm |
| Jasne kropki w dalekim lesie | impostory odbijają niebo → impostory matowe (`specularIntensity: 0`) |
| Fioletowa ziemia pod chmurami | w cieniu świeci tylko niebieskie niebo → cień chmury zostawia ~15 % słońca |
| Woda styka się z trawą linią | brak brzegu → pas mokrego mułu, jaśniejsza płycizna |
| Liliowy albo szary zenit | mgiełka barwi całe niebo → zenit z rozpraszania Rayleigha, mgiełka przy horyzoncie |
| Płaski asfalt, ściany, ziemia | jeden ton → zużycie w dwóch skalach (~25 m, ~3 m) i z nim szorstkość; zestawy ze zdjęć |
| Trawa w rzędach, schodek koloru na jej skraju | siatka, własny kolor → rozrzut, odcień z podłoża, źdźbła ≥ 1,3 px |
| Szare „gliniane” kokpity i wnętrza | gołe wnętrze pobranego modelu → teksturuj albo wymień |
| Ludzie jak roboty albo lalki | kapsuły → prawdziwe ciała (MPFB), żadnych dwóch takich samych, mocap |
| Wszystko czyste i nowe | → zużyte krawędzie, brud w zagłębieniach, kalkomanie, szczątki, które zostają (R5) |

---

## Część A — co pisze użytkownik

Wklej i uzupełnij. Krótko; model dopyta tylko o to, czego zgadnięcie byłoby
kosztowne.

```markdown
# Opis gry

## 1. Rodzaj gry
Gatunek i kamera (FPS / TPP / pojazd / lot / izometria): …
Jedna sesja trwa: … min. Gracz: sam / z botami.

## 2. Zasady
Co gracz robi przez 30 sekund (pętla gry): …
Cel i warunki wygranej / przegranej: …
Przeciwnicy lub przeszkody: …
Czego ma NIE być (np. krew, prawdziwe marki): …

## 3. Otoczenie
Miejsce (np. port rybacki nad fiordem, zima): …
Rozmiar świata (m × m albo „mała arena”): …
Pora dnia i pogoda: stała … / cykl … / presety …
Trzy rzeczy, które mają robić wrażenie: …

## 4. Urządzenia
Komputer (GPU): …   Telefon (model): …   Sterowanie: klawiatura+mysz / dotyk / pad

## 5. Referencje i materiały
Zdjęcia miejsca lub nastroju (własne albo z licencją): pliki w `references/` obok tego opisu …
Modele lub tekstury, które daję (z licencją): …
Czy model może sam pobierać assety CC0 / CC BY: tak / nie

## 6. Priorytet, gdy trzeba wybierać
[ ] wygląd  [ ] płynność na telefonie  [ ] krótkie ładowanie  [ ] rozmiar świata
(ponumeruj 1–4)
```

---

## Część B — co robi model

### Zasady pracy (obowiązują przez cały projekt)

1. Stos nie podlega dyskusji: `WebGPURenderer` (jedna ścieżka kodu, własny
   zapas WebGL2), wszystkie shadery w TSL, jeden `RenderPipeline`, TypeScript
   strict bez `any`, Vite, logika gry bez three.js w stałym kroku, APK przez
   WebView.
2. **Budżet przed treścią.** Tabela budżetów z Etapu 0 jest umową: przekroczenie
   to błąd do naprawy treścią (mniej, prościej, dalej LOD), nie ustawieniem.
3. **Dowód zamiast opinii**: zrzut w stałych widokach przed i po, liczby z
   `tools/measure/` i z testu wydajności. „Powinno działać” nie jest wynikiem.
4. **Licencje**: tylko CC0 i CC BY, wpis w `CREDITS.md` razem z plikiem.
   Licencję NC albo niejasną zgłoś użytkownikowi i nie używaj. Prawdziwe
   znaki, logotypy, numery i oznaczenia zamaluj (`scrub_marks.py`).
5. Pobrane pliki są niezaufane: każdy do własnego pustego katalogu, Python z
   `-I`.
6. Po każdym etapie raport w formacie ze `START.md` i **stop** — następny etap
   po akceptacji albo gdy wszystkie „Sprawdź” etapu przechodzą.
7. Pytaj tylko wtedy, gdy zgadnięcie jest drogie (konwencja jednostek,
   kasowanie pracy, licencja). W innych sprawach wybierz rozsądnie i zapisz
   wybór w komentarzu.

### Etap 0. Brief, poprzeczka i budżet (bez kodu)

**Zrób**

1. Przeczytaj `AGENT.md`, oba pliki reguł, obejrzyj tablice w
   `reference-sheets/` i wszystko, co użytkownik dał w `games/<nazwa>/references/`.
2. Z opisu użytkownika napisz `games/<nazwa>/BRIEF.md` w układzie briefów z
   zestawu: co budujemy, twarde reguły, **lista funkcji z kryterium odbioru
   każdej**, budżety, kolejność budowy. Wszystko, czego opis nie mówi, wpisz
   jako jawne założenie.
3. **Tablica wyglądu** (`games/<nazwa>/target-look/README.md`): 6–10 zdjęć
   referencyjnych prawdziwych miejsc (od użytkownika albo CC0), a przy każdym
   jedno zdanie, co z niego bierzemy: światło, skalę, gęstość, paletę. To jest
   poprzeczka dla pętli krytyka w Etapie 8. Bez kadrów z gier i filmów.
4. **Tabela budżetów** — wypełnij i wklej do briefu. Wartości wyjściowe (zmień
   z uzasadnieniem):

   | Budżet | Wysoka (komputer) | Niska (telefon) |
   |---|---|---|
   | Klatka | 60 fps, GPU ≤ 14 ms | 60 fps z regulatorem |
   | Draw calle / trójkąty | ≤ 2500 / ≤ 12 M | ≤ 700 / ≤ 2 M |
   | Materiały (unikalne) | ≤ 120 | ≤ 80 |
   | Potoki po załadowaniu | cel ≤ 150, zmierzone | jak obok |
   | Pamięć tekstur na GPU | ustal po pomiarze wycinka | ustal po pomiarze na telefonie |
   | Ładowanie („gpu idle”) | cel ≤ 10 s | cel ≤ 20 s |
   | Rozmiar buildu | cel ≤ 80 MB | ten sam build |

   Cele ładowania i pamięci są propozycją startową: gry wzorcowe nie mają
   jeszcze twardych liczb z telefonu. Pierwszy pomiar na telefonie (Etap 2)
   zamienia cel w budżet.
5. **Plan assetów** (`games/<nazwa>/ASSETS.md`) — tabela *przed* kodem:

   | Kategoria | Co | Źródło | Licencja | Trójkąty LOD0/1/2 | Tekstury | Skrypt |
   |---|---|---|---|---|---|---|

   Reguła podziału (R1): **asset** — drzewa i krzewy (min. 3 gatunki, 2–3 warianty),
   budynki (zestaw modułów: ściana, okno, drzwi, narożnik, dach, detale),
   pojazdy, broń, ludzie, skały, rekwizyty bohaterskie, 4–8 materiałów podłoża
   ze skanów; **generacja** — teren, niebo, chmury, woda, pogoda, rozsiew,
   trawa ze źdźbeł, cząstki, dźwięk.

**Sprawdź:** brief ma kryterium odbioru przy każdej funkcji; każdy wiersz planu
assetów ma źródło i licencję; użytkownik zaakceptował brief, tablicę wyglądu i
budżet. **Nie zaczynaj kodu przed akceptacją.**

### Etap 1. Szkielet i pomiar (zanim cokolwiek ładnie wygląda)

**Zrób**

1. Projekt Vite + TS strict; pliki z `shared-src/` skopiuj **bez zmian**
   (rozgrzewka potoków, wspólne shadery instancji, pomiar, szum).
2. Renderer, jednostki fizyczne, ekspozycja z EV100 z pre-ekspozycją, łańcuch
   postu (playbook §1). Szary sześcian na szarej płaszczyźnie pod słońcem
   100 000 lx ma wyjść poprawnie naświetlony.
3. **Kontrakt debugowania** (`tools/measure/README.md`): `?autostart`,
   `&q=high|low`, `window.__ready`, `window.__debug.place/spot`, linie
   `[load] <etap>: <s> s` i suma w menu pauzy.
4. Stałe widoki testu wydajności (`app/bench.ts`), przycisk Benchmark, nakładka
   F3, regulator klatek.
5. Sterowanie dotykowe i **APK z pierwszego grywalnego builda** (workflow
   publikuje jedno wydanie kroczące, nie artefakt na przebieg).

**Sprawdź:** `shots.mjs --game generic` i `load.mjs --game generic` działają;
`tsc --noEmit` i testy czyste; APK instaluje się i startuje na telefonie.

### Etap 2. Potok assetów (zanim wejdzie pierwszy model) — R6, R7, R8, R9

**Zrób**

1. **Tekstury skompresowane (KTX2)** z mipmapami liczonymi przy kodowaniu;
   normalne i mapy ORM w UASTC jako dane liniowe, dalekie kolory w ETC1S
   (reguły §3.5). Loader: `KTX2Loader` z `detectSupport(renderer)`, transkoder
   Basis w buildzie (offline w APK). *Gry wzorcowe tego jeszcze nie mają:
   zbuduj na jednej teksturze, zmierz pamięć i czas uploadu względem PNG/JPG,
   zapisz wynik — dopiero potem przepuść resztę.*
2. **Modele**: glTF/GLB, kompresja Meshopt, **3 poziomy szczegółowości +
   impostor** dla wszystkiego, co widać z ponad 100 m; przygotowanie wyłącznie
   skryptami z `tools/assets/` (skala w metrach, osie, części ruchome, AO,
   rozmiar tekstur, oznaczenia zamalowane).
3. **Biblioteka materiałów**: jeden materiał na *rodzaj* powierzchni z
   przełącznikami jako uniformy i atrybuty, nie materiał na rekwizyt; warstwy
   podłoża w `DataArrayTexture`; ≤ 16 próbkowanych tekstur na etap shadera.
4. **Manifest i strumieniowanie**: lista plików z rozmiarem, priorytetem i
   promieniem; pasek postępu z prawdziwych bajtów; to, co daleko, doładowuje
   się w tle bez przycięcia (nic nowego nie kompiluje się w grze — wariant
   potoku istnieje od startu).
5. Jedno drzewo, jeden budynek i jeden rekwizyt przeprowadź przez cały potok
   jako test.

**Sprawdź:** raport `load.mjs` (potoki, uploady, gpu idle) przed i po dodaniu
trzech testowych assetów; żaden upload > 50 ms; pamięć tekstur zapisana;
**pierwszy pomiar na telefonie** — z niego ustal budżety pamięci i ładowania.

### Etap 3. Światło i atmosfera — R2, R3

**Zrób** (playbook §1, §4, §12.4)

1. Słońce w luksach z kaskadami cieni dobranymi do realnej odległości gry;
   niebo fizyczne; mgła i perspektywa powietrzna na każdym obiekcie; sonda
   środowiska z tej samej funkcji nieba, z odbiciem od ziemi.
2. **Światło pośrednie — wybierz wg pory dnia z briefu:**
   - *stała pora dnia*: wypiek w Blenderze (Cycles) do map światła dla
     statycznej architektury i do siatki sond dla obiektów ruchomych; zero
     kosztu w klatce;
   - *presety pory dnia*: osobny wypiek na preset, przełączany uniformem;
   - *płynny cykl*: siatka sond przeliczana w tle (kilka sond na klatkę) albo
     2–4 wypieki kluczowe mieszane po czasie — nigdy przebudowa wszystkiego w
     jednej klatce.
   Siatkę sond trzymaj jako atlas 2D warstw (tekstura 3D w przebiegu `rtt`
   nie działa w r186 na WebGPU — playbook §11).
3. **Okluzja**: AO wypalone w modelach (kolor wierzchołków) zawsze; ekranowe AO
   tylko na Wysokiej i tylko po sprawdzeniu zrzutem, że nie czerni ścian
   zwróconych do kamery (znana wada GTAO w r186 z odwróconą głębią).
4. Cienie kontaktowe pod małymi obiektami (plamy okluzji w shaderze podłoża
   albo krótki marsz po głębi na Wysokiej).

**Sprawdź:** szara karta w słońcu przy EV presetu; podcień i wnętrze czytelne,
nie czarne; horyzont, mgła i odbicia tej samej barwy o zachodzie; 0 nowych
potoków przy zmianie pory dnia.

### Etap 4. Wycinek pionowy — 100 × 100 m w końcowej jakości — R1, R5, R10

Najważniejszy etap. Wybierz miejsce, w którym gracz spędzi pierwszą minutę.

**Zrób**

1. Teren z jednej funkcji wysokości; podłoże ze skanów, mieszane po
   wysokości, z detalem do 10 m i zmiennością makro; ścieżki, koleiny, mokre
   pasy.
2. Wszystkie kategorie z planu assetów po jednym egzemplarzu w końcowej
   jakości: drzewo każdego gatunku, moduły budynku złożone w jeden dom,
   pojazd, postać, broń, skały, 10–20 rekwizytów.
3. **Gęstość przy oku**: sprawdź obraz z wysokości 0,45 m i 1,7 m. Krawędzie
   mają zużycie, zagłębienia brud, płaszczyzny kurz; nic nie jest czyste jak
   z salonu.
4. Woda, jeśli jest w briefie (playbook §7).
5. Preset Niska tego samego wycinka: prostszy, nie inny.

**Sprawdź**

- Zrzuty wycinka obok zdjęć z tablicy wyglądu, o tej samej porze dnia: wypisz
  pięć największych różnic i usuń je, zanim pójdziesz dalej (to pierwsza runda
  pętli z Etapu 8).
- Budżety klatki dotrzymane w wycinku na obu presetach; test na telefonie.
- Ekstrapolacja: „cała mapa to N takich wycinków w zasięgu widzenia” — policz
  draw calle, trójkąty, pamięć i ładowanie dla pełnej mapy. Jeśli nie mieszczą
  się w budżecie, **teraz** zmień plan assetów albo rozmiar świata.

**Stop i raport. Reszta świata powstaje dopiero po akceptacji wycinka.**

### Etap 5. Cały świat

**Zrób**

1. Rozsiew roślin i rekwizytów z danych (mapa pokrycia, reguły nachylenia i
   odległości), nie ręcznie; jeden `InstancedMesh` na rodzaj, strumieniowany
   po komórkach siatki; statyczne oznaczone `markStaticInstances`.
2. Budynki z modułów scalonych po materiale w jedną siatkę na blok.
3. Odległość: pełne modele → lekkie → impostory z komplementarnym ditheringiem
   przejścia (playbook §5.5); nic nie „pyka”.
4. Obiekty gry (cele, znajdźki) stawiane przez tę samą funkcję pokrycia, której
   używa renderer.

**Sprawdź:** draw calle w ruchu płaskie; `load.mjs` — potoki i gpu idle w
budżecie; przelot/przejście przez mapę bez klatki > 50 ms; 0 nowych potoków.

### Etap 6. Rozgrywka i ruch — R4

**Zrób**

1. Zasady z briefu jako logika w stałym kroku z testami jednostkowymi (fizyka,
   balistyka, lot — z co najmniej jedną wartością z zewnętrznego źródła).
2. Postacie: szkielet, skinning z wektorami ruchu, klipy z prawdziwego ruchu
   (`tools/assets/mocap`, playbook §6s); mieszanie klipów, stopy nie ślizgają się.
3. Efekty warstwami: błysk, ogień, dym, pył, odłamki, które zostają; cząstki
   miękkie i oświetlone; ślady na powierzchniach.
4. Świat reaguje: trawa się ugina, woda marszczy, gałęzie i kurz odpowiadają na
   wybuch i przejazd.
5. Dźwięk przestrzenny z prędkością dźwięku, warstwy broni i silników.

**Sprawdź:** kilka klatek w odstępach dla wszystkiego, co się rusza; brak
smużenia TRAA na postaciach i wirnikach; czytelna informacja zwrotna < 200 ms.

### Etap 7. Telefon — R11

Preset Niska na docelowym telefonie: 2× piksele urządzenia z TRAA, regulator
klatek obniża skalę renderu przed efektami. Test wydajności w każdym stałym
widoku i trzy minuty gry. Linia „Loaded in X s” z menu pauzy trafia do
raportu. Budżety pamięci i ładowania z Etapu 2 muszą być dotrzymane.

### Etap 8. Pętla krytyka (powtarzaj do kryterium końca)

1. Zrzuty w stałych widokach, w południe, o złotej godzinie i przy
   zachmurzeniu, obok zdjęć z tablicy wyglądu.
2. Wypisz różnice, posortuj wg tego, jak szybko zdradzają „grę”; do każdej
   przyczyna w kodzie lub assecie i koszt naprawy wg budżetu.
3. Napraw pięć pierwszych; każda naprawa ze zrzutem przed/po i liczbami.
4. **Koniec**, gdy: osoba z zewnątrz, patrząc 2 sekundy na pomniejszony zrzut,
   nie jest pewna, czy to zdjęcie — albo gdy kolejna runda wymaga techniki
   spoza platformy. Wtedy wypisz wprost, co zostało i dlaczego.

### Definicja ukończenia

- [ ] Każda funkcja briefu spełnia swoje kryterium odbioru.
- [ ] Lista odbioru sceny z `rules/graphics-quality.md` §14 na obu presetach.
- [ ] Budżety z Etapu 0 dotrzymane w każdym stałym widoku; ładowanie i pamięć
      zmierzone na telefonie.
- [ ] 0 nowych potoków po załadowaniu; żadnej klatki > 50 ms po pierwszej sekundzie.
- [ ] `CREDITS.md` kompletny; żadnych prawdziwych oznaczeń.
- [ ] Raport końcowy: co zrobione, liczby, czego nie da się zrobić na tej
      platformie.

### Podział pracy między modele

Jeden model może wykonać wszystko — tak wygląda test porównawczy modeli. Gdy
masz do dyspozycji dwa poziomy modeli, dziel pracę tak:

| Mocniejszy model | Lżejszy model (wg `docs/wytyczne-prace-rutynowe.md`) |
|---|---|
| Etap 0 (brief, budżet, plan assetów) | pobieranie i przygotowanie assetów skryptami |
| pierwszy egzemplarz każdego elementu potoku (Etap 2) | przepuszczenie pozostałych plików przez potok |
| światło pośrednie (Etap 3) | pomiary, zrzuty, raporty |
| wycinek pionowy (Etap 4) | powielenie wycinka na świat (Etap 5) wg wzoru |
| ocena w pętli krytyka | poprawki o znanej przyczynie |

### Czego nie robić

- Nie zaczynaj od efektów ekranowych; nie dodawaj przebiegu renderowania, żeby
  przykryć słaby asset.
- Nie buduj całej mapy w jakości szkicu z planem „dopracowania później”.
- Nie dodawaj modelu bez LOD, tekstury bez kompresji, materiału bez sprawdzenia
  liczby potoków.
- Nie wołaj `renderer.compileAsync`; nie twórz materiału, tekstury z kanwy ani
  światła w trakcie gry.
- Nie oceniaj jazdy ani lotu z przeglądarki bez GPU.

---

## Załącznik: co dalej poza tym planem (techniki i silniki)

**W obecnym stosie (three.js + WebGPU)** — po ukończeniu gry wg tego planu, w kolejności zysku:

| Technika | Co daje | Koszt / warunek |
|---|---|---|
| Wybór widocznych obiektów na GPU (shader obliczeniowy + rysowanie pośrednie) | wielokrotnie więcej obiektów przy tej samej liczbie draw calli | tylko WebGPU; zapas WebGL2 zostaje przy obecnej ścieżce |
| Skalowanie czasowe (render w 50–67 % i odtworzenie pełnej rozdzielczości z historii) | zapas na wszystko inne, zwłaszcza na telefonie | własna implementacja na bazie TRAA; w przeglądarce nie ma gotowego DLSS/FSR |
| Mgła wolumetryczna w siatce przestrzennej, cienie w dymie | głębia sceny, światło w lesie i w mieście | Wysoka; kilka ms |
| Odbicia ekranowe poza wodą (mokry asfalt, szyby) z zapasem w sondach | realizm miasta i deszczu | Wysoka |
| Wirtualne teksturowanie terenu | unikalny detal na kilometrach bez pamięci | duży projekt |
| Skóra, włosy, tkaniny (rozpraszanie podpowierzchniowe, anizotropia, połysk tkaniny) | zbliżenia postaci | per materiał, umiarkowany |
| Cząstki i symulacje na shaderach obliczeniowych | dym, pył, odłamki w tysiącach | tylko WebGPU |

**Zmiana silnika** ma sens dopiero wtedy, gdy celem przestaje być przeglądarka
i telefon:

| Silnik | Co wnosi | Co się traci |
|---|---|---|
| Unreal Engine 5 | wirtualna geometria (Nanite), dynamiczne światło pośrednie (Lumen), wirtualne mapy cieni, gotowe biblioteki skanów i postaci — faktyczna droga do AAA na komputerze i konsoli | przeglądarkę; praca toczy się w edytorze na plikach binarnych, których model językowy nie zbuduje sam tak jak kodu; na telefonie większość tych technik jest wyłączona |
| Unity 6 (HDRP na komputer, URP na telefon) | dojrzały potok assetów, wypiek światła, eksport na wiele platform | podobnie: edytor w centrum; najwyższa jakość (HDRP) nie działa na telefonie |
| Godot 4 | sceny i skrypty jako tekst — model może je pisać; dynamiczne światło pośrednie w rendererze komputerowym; darmowy | pułap niższy niż Unreal; w przeglądarce tylko uproszczony renderer |
| PlayCanvas / Babylon.js | silniki przeglądarkowe z edytorem, wypiekiem map światła i kompresją w zestawie | pułap ten sam co dziś (ta sama przeglądarka); zysk to narzędzia, nie obraz |

Stan silników zmienia się szybko: przed decyzją sprawdź bieżące wersje
(zwłaszcza eksport do przeglądarki przez WebGPU). Wniosek dla tego projektu:
dopóki gry mają działać w przeglądarce i na telefonie i być budowane przez
model, zysk jest w etapach tego planu, nie w zmianie silnika.
