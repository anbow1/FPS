# Paris — dziesięć sekund bulwaru

Krótki film w czasie rzeczywistym: **TypeScript + Three.js r186 (WebGPU, zapasowo WebGL2; shadery w TSL)**.
Haussmannowski bulwar w centrum Paryża o złotej godzinie, pod koniec października: ruch uliczny
zatrzymany na czerwonym, ludzie przechodzący po zebrze, przechodnie w obie strony, goście w
ogródkach kawiarni, rowerzyści, gołębie, platany gubiące liście, a na końcu perspektywy wieża
w wieczornej mgiełce. Zbudowany według `docs/graphics-playbook.md` jako sprawdzian playbooka
w praktyce.

Na Windows najprościej: dwuklik na `start.bat` (doinstaluje zależności i otworzy przeglądarkę).
Samego pliku `index.html` nie da się otworzyć z dysku: przeglądarka blokuje moduły i tekstury z `file://`,
potrzebny jest serwer (Vite). Po `git pull` z nowymi zależnościami trzeba ponownie `npm install`.

```bash
npm install
npm run dev                  # http://localhost:5173 — scena w czasie rzeczywistym (pętla 10 s)
npm test                     # plan ulicy, model kierowcy (IDM), tłum
npm run build                # typecheck + build do dist/
```

Tryby strony:

| Adres | Co robi |
| --- | --- |
| `/` | odtwarza 10 s w pętli w czasie rzeczywistym |
| `/?t=4.2&w=1920&h=1080` | renderuje kadr z chwili 4,2 s (`window.__paris.still`, PNG) |
| `/?record&w=1920&h=1080&ss=2&format=jpeg` | tryb nagrywania: `window.__paris.renderFrame(i)` renderuje klatkę *i* (25 kl./s, `ss`× supersampling) i zwraca PNG lub JPEG |
| `&cam=x,y,z,lx,ly,lz` | kamera debugowa; `&hide=people,traffic`, `&nofog`, `&nopost`, `&post=scene\|aa\|vel` |

Nagranie filmu (Playwright + ffmpeg):

```bash
npm run build && npx vite preview --port 4180 &
node scripts/record.mjs http://localhost:4180/ out 1920 1080 /ścieżka/do/ffmpeg 2   # → out/paris.mp4
```

Każda klatka jest symulowana i renderowana po kolei (deterministycznie, ten sam ziarno → ten sam film)
w `ss`-krotnej rozdzielczości (domyślnie 2× — supersampling), a ffmpeg zmniejsza ją filtrem Lanczosa
i dopiero wtedy dodaje ziarno kliszy (w stronie zostałoby uśrednione i psułoby kompresję).
W kontenerze bez GPU (SwiftShader) 1080p bez supersamplingu kosztuje ok. 18 s na klatkę, z 2× kilka razy więcej.

## Co jest w środku

- **Kamienice** (`city/facade.ts`, `city/roof.ts`): prawdziwe otwory okien z głębokimi na 24 cm
  ościeżami (niskie słońce rysuje ich cienie), ciągłe balkony piętra szlachetnego i 5. piętra na
  wspornikach, gzymsy międzykondygnacyjne i wieńczący z modylionami, boniowany parter i antresola,
  obramienia i frontony okien, cynkowe mansardy z lukarnami i kominy z rzędami glinianych nasad.
  Wysokości kondygnacji i linia gzymsu ~20 m według przepisów z 1859 i 1884 r.
- **Materiały** (`render/architecture.ts`, `render/windows.ts`): wapień lutecki (ciosy, spoiny,
  smugi sadzy pod gzymsami), cynk z rąbkami i nalotem, balustrady z kutego żelaza jako maska
  (cień ma wzór), okna francuskie z pokojami za szybą (interior mapping), firankami i zasłonami,
  odbiciem Fresnela; witryny sklepów z oświetlonym wnętrzem, szyldy z „napisami”, brama wjazdowa.
- **Ulica** (`render/ground.ts`): asfalt z koleinami i łatami, pasy, zebry i linie zatrzymania,
  granitowe krawężniki i rynsztok z kostki z płynącą wodą, żeliwne kraty wokół drzew, opadłe
  liście platanów — wszystko liczone z położenia, bez powtarzającej się tekstury.
- **Platany** (`city/trees.ts`): łaciata kora, korony z kart liści (5-klapowych), jesienne barwy,
  prześwit słońca przez liście, wiatr.
- **Ludzie** (`life/body.ts`, `life/people.ts`, `life/crowd.ts`): cztery sylwetki (płaszcze,
  kurtki, spódnica), skinning instancyjny i chód z motion capture CMU (z Field Line), mijanie
  z prawej, omijanie kiosków i ogródków, przejście przez zebrę na czerwonym, rozmowy, siedzący
  w kawiarni, rowerzyści (IK do pedałów i kierownicy). Bliscy w pełnym modelu, dalecy w uproszczonym.
- **Ruch** (`life/traffic.ts`, `life/vehicles.ts`): model IDM (Treiber 2000), światła na
  pierwszym skrzyżowaniu, kolejka ruszająca na zielonym, samochody z Field Line (obracające się
  koła, światła stop), taksówki, autobusy, zaparkowane auta.
- **Światło** (`render/lighting.ts`, `render/stage.ts`): słońce 9000 lx / 3300 K na 11° nad
  horyzontem, niebo 3600 lx, pre-exposure EV 12, niebo Preethama skalibrowane do luksów, HDRI ulicy
  (Poly Haven, CC0) dla otoczenia i odbić, mgła wysokościowa z poświatą w stronę słońca,
  4 kaskady cieni, TRAA, rozmycie ruchu z migawką 180°, bloom, halacja (czerwono-pomarańczowa poświata
  świateł, jak na kliszy), aberracja chromatyczna obiektywu, ACES, wyostrzenie; supersampling 2× i ziarno
  w nagrywarce.

Wszystkie pojazdy, szyldy i oznaczenia są wymyślone, bez marek.
