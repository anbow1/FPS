# Tanks

Gra czołgowa 3D w przeglądarce: **TypeScript + Three.js (WebGPU, zapasowo WebGL2; shadery w TSL)**, bez żadnych zewnętrznych
assetów. Teren, las, wioska, czołgi, tekstury i dźwięki powstają proceduralnie w kodzie.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # testy balistyki i pancerza
npm run build      # typecheck + build produkcyjny do dist/
```

## Sterowanie

| Klawisz | Akcja |
| --- | --- |
| W S A D | jazda (A/D obrót kadłuba), Shift – wolno, Spacja – hamulec |
| Mysz | celowanie (wieża nadąża z realną prędkością obrotu) |
| LPM | strzał z armaty |
| PPM / M (przytrzymaj) | karabin maszynowy sprzężony 7,62 mm (800 strz./min, co 4. smugacz) |
| V | celownik działonowego (3× / 8× / 12×, kółko myszy) |
| R | dalmierz laserowy – mierzy odległość i namierza czołg (znacznik wyprzedzenia) |
| N | kanał termowizyjny (white-hot) |
| 1 / 2 / 3 | APFSDS / HEAT-FS / HE-FRAG |
| F | gaśnica, L – reflektory, C – wolne rozglądanie |
| B | dron rozpoznawczy: start / przełączenie widoku dron ↔ czołg |
| G | dron wraca do czołgu |
| Dron: W S A D, E/Spacja, Q/C, Shift, mysz | lot, wznoszenie, opadanie, szybko, kamera; LPM/R oznacza cel, N termowizja |
| T | pora dnia, O – jakość, F3 – licznik wydajności, Esc – pauza |

## Co jest „realistyczne”

**Oświetlenie** – według arkusza referencyjnego: natężenie w luksach i EV100 dla każdej pory
(czyste południe 1e5 lx / EV 15,3 … pochmurna noc 0,002 lx), `exposure = 1 / (1.2 · 2^EV100)`,
**pre-exposure** wszystkich świateł (FP16 bez przepełnień), temperatura barwowa słońca i nieba
w kelwinach, ACES filmic (z przełącznikiem AgX do porównania). Lokalne światła w kandelach:
błysk wylotowy 2400 K, płonący wrak ~12 000 cd / 1900 K z migotaniem 4–9 Hz i cieniem,
reflektory ~15 000 cd. Mapa środowiska (IBL) z tego samego nieba, mgła = kolor horyzontu.

**Atmosfera** – mgła wysokościowa (gęstsza w dolinach, grzbiety i niebo czyste) z rozpraszaniem
Mie w stronę słońca, tym samym co halo nieba, więc odległy teren płynnie przechodzi w horyzont.
Chmury kłębiaste na niebie (pokrycie zależne od pory) dryfują z wiatrem i rzucają na ziemię i wodę
ruchome cienie z tego samego pola gęstości (mnożone w węźle cienia słońca). Promienie słońca (smugi
światła przez drzewa) liczone z bufora głębi, wyłączane gdy słońce jest za kamerą. Mgła to węzeł
`scene.fogNode`, więc dostaje ją każdy materiał – bez dodatkowych przebiegów sceny ani draw calli.

**Materiały PBR** – kolory bazowe i chropowatość z arkusza (NATO green #4B5340 / rough 0,76,
khaki #5C5B3E, guma gąsienic, stal, sadza, rdza, trawa, gleba, skała, błoto, woda, cegła…).
Farba, fosforan, rdza i guma mają metalness 0. Kamuflaż NATO, kurz na dolnych partiach i
powierzchniach poziomych, sadza/rdza na wrakach liczone w shaderze w przestrzeni pojazdu.
Teren: mieszanie warstw wg nachylenia (skała triplanarnie), wysokości (mokre błoto przy wodzie),
drogi gruntowe z koleinami, szczegółowe normalne, mapa makro-wariacji.

**Balistyka** – model punktu materialnego z oporem kwadratowym, jeden integrator dla pocisków
i komputera kierowania ogniem. APFSDS zgodny z arkuszem: 0,32 s @ 500 m, 0,64 s @ 1000 m,
1,30 s @ 2000 m, 2,0 s @ 3000 m; celownik zerowany na 1000 m (−1,0 / 0 / +2,1 / +4,3 mil).
Pokryte testami w `tests/ballistics.test.ts`.

**Pancerz i moduły** – grubość w linii strzału `t / cos θ`, rykoszety, spadek penetracji z
odległością, rozrzut ±8 %. Moduły: silnik, gąsienice, działo, napęd wieży, amunicja, paliwo.
Odłamki po przebiciu, pożary, wybuch amunicji z wyrzuceniem wieży, naprawy polowe.

**Pojazd** – napęd ograniczony mocą i przyczepnością, opór wzniesień, hamulce, obrót w miejscu,
zawieszenie sprężyna-tłumik (nurkowanie przy hamowaniu, kołysanie przy strzale), animowane
koła i gąsienice, ślady gąsienic, łamanie drzew, brodzenie.

**AI** – linia wzroku po terenie, słyszy strzały, wyprzedzenie celu z tym samym solverem co
gracz, strzał z krótkiego postoju, ustawienie kadłuba pod kątem, „strzel i zmień pozycję”.

**Dron rozpoznawczy** – kwadrokopter startujący z czołgu (3 sztuki w zapasie, 40 s
przygotowania kolejnego). Bateria ~160 s, zasięg łącza 1,7 km, pułap 220 m nad terenem, omija
korony drzew. Wszystko, co widzi kamera (stożek + linia wzroku), trafia na minimapę i jako znaczniki
na ekran na 25 s. Wrogie czołgi strzelają do niego z wkm 12,7 mm (zielone smugacze), a strzelcy
piechoty z karabinków – można go zestrzelić. Automatyczny powrót przy słabym sygnale lub baterii.

**Piechota w zasadzkach** – od pierwszej fali drużyny (granatnik RPG + strzelcy) chowają się w
lesie i przy budynkach między graczem a wrogiem. Granatnik celuje 2–3 s z wyprzedzeniem, rakieta
ma własną balistykę i głowicę kumulacyjną; strzelcy prowadzą ogień seriami do czołgu i drona.
Piechota ucieka przed czołgiem, ginie od karabinu sprzężonego, odłamków HE i gąsienic.
Wypatrzyć ją najłatwiej dronem albo w termowizji.

**HUD** – strefy wg arkusza (16:9, title-safe 90 %, w centralnym okręgu tylko symbole):
wskaźnik wieża/kadłub, dalmierz · amunicja · przeładowanie, siatka + znacznik wyprzedzenia,
minimapa ze stożkiem wieży, dronem i wykrytą piechotą, stan modułów kadłuba. Na ekranach 21:9 / 32:9 HUD trzyma się
środkowego obszaru 16:9.

**Architektura** – ta sama co w Field Line i Castaway Lagoon (anbow1/FPS): `WebGPURenderer`
(WebGPU, a gdy go brak – jego własny backend WebGL2), materiały węzłowe TSL zamiast łatek
`onBeforeCompile`, jeden `RenderPipeline`: przebieg sceny HDR → TRAA (Wysoka) → GTAO (Wysoka) →
promienie słońca → bloom → ekspozycja / ACES / sRGB → termowizja → wyostrzenie (Wysoka) / FXAA
(Niska). Cienie kaskadowe (CSM), cząsteczki jako instancjonowane sprite'y. Wspólne pliki:
`render/perf.ts` (czas GPU na przebieg, regulator klatek), `render/benchRecorder.ts` (test
wydajności), `render/warmup.ts` (kompilacja wszystkich shaderów przy ładowaniu),
`render/webgpuCompat.ts`.

**Wydajność** – budżety z arkusza: presety Wysoka / Niska (cienie CSM 3×2048 / 2×1024, GTAO, gęstość
trawy, liczba cząsteczek), stała liczba świateł (bez rekompilacji shaderów), instancing drzew,
skał i kół, geometria łączona per materiał, LOD terenu w kawałkach 128 m. F3 pokazuje draw calls
i trójkąty względem limitów (Wysoka 2500 / 12 M, Niska 1500 / 4 M), backend i czas GPU na przebieg
(na WebGPU). Fizyka w stałym kroku 60 Hz z interpolacją renderu. **Test wydajności** (przycisk w
menu albo `?bench`) objeżdża pięć stałych punktów i podaje tabelę do skopiowania;
`scripts/benchView.mjs` robi to samo w przeglądarce bez okna i porównuje przebiegi.

**Płynność** – gra pilnuje 60 kl./s kosztem obrazu, nigdy rozgrywki: regulator czasu klatki
(percentyle z okna 1 s, odporny na pojedyncze przycięcia) najpierw wyłącza AO, potem promienie
słońca, potem obniża rozdzielczość renderu w krokach 100 → 58 %, a wraca w górę ostrożnie i bez
oscylacji (F3 pokazuje bieżący poziom); krok, który niczego nie przyspieszył (ekran 30 Hz), cofa. Wszystkie shadery – efekty, smugacze, dron, termowizja, FFT wody, promienie słońca
– kompilują się przy ładowaniu, a zmiana pory dnia (T) nie wymusza rekompilacji. Trawa dobudowuje
się porcjami po ~1300 źdźbeł na klatkę i wysyła do GPU tylko użyte wierzchołki; AI sprawdza
kierunki jazdy 10 razy na sekundę; gorące pętle alokują ~3× mniej pamięci niż wcześniej (rzadsze GC).

## Struktura

```
src/
  config.ts            parametry gry: amunicja, czołgi, presety jakości, budżety
  core/                PRNG, szum, wejście
  render/              pipeline (TRAA, GTAO, bloom, ACES, FXAA, termowizja), oświetlenie i niebo,
                       materiały PBR i węzły TSL, FFT wody, pomiar i regulator, geometria
  world/               heightfield, teren z LOD, roślinność, trawa, woda, budynki, decale
  game/                czołg (fizyka, moduły), model czołgu, balistyka, pancerz, pociski,
                       AI, efekty, dźwięk, logika gry
  ui/                  HUD, minimapa, style
