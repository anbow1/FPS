# Wytyczne dla modelu Opus — prace rutynowe w repozytorium FPS

Ten plik spisuje zadania, które **nie wymagają mocniejszego modelu**: są
opisane krok po kroku, mają kryterium odbioru i sposób pomiaru. Mocniejszy
model (Fable) zostaje do projektowania nowych technik, sporów o ocenę obrazu i
debugowania wnętrza three.js — lista w §5.

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
programowe, 800 × 450, preset High. Każde zadanie niżej jest **tanie w sensie
§1.2** (stałe i wzory w istniejących shaderach albo geometria doklejona do
istniejącej siatki). Kolejność = stosunek zysku do ryzyka.

<!-- AUDYT -->

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
