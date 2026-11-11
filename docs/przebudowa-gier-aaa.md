# Przebudowa istniejących gier w stronę AAA — wytyczne i instrukcja krok po kroku

Dotyczy pięciu gier z tego repozytorium (Field Line, Castaway Lagoon, Tanks,
Contrail, Ridgeline). Cel: podnieść realizm tam, gdzie obchód zrzutami pokazał
największe braki, **bez wydłużania ładowania i bez spadku płynności** — dlatego
potok idzie przed treścią, a pilot przed powielaniem.

Reguły techniczne: `AGENT.md`, `games-ts-threejs.md`; sposób budowy technik:
`docs/graphics-playbook.md`; narzędzia pomiaru: `tools/measure/`; prace
rutynowe dla lżejszego modelu: `docs/wytyczne-prace-rutynowe.md`. Nowa gra od zera:
`docs/nowa-gra-AAA/NOWA-GRA-AAA.md`.

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

---

## Stan wyjściowy (listopad 2026)

| Gra | Build | Pliki w grze | Najsłabsze miejsca z obchodu |
|---|---|---|---|
| Field Line | 64 MB | 113 tekstur (29 MB) + modele z `shared/` | korony drzew w mieście z wielkich płatów; gałęzie sosen jak pióra; płaskie, powtarzalne elewacje; prześwietlone plamy słońca w lesie; czarne podcienia |
| Castaway Lagoon | 33 MB | 131 tekstur (23 MB) + modele | najlepsza z pięciu; dżungla i palmy wciąż generowane; cykl dobowy wyklucza prosty wypiek światła |
| Tanks | 34 MB | 16 tekstur + modele | trawa w rzędach, odcięta kolorem od podłoża; niebo płaskie i liliowe; domy i asfalt bez faktury |
| Contrail | 21 MB | prawie wszystko generowane | pola w cieniu chmur fioletowe; las jako białe kropki; kokpit — czarna bryła bez detalu |
| Ridgeline | 8 MB | wszystko generowane | łąki jednym odcieniem; rzeka bez brzegu; rama kabiny jak szara glina |

Wspólne: tekstury w JPG/PNG (R6 niespełniona), modele bez łańcucha LOD poza
pojazdami (R7 częściowo), 208–560 potoków na grę przed ostatnimi poprawkami
(R8 częściowo), jedna sonda środowiska (R2 niespełniona), ekranowe AO
wyłączone (R3).

Tanie poprawki z tego samego obchodu (stałe i wzory w istniejących shaderach,
G1–G12 w `docs/wytyczne-prace-rutynowe.md`) **wykonaj przed Etapem 1**: nie zależą od
potoku i od razu podnoszą punkt wyjścia.

---

## Zasady pracy

1. Gałąź, commity, `main` i APK — jak w `docs/wytyczne-prace-rutynowe.md` §1.
2. **Jeden etap naraz, jedna gra naraz.** Etap ma liczby wejścia i wyjścia;
   bez liczb wyjścia nie zaczyna się następny.
3. **Pilot: Field Line.** Największy build, najwięcej tekstur, najsłabsze
   drzewa i architektura — tu każdy element potoku powstaje pierwszy raz.
   Kolejność powielania: Lagoon → Tanks → Ridgeline → Contrail.
4. Każda zmiana obrazu: zrzuty przed/po w tych samych widokach
   (`tools/measure/shots.mjs`); każda zmiana materiałów, tekstur, instancji,
   kamer: `tools/measure/load.mjs` przed/po; draw calle i trójkąty z
   `scripts/benchView.mjs`.
5. Licencje: tylko CC0 i CC BY, wpis w `shared/*/CREDITS.md` razem z plikiem;
   NC zgłoś i nie używaj; oznaczenia i marki zamaluj.
6. Po każdym etapie: wpis do playbooka (co zbudowano, liczby, pułapki),
   `bash docs/model-kit/sync.sh`, prośba do użytkownika o test na telefonie.

---

## Etap 0. Punkt odniesienia (pół dnia, rutyna)

**Stan (2026-11-10):** zrobione na programowym GPU dla pięciu gier (playbook §8.4: potoki, ready / gpu
idle, pamięć tekstur, draw calle i trójkąty Field Line). Brakuje liczb z telefonu.

**Zrób** dla każdej gry, presety Wysoka i Niska:

1. Zrzuty w stałych widokach (polecenia w `docs/wytyczne-prace-rutynowe.md` §3) do
   `shots/baseline/` (poza repozytorium albo w `.gitignore`).
2. `load.mjs --json`: potoki, moduły, uploady, ready, gpu idle.
3. `benchView.mjs --save baseline`: draw calle, trójkąty, czasy.
4. Pamięć tekstur: suma `szerokość × wysokość × 4 × 1,33` po wszystkich
   teksturach (z mipmapami) — dopisz do `load.mjs` zliczanie
   `device.createTexture` (rozmiar, format, poziomy), jeśli go nie ma.
5. Od użytkownika: z telefonu wynik Benchmarku i linia „Loaded in X s”.

**Wynik:** tabela „stan na <data>” na końcu §8.4 playbooka. To jest umowa z
R11: żadna z tych liczb nie rośnie bez zgody.

## Etap 1. Potok — bez zmiany obrazu (R6, R7, R8, R9)

Cel etapu: te same zrzuty, mniejsze liczby. Robi się w pilocie (Field Line),
potem powiela.

### 1a. KTX2 (R6)

1. **Jedna tekstura na próbę.** Zakoduj jeden zestaw podłoża (kolor, normalna,
   ORM) do KTX2: kolor ETC1S albo UASTC wg wyglądu, normalna i ORM w UASTC
   liniowo, mipmapy przy kodowaniu. Narzędzia: KTX-Software (`toktx` / `ktx`)
   albo `basisu`; flagi sprawdź z zainstalowaną wersją i zapisz w skrypcie
   `tools/assets/encode_ktx2.*`.
2. Loader: `KTX2Loader` z `three/addons`, `detectSupport(renderer)` po
   inicjalizacji renderera, transkoder Basis skopiowany do buildu (ścieżka
   względna — APK działa offline).
3. **Zmierz na tej jednej teksturze**: rozmiar pliku, pamięć na GPU, czas
   uploadu (`load.mjs`), zrzut z bliska obok oryginału. Sprawdź oba zaplecza
   (WebGPU i `--gpu webgl`) i telefon. Zapisz wynik w playbooku.
4. Uwaga na to, co dziś czyta piksele na CPU: `photoTextures.ts` dekoduje
   obraz do tablicy i pakuje wysokość do kanału alfa ORM, a warstwy terenu
   składa w `DataArrayTexture`. Skompresowanych tekstur nie da się tak
   przepakować w przeglądarce — **pakowanie przenieś do kodowania offline**
   (gotowa ORM+wysokość, gotowe tablice warstw jako KTX2 z warstwami).
5. Dopiero gdy 1–4 działają: skrypt przepuszcza wszystkie tekstury gry;
   foliaż z zachowaniem pokrycia alfa w mipmapach.
6. Tekstury wbudowane w modele GLB (`shared/`): przekoduj narzędziem do glTF
   (np. `gltf-transform`), rozszerzenie `KHR_texture_basisu`; `GLTFLoader`
   dostaje `setKTX2Loader`.

**Stan (2026-11-10):** pilot zrobiony na atlasach postaci Field Line zamiast tekstury podłoża (atlasy
nie przechodzą przez pakowanie na CPU z punktu 4, a dają największą pamięć na postać): las High
392 → 290 MB tekstur, start nie wolniejszy, WebGPU i WebGL2 ten sam obraz, build +1,6 MB (UASTC jest
większy od JPEG; uzasadnienie i liczby w playbooku §8.4). Powielone (P7, `docs/wytyczne-prace-rutynowe.md`): atlasy Lagoon i Tanks; punkt 6 dla
samochodów miasta (`tools/assets/ktx2_glb.mjs`): miasto High 1265 → 506 MB tekstur, start bez zmian.
Zostały: tekstury podłoża ze zdjęć (punkt 4: pakowanie na CPU do przeniesienia offline) oraz pozostałe
modele GLB (czołgi, ciężarówki, jeep, łodzie, broń).

**Odbiór:** zrzuty nieodróżnialne z odległości gry; pamięć tekstur i czas
uploadu wyraźnie niższe (oczekiwane kilkukrotnie — potwierdź liczbą); build
nie większy; zero błędów na obu zapleczach i na telefonie.

### 1b. Poziomy szczegółowości i kompresja siatek (R7)

