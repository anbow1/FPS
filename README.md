# Tanks

Gra czołgowa 3D w przeglądarce: **TypeScript + Three.js (WebGL2)**, bez żadnych zewnętrznych
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
| LPM | strzał |
| PPM / V | celownik działonowego (3× / 8× / 12×, kółko myszy) |
| R | dalmierz laserowy – mierzy odległość i namierza czołg (znacznik wyprzedzenia) |
| N | kanał termowizyjny (white-hot) |
| 1 / 2 / 3 | APFSDS / HEAT-FS / HE-FRAG |
| F | gaśnica, L – reflektory, C – wolne rozglądanie |
| T | pora dnia, O – jakość, F3 – licznik wydajności, Esc – pauza |

## Co jest „realistyczne”

**Oświetlenie** – według arkusza referencyjnego: natężenie w luksach i EV100 dla każdej pory
(czyste południe 1e5 lx / EV 15,3 … pochmurna noc 0,002 lx), `exposure = 1 / (1.2 · 2^EV100)`,
**pre-exposure** wszystkich świateł (FP16 bez przepełnień), temperatura barwowa słońca i nieba
w kelwinach, ACES filmic (z przełącznikiem AgX do porównania). Lokalne światła w kandelach:
błysk wylotowy 2400 K, płonący wrak ~12 000 cd / 1900 K z migotaniem 4–9 Hz i cieniem,
reflektory ~15 000 cd. Mapa środowiska (IBL) z tego samego nieba, mgła = kolor horyzontu.

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

**HUD** – strefy wg arkusza (16:9, title-safe 90 %, w centralnym okręgu tylko symbole):
wskaźnik wieża/kadłub, dalmierz · amunicja · przeładowanie, siatka + znacznik wyprzedzenia,
minimapa ze stożkiem wieży, stan modułów kadłuba. Na ekranach 21:9 / 32:9 HUD trzyma się
środkowego obszaru 16:9.

**Wydajność** – budżety z arkusza: presety Wysoka / Niska (cienie 4096/2048, GTAO, gęstość
trawy, liczba cząsteczek), stała liczba świateł (bez rekompilacji shaderów), instancing drzew,
skał i kół, geometria łączona per materiał, LOD terenu w kawałkach 128 m. F3 pokazuje draw calls
i trójkąty względem limitów (Wysoka 2500 / 12 M, Niska 1500 / 4 M). Fizyka w stałym kroku 60 Hz
z interpolacją renderu.

## Struktura

```
src/
  config.ts            parametry gry: amunicja, czołgi, presety jakości, budżety
  core/                PRNG, szum, wejście
  render/              pipeline (GTAO, bloom, ACES, SMAA, termowizja), oświetlenie i niebo,
                       materiały PBR, patche shaderów, geometria proceduralna
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
  soczewkowania fal (Wysoka). Na podstawie [Clearwater](https://github.com/Aureliengmz/clearwater)
  (MIT, zob. `THIRD_PARTY_NOTICES.md`).
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

Gra jest opakowana w natywną aplikację przez **Capacitor** (`android/`): pełny ekran, orientacja
pozioma, ekran nie gaśnie. Na ekranach dotykowych włącza się sterowanie dotykowe — lewy
kciuk to joystick jazdy, przeciąganie prawym kciukiem celuje, przyciski OGIEŃ / CEL / ZOOM /
LASER / AMUN. / TERMO / STOP / GAŚ / pauza.

APK buduje workflow `.github/workflows/android.yml` przy każdym pushu na `main` (albo ręcznie:
*Actions → Android APK → Run workflow*). Gotowy plik `tanks-1.0.N.apk` jest w zakładce
**Releases**. Na telefonie: pobierz, otwórz, zezwól na instalację z nieznanych źródeł.
Kolejne wersje instalują się jako aktualizacja (stały klucz `android/app/tanks-sideload.keystore`
— klucz tylko do instalacji bezpośrednich, nie do Google Play).

Lokalnie (wymaga Android SDK i JDK 21): `npm run android:apk` →
`android/app/build/outputs/apk/release/app-release.apk`.

## Publikacja

Workflow `.github/workflows/pages.yml` buduje grę i publikuje ją na GitHub Pages z domyślnej
gałęzi. Jednorazowo: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