tests/                 vitest: balistyka, pancerz
```

## Woda, las, budynki, ziemia

- **Jeziora** — fale z widma wiatrowego liczone FFT na GPU (Tessendorf), dokładny Fresnel,
  odblaski słońca Beckmann + LEAN (wariancja nachyleń z mipmap), załamany widok dna śledzony po
  prawdziwej wysokości terenu, absorpcja Beer–Lamberta i rozpraszanie w toni, kaustyki z
  soczewkowania fal (Wysoka), piana przy brzegu. Na podstawie [Clearwater](https://github.com/Aureliengmz/clearwater)
  i [WaterCuda](https://github.com/SamG-Coder/WaterCuda) (MIT, zob. `THIRD_PARTY_NOTICES.md`).
- **Las** — świerki z okółków gałęzi na kartach alpha-clip z proceduralnymi igłami, brzozy z
  kępami liści i jasną korą; normalne wygięte na zewnątrz korony, przeświecanie pod słońce,
  wiatr, korekta mipmap alfy.
- **Budynki** — cegła z fugą, tynk odpadający płatami, dachówka z mchem, deski, blacha falista z
  rdzą; zawilgocenie przy ziemi i zacieki; ramy okien, parapety, rynny, deski okapowe, kominy.
  Wszystko proceduralnie w shaderze (bump z pochodnych), z filtrowaniem przeciw aliasingowi.
- **Ziemia** — generowane tekstury bliskiego planu (łąka, gleba z kamykami, granit ze
  spękaniami i porostami, błoto z kałużami), mieszane po wysokości i próbkowane stochastycznie
  (bez widocznego powtarzania).

## Android (APK)

Gra jest jednym z wariantów wspólnej aplikacji Androida w tym repozytorium
([`android/`](../android)): pełny ekran, orientacja pozioma, ekran nie gaśnie. Na ekranach
dotykowych włącza się sterowanie dotykowe — lewy kciuk to joystick jazdy, przeciąganie prawym
kciukiem celuje, przyciski OGIEŃ / CEL / ZOOM / LASER / AMUN. / TERMO / STOP / GAŚ / pauza.

APK buduje workflow `.github/workflows/android.yml` (w katalogu głównym repozytorium) przy każdym
pushu na `main`; plik `tanks.apk` jest w wydaniu **android-latest**. Na telefonie: pobierz,
otwórz, zezwól na instalację z nieznanych źródeł. Kolejne wersje instalują się jako aktualizacja,
także na wersję zbudowaną wcześniej w osobnym repozytorium `anbow1/tanks` (ten sam identyfikator
`io.github.anbow1.tanks` i ten sam klucz `android/app/tanks-sideload.keystore` — klucz tylko do
instalacji bezpośrednich, nie do Google Play).

Lokalnie: `bash android/build-apks.sh` z katalogu głównego repozytorium.