**Stan (2026-11-11):** pierwszy krok w mieście Field Line — cienie dalekich aut z `lod2` (proxy tylko w
kaskadach, bez dodatkowych wywołań): High 16,5 → 9,7 mln trójkątów, Low 8,3 → 5,6 mln, obraz i czas
startu bez zmian (`docs/wyniki-testow/`). Widoczny trzeci poziom odrzucony (+112–171 wywołań). Narzędzie:
`tools/measure/passes.mjs`.

1. Spis modeli: trójkąty, tekstury, czy ma LOD (pojazdy z `prepare_vehicle.py`
   mają; broń, skany, ludzie — sprawdź).
2. Każdy model widoczny z ponad 100 m dostaje LOD1/LOD2 skryptem (decymacja z
   zachowaniem sylwetki; tekstury każdego poziomu o połowę mniejsze) i
   impostor, jeśli występuje w dziesiątkach.
3. Przełączanie po rozmiarze na ekranie, przejście ditheringiem (playbook
   §5.5); luneta i celownik używają swojego powiększenia przy wyborze poziomu.
4. Kompresja Meshopt przy eksporcie; `GLTFLoader.setMeshoptDecoder`. Sprawdź
   najpierw, w jakiej kompresji są dziś pliki w `shared/` i czy loader ją
   obsługuje — nie zakładaj.

**Odbiór:** trójkąty w stałych widokach nie większe niż w Etapie 0; brak
„pykania” w powolnym obrocie kamery; rozmiar `shared/` mniejszy.

### 1c. Mniej wariantów shaderów (R8)

1. `load.mjs`: etap z największą liczbą potoków; wypisz, które materiały i
   siatki je budują (tracer z playbooka §9.3).
2. Rutyna (lżejszy model, zadanie P5): `markStaticInstances` wszędzie, gdzie
   siatka jest wypełniana raz; pamięć podręczna materiałów po parametrach;
   `render/instancing.ts` w Tanks, Contrail, Ridgeline.
3. Projekt (mocniejszy model): **materiał rodziny** — jeden materiał dla
   rekwizytów, jeden dla architektury, jeden dla roślin; różnice (kolor,
   szorstkość, zużycie, warstwa atlasu) jako atrybuty instancji lub wierzchołka
   i uniformy. Najpierw rodzina o największej liczbie potoków w pilocie.

**Odbiór:** liczba potoków i gpu idle niższe niż w Etapie 0; zrzuty
identyczne; 0 nowych potoków w trakcie gry.

**Stan (2026-11-11):** Tanks — dwa potoki na materiał na High to lustro wody
rysowane bez MRT sceny. Cel-bliźniak lustra (jak luneta Field Line) dał 321 →
285 potoków, ale klatkę o 5–9 % dłuższą: odrzucony. Przyjęte: rozgrzewka
lustra ukrywa to, co lustro w grze, a deszcz nie trafia do lustra (jego
`mrtNode` łamał tam shader: błąd WGSL z Etapu 0). 321 → 319 potoków, gpu idle
~9 % krócej, 0 błędów (`docs/wyniki-testow`). Dalej: Lagoon (271), P5.

### 1d. Wypiek generacji (R9)

`profile.mjs`: każda funkcja powyżej 1 s czasu własnego podczas ładowania.
Deterministyczny wynik (siatka wysokości, rozsiew, tekstura proceduralna)
zapisz przy budowaniu do pliku binarnego i ładuj; logika gry nadal woła tę
samą funkcję wysokości (jedna funkcja dla logiki i renderu). Jeśli plik byłby
większy niż zysk — wątek roboczy zamiast pliku.

**Odbiór Etapu 1 jako całości:** tabela z Etapu 0 z drugą kolumną; każda
liczba równa lub lepsza; zrzuty bez zmian; potwierdzenie z telefonu.
**Dopiero te liczby mówią, ile nowych assetów mieści Etap 2.**

## Etap 2. Assety (R1, R5, R10)

Budżet etapu = zapas wypracowany w Etapie 1 (pamięć, ładowanie, build).
Kolejność wg tego, co najbardziej zdradza „grę”:

| Priorytet | Co | Gry | Wzór w repozytorium |
|---|---|---|---|
| 1 | **Drzewa i krzewy**: 3+ gatunki na mapę, 2–3 warianty, liście i igły z fotografii (atlas z alfą), LOD + impostor | Field Line (miasto, las), Lagoon (dżungla, palmy), Tanks, Ridgeline | `render/impostor.ts`, playbook §5 |
| 2 | **Architektura**: zestaw modułów (ściana, okno, drzwi, narożnik, gzyms, dach, balkon) + 3–4 materiały elewacji ze skanów; okna z odbiciem nieba i wnętrzem | Field Line (miasto), Tanks (wieś, miasto) | playbook §6d, §6e, §6z2 |
| 3 | **Podłoże**: 4–8 zestawów ze skanów na mapę (już są w FL i Lagoon — przenieś do Tanks i Ridgeline), detal do 10 m, zmienność makro | Tanks, Ridgeline, Contrail (pas startowy, baza) | playbook §6o |
| 4 | **Skały i rekwizyty** ze skanów zamiast brył | wszystkie | playbook §6q |
| 5 | **Kokpity**: przyrządy, przełączniki, obicia jako model + atlas | Contrail, Ridgeline | playbook §6y |
| 6 | **Postacie i broń**: już z modeli; uzupełnij warianty i LOD | Field Line, Lagoon, Tanks | playbook §6s, §6q2 |

**Procedura dla każdej kategorii** (pierwszy egzemplarz — mocniejszy model,
pozostałe — lżejszy wg wzoru):

1. **Wybór i licencja**: źródła CC0 (Poly Haven, ambientCG) i CC BY; zapisz
   autora, adres i licencję w `CREDITS.md`. Sprawdź licencję na stronie
   modelu, nie w wynikach wyszukiwania.
2. **Przygotowanie skryptem** (`paris/tools/vehicles/prepare_*.py`, playbook
   §6q2 krok po kroku): skala w metrach, osie, części ruchome, AO do koloru
   wierzchołków, zamalowane oznaczenia, LOD wg 1b, tekstury KTX2 wg 1a.
3. **Wycinek**: jeden egzemplarz w jednym miejscu mapy w końcowej jakości;
   zrzut z 2 m, 20 m i 200 m obok starego.
4. **Pomiar**: `load.mjs` i `benchView.mjs` — przyrost pamięci, potoków,
   draw calli, ładowania **na jeden egzemplarz**; ekstrapolacja na całą mapę.
   Nie mieści się w zapasie → mniejsze tekstury, mniej wariantów, bliższy LOD;
   nie „zobaczymy później”.
5. **Powielenie** na mapę przez istniejący rozsiew (ta sama funkcja pokrycia);
   stary generator zostaje jako zapas, gdy plik się nie załaduje (tak jak
   proceduralny karabin i jeep dziś).
6. Preset Niska: te same assety, bliższe LOD i mniejsze tekstury — prostsza,
   nie inna.

**Odbiór:** zrzuty obok zdjęć referencyjnych (pętla krytyka, Etap 5); liczby w
budżecie na obu presetach i na telefonie.

## Etap 3. Światło pośrednie i okluzja (R2, R3)

Decyzja wg pory dnia w grze:

| Gra | Pora dnia | Droga |
|---|---|---|
| Field Line | presety (południe, złota godzina, pochmurno, noc) | wypiek na preset: mapy światła dla architektury miasta i wiaty strzelnicy, siatka sond dla postaci, broni, pojazdów; przełączanie uniformem |
| Tanks | presety | jak Field Line, tylko wieś i miasto; teren otwarty zostaje przy sondzie nieba + wypalonej okluzji terenu |
| Castaway Lagoon | płynny cykl + pogoda | siatka sond w obozowisku i pod koronami, 3–4 wypieki kluczowe mieszane po czasie; bez map światła |
| Contrail, Ridgeline | presety, świat 20–100 km | już mają wypiek cieni gór i widoczności nieba na GPU (playbook §12.2); dodać tylko światło w kokpicie (sondy w kabinie) |

**Kroki (pilot: jedna mapa Field Line, jeden preset)**

1. Wypiek w Blenderze (Cycles): druga warstwa UV dla map światła na scalonej
   architekturze; rozdzielczość dobrana do budżetu pamięci z Etapu 1 (mapy
   światła też w KTX2). Samo światło pośrednie i nieba — słońce zostaje
   dynamiczne z kaskadami, żeby cienie postaci i pojazdów się zgadzały.
