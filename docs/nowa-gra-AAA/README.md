# Nowa gra AAA — komplet na start od zera

Wszystko, czego model potrzebuje, żeby zbudować nową grę (three.js, WebGPU +
TSL, przeglądarka i APK) możliwie blisko jakości AAA z Twojego opisu.

## Trzy kroki

1. **Skopiuj cały ten katalog** do pustego folderu nowego projektu (albo
   nowego repozytorium).
2. **Opisz grę**: wypełnij `games/nowa-gra/OPIS.md` (rodzaj gry, zasady,
   otoczenie, urządzenia, priorytet — 5 minut) i wrzuć zdjęcia referencyjne do
   `games/nowa-gra/references/`.
3. **Wklej modelowi** treść `FIRST-MESSAGE.md` jako pierwszą wiadomość.

Model zaczyna od Etapu 0 **bez kodu**: pisze brief, tablicę wyglądu, tabelę
budżetów i plan assetów i czeka na Twoją akceptację. Potem idzie etapami 1–8 z
`NOWA-GRA-AAA.md` i po każdym zatrzymuje się z raportem.

## Co tu jest

| Plik / katalog | Po co |
|---|---|
| `NOWA-GRA-AAA.md` | **przewodnik**: reguły R1–R12 (co daje realizm, co musi być najpierw: KTX2, poziomy szczegółowości, mało wariantów shaderów), etapy 0–8 z kryterium odbioru, podział pracy między modele, techniki i silniki na później |
| `FIRST-MESSAGE.md` | pierwsza wiadomość do modelu |
| `games/nowa-gra/OPIS.md` | formularz, który wypełniasz |
| `games/nowa-gra/references/` | Twoje zdjęcia miejsca i nastroju |
| `AGENT.md` | ogólne zasady pracy agenta |
| `START.md` | format raportu po każdym etapie |
| `rules/games-ts-threejs.md` | architektura, fizyka, rendering, płynność, czas ładowania |
| `rules/graphics-quality.md` | kontrakt graficzny: każde wymaganie ma „Must” i „Check” |
| `reference-sheets/` | tablice z liczbami: światło, materiały PBR, skala, balistyka, HUD, budżet |
| `tools/measure/` | zrzuty w stałych widokach, raport ładowania, profil CPU |
| `tools/assets/` | skrypty Blendera: modele pojazdów i broni, postacie, klipy ruchu |
| `shared-src/` | pliki źródłowe do skopiowania bez zmian (rozgrzewka potoków, wspólne shadery instancji, pomiar, szum) |
| `docs/graphics-playbook.md` | jak zbudowano i zmierzono każdą technikę w grach wzorcowych |
| `docs/wytyczne-opus.md` | zasady (§1) i procedura pomiaru (§2) dla prac rutynowych lżejszym modelem; §3–§4 to zadania gier wzorcowych — w nowym projekcie pomiń je, a gałąź i nazwy gier zastąp własnymi |

## Uwagi

- Nazwę `nowa-gra` możesz zmienić (katalog w `games/` i ścieżki w
  `FIRST-MESSAGE.md`).
- **Test bez gotowych rozwiązań:** usuń `docs/` i `shared-src/` i skreśl zdanie
  o nich w `FIRST-MESSAGE.md` — sprawdzasz wtedy, co model wymyśli z samych
  reguł.
- Ten katalog jest **kopią generowaną**: źródłem są pliki w repozytorium FPS
  (`AGENT.md`, `docs/graphics-playbook.md`, `tools/measure/`, …). Ręcznie edytuje
  się tu tylko `README.md`, `NOWA-GRA-AAA.md` i `FIRST-MESSAGE.md`; resztę
  odświeża `bash docs/model-kit/sync.sh`.
- Przebudowa istniejących gier ma własny plan: `docs/przebudowa-gier-aaa.md` w
  repozytorium FPS.
