# Zestaw dla modelu — gry 3D z realistyczną grafiką (three.js, WebGPU)

Komplet wytycznych do skopiowania i wklejenia dowolnemu modelowi AI, żeby
zbudował grę z takimi samymi regułami graficznymi i jakością jak gry z tego
repozytorium (Field Line, Castaway Lagoon, Tanks). Zawiera zadania dla pięciu
gier i działa też dla nowej gry, jeśli napiszesz do niej brief w tym samym
kształcie.

## Co tu jest

- `dla-modelu/` — wszystko, co dajesz modelowi. Skopiuj zawartość do pustego
  folderu projektu.
  - `START.md` — **gotowy tekst do wklejenia** (wersja krótka i pełna) oraz
    format raportu po każdym etapie.
  - `AGENT.md` — ogólne zasady pracy agenta.
  - `rules/games-ts-threejs.md` — reguły architektury, fizyki, renderingu,
    wydajności i płynności (zaktualizowane o to, co sprawdziło się w trzech
    grach).
  - `rules/graphics-quality.md` — **kontrakt graficzny**: każde wymaganie ma
    „Must” i „Check”, do tego presety Wysoka/Niska, procedura weryfikacji, lista
    odbioru i pułapki, które kosztowały najwięcej czasu.
  - `reference-sheets/` — 6 tablic z liczbami (światło, materiały PBR, skala,
    balistyka, HUD, budżet wydajności) i skrypt, który je generuje.
  - `docs/graphics-playbook.md` — jak zbudowano i zmierzono każdą technikę.
  - `docs/graphics-rules-template.md` — te same reguły jako szablon do
    uzupełnienia (po polsku).
  - `games/` — zadania:
    - `field-line/` — FPS wojskowy (strzelnica, miasto, las z jeziorem) + `target-look/`
    - `castaway-lagoon/` — tropikalna laguna z obozowiskiem + `target-look/`
    - `tanks/` — czołgi na otwartym terenie + `target-look/`
    - `jet-fighter/` — symulator myśliwca (klasa F-35 kontra klasa Su-35)
    - `attack-helicopter/` — symulator śmigłowca szturmowego (klasa AH-64)
- `dla-ciebie/` — tylko dla Ciebie. **Nie dawaj tego modelowi.**
  - `README.md` — protokół uczciwego porównania i arkusz punktów.
  - `grading/<gra>/GRADING.md` — jak sprawdzić i jak rozdzielić 100 punktów.
  - `GRADING-template.md` — szablon oceny dla nowej gry.
- `sync.sh` — odświeża kopie playbooka, szablonu i tablic z ich źródeł w repo,
  żeby zestaw nie rozjechał się z tym, co naprawdę robią gry.

## Jak zacząć

1. Skopiuj zawartość `dla-modelu/` do pustego folderu (wystarczy jeden folder z
   `games/` — tej gry, którą budujesz).
2. Wklej modelowi blok **A** (krótki) albo **B** (pełny) z `START.md`, wpisując
   nazwę gry w miejsce `<GAME>`, np. `jet-fighter`.
3. Po każdym etapie model raportuje w formacie ze `START.md`; sprawdzaj według
   `dla-ciebie/grading/<gra>/GRADING.md`.

Nowa gra: napisz `games/<nowa-gra>/BRIEF.md` w tym samym układzie (co
zbudować, twarde reguły, funkcje z kryteriami akceptacji, budżety, kolejność
budowy) i ocenę z `dla-ciebie/GRADING-template.md`. Reguły i kontrakt graficzny
działają bez zmian.

## Uczciwy test modeli

Usuń wcześniej folder `docs/` z kopii dla modelu: opisuje gotowe rozwiązania i
wskazuje na kod gier wzorcowych. Bez niego sprawdzasz, co model wymyśli z
samych reguł; z nim — jak dobrze wykonuje szczegółowy przepis. Zapisz, który
wariant przeprowadziłeś.

## Uwagi

- Dla myśliwca i śmigłowca nie ma obrazów `target-look/` — poprzeczką jest
  `rules/graphics-quality.md` i tablice. Rubryki ocen dla nich są w
  `dla-ciebie/grading/`.
- Briefy myśliwca i śmigłowca to oryginalne prompty 2 i 4 z dopiskiem „Kit
  notes”: tam, gdzie prompt wymienia stos technologiczny inaczej niż reguły
  (Rapier, glTF/KTX2), wygrywają reguły; tam, gdzie prosi o więcej funkcji lub
  jakości, wygrywa prompt.
- Po zmianie `docs/graphics-playbook.md`, `docs/graphics-rules-template.md` lub
  tablic w `references/` uruchom `docs/model-kit/sync.sh` (Bash; w Windows z Git
  Bash albo WSL).