2. Siatka sond (harmoniki sferyczne niskiego rzędu) jako atlas 2D warstw
   (tekstura 3D w przebiegu `rtt` nie działa w r186 na WebGPU — playbook §11);
   próbkowanie w TSL w materiałach obiektów ruchomych: jedna–dwie próbki.
3. Okluzja: wypalona w każdym nowym modelu; plamy kontaktu pod pojazdami i
   rekwizytami w shaderze podłoża (wzór: `contactOcclusion` w Ridgeline).
4. Ekranowe AO i cienie kontaktowe **tylko Wysoka**, jako osobny, zmierzony
   krok: najpierw zrzut diagnostyczny celu AO (ściany zwrócone do kamery nie
   mogą być czarne), potem koszt w ms z testu wydajności. Jeśli wada r186 nie
   ustąpi — własny, prosty przebieg zamiast GTAO albo nic.

**Odbiór:** podcienie, wnętrze i spód dachu czytelne, nie czarne i nie szare;
koszt klatki na Niskiej bez zmian (wypiek = tekstury, nie przebiegi); 0 nowych
potoków przy zmianie presetu; pamięć w budżecie.

## Etap 4. Ruch (R4)

Kolejność wg tego, jak często gracz to widzi:

1. **Postacie**: klipy z prawdziwego ruchu (`tools/mocap/bake_clip.py`,
   playbook §6s), mieszanie chód–bieg–postawa bez ślizgania stóp, wektory
   ruchu dla TRAA (pułapka `positionPrevious`, playbook §11).
2. **Efekty**: warstwy wybuchu i wystrzału, dym oświetlony i miękki, pył od
   kół, gąsienic i wirnika, odłamki, które zostają (playbook §6f).
3. **Świat reaguje**: trawa się ugina (już jest), gałęzie i krzewy na wybuch i
   przejazd, woda na wszystko, co jej dotyka (playbook §7.7).
4. **Kamera**: drgania z fizyki, bezwładność głowy — jedna globalna siła do
   ściszenia.

**Odbiór:** nagranie albo seria klatek z prawdziwego urządzenia (programowe
GPU nie nadaje się do oceny ruchu); brak smużenia; budżet cząstek i czas CPU
z testu wydajności bez wzrostu ponad zapas.

## Etap 5. Pętla krytyka i telefon (R11, R12)

1. Zrzuty w stałych widokach obok zdjęć prawdziwych miejsc o tej samej porze
   dnia; pięć największych różnic; przyczyna i koszt każdej; naprawa ze
   zrzutem przed/po. Powtarzaj.
2. Na telefonie po każdej rundzie: Benchmark we wszystkich widokach i trzy
   minuty gry.
3. **Koniec** dla danej gry, gdy następna różnica wymaga techniki spoza
   platformy (R12) albo zapasu budżetu, którego nie ma. Zapisz to wprost w
   playbooku jako „pułap tej gry”.

---

## Podział pracy między modele

| Mocniejszy model | Lżejszy model (`docs/wytyczne-prace-rutynowe.md`) |
|---|---|
| pierwszy egzemplarz: KTX2 (1a), materiał rodziny (1c), wypiek światła i sondy (Etap 3) | Etap 0; G1–G12; P1–P6 |
| wybór i ocena assetów, pierwszy egzemplarz każdej kategorii (Etap 2) | przygotowanie kolejnych assetów skryptami, powielenie na mapy i gry |
| ocena w pętli krytyka, decyzje budżetowe | pomiary, zrzuty, tabele, synchronizacja zestawu |

## Czego nie robić

- Nie zaczynaj Etapu 2 bez liczb z Etapu 1: asset bez KTX2 i LOD wydłuża start.
- Nie dodawaj przebiegu renderowania, żeby przykryć słaby asset.
- Nie wymieniaj wszystkiego naraz: kategoria po kategorii, z pomiarem na
  egzemplarz.
- Nie usuwaj generatorów proceduralnych, które służą jako zapas.
- Nie przenoś wypieku światła do gry z płynnym cyklem dobowym bez klatek
  kluczowych.
- Nie obiecuj wirtualnej geometrii, śledzenia promieni ani jakości filmowej
  na telefonie (R12).

---

## Załącznik: co dalej poza tym planem (techniki i silniki)

**W obecnym stosie (three.js + WebGPU)** — po Etapach 1–5, w kolejności zysku:

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
model, zysk jest w Etapach 1–5, nie w zmianie silnika.
