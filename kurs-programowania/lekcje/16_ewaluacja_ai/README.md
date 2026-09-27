# Lekcja 16 — Ewaluacja aplikacji AI (evals)

Cel: sprawdzasz aplikację z modelem AI tak, jak zwykły kod sprawdzasz
testami — zestawem przypadków, automatycznym ocenianiem, porównaniem wersji
i uczciwym „na ile ten wynik jest pewny”.

## Teoria

### Dlaczego zwykłe testy nie wystarczą

Zmieniasz prompt, model albo sposób wyszukiwania w RAG. Trzy pytania, które
sprawdziłeś ręcznie, wyglądają lepiej… a dziesięć innych po cichu się
popsuło. Odpowiedzi modelu są też **niedeterministyczne** i mają wiele
poprawnych form („430 zł”, „430,00 PLN”, „to będzie 430 złotych”). Dlatego:

- zamiast kilku asercji — **zestaw ewaluacyjny** (dziesiątki–setki przypadków),
- zamiast `==` — **oceniacze** tolerujące różne formy poprawnej odpowiedzi,
- zamiast „przechodzi / nie przechodzi” — **wynik procentowy**, porównywany
  między wersjami.

### Anatomia evala

```
zestaw.jsonl ──▶ dla każdego przypadku: model(wejście) ──▶ oceniacz(odpowiedź, przypadek)
                                                                   │
raport: 17/20 = 85%, wg tagów, lista porażek ◀─────────────────────┘
      └─▶ porównanie z poprzednią wersją: regresje i poprawy
```

**Zestaw** (JSON Lines — lekcja 05), jeden przypadek na linię:

```json
{"id": "dostawa-1", "wejscie": "Ile kosztuje kurier?", "oczekiwane": 15, "typ": "liczba", "tagi": ["dostawa"]}
```

Skąd przypadki? Z prawdziwych pytań użytkowników (najcenniejsze), z
przypadków brzegowych, z każdego zgłoszonego błędu (żeby nie wrócił) i z
pytań, na które poprawna odpowiedź brzmi „nie wiem”.

### Rodzaje oceniania

| Sposób | Kiedy | Wady |
|---|---|---|
| **kod**: dokładne dopasowanie po normalizacji | krótkie odpowiedzi, klasyfikacja | zbyt surowy dla swobodnego tekstu |
| **kod**: liczba z tolerancją | obliczenia, ceny | trzeba wyciągnąć liczbę z tekstu |
| **kod**: zawiera / nie zawiera | kluczowe fakty, zakazane treści | nie ocenia sensu |
| **model jako sędzia** (LLM-as-judge) | swobodny tekst, ton, kompletność | kosztuje, sam bywa omylny |
| **człowiek** | kalibracja, trudne przypadki | wolno i drogo |

Zasada: **najtańszy oceniacz, który działa**. Kod tam, gdzie się da; sędzia-model
tylko tam, gdzie trzeba; człowiek do sprawdzania sędziego na próbce.

### Model jako sędzia

Sędzia dostaje pytanie, odpowiedź i **konkretne kryteria**, a zwraca JSON:

```text
Oceń odpowiedź asystenta według kryteriów. Zwróć wyłącznie JSON:
{"ocena": <liczba 1-5>, "uzasadnienie": "<jedno zdanie>"}
```

Dobre praktyki: kryteria punktowane, a nie „czy jest dobra”; prośba o
uzasadnienie; parsowanie odporne na tekst wokół JSON-a; sprawdzenie zgodności
sędziego z oceną człowieka na kilkudziesięciu przypadkach, zanim mu zaufasz.

### Porównywanie wersji

Liczy się nie tylko wynik ogólny (85% → 87%), ale **które przypadki się
zmieniły**. Regresja (przechodził, teraz nie) to sygnał do zbadania — nawet
gdy ogólny wynik wzrósł.

### Ile to naprawdę znaczy? Przedział ufności

17/20 = 85%, ale przy 20 przypadkach prawdziwa skuteczność może łatwo mieć
65% albo 95%. **Przedział Wilsona** podaje zakres wiarygodnych wartości:

```
p = s/n,  z = 1.96 (95%)
środek = (p + z²/2n) / (1 + z²/n)
promień = z · √(p(1−p)/n + z²/4n²) / (1 + z²/n)
```

Jeśli przedziały dwóch wersji mocno się nakładają — różnica może być
przypadkiem. Rozwiązanie: więcej przypadków (i uruchamianie kilka razy).

### Pułapki

- **Przeuczenie na zestawie**: poprawiasz prompt tak długo, aż zda te 20 pytań.
  Trzymaj osobny zestaw kontrolny, którego nie oglądasz przy strojeniu.
- Eval ma być tani i szybki, żeby uruchamiać go przy każdej zmianie — jak CI.
- Jeden błąd modelu (wyjątek, timeout) nie może przerwać całego evala —
  zapisz go jako porażkę przypadku.
- **Oceniacz też bywa błędny.** Zawsze czytaj porażki, a nie tylko wynik
  procentowy. W `demo_eval.py` jest taki przypadek — znajdź go.

### Narzędzia

Na start wystarczy własny skrypt (ćwiczenia) albo pytest. Gdy przypadków i
modeli przybywa: `promptfoo` (konfiguracja w YAML, porównania promptów),
`Inspect` (framework do ewaluacji modeli w Pythonie). W RAG oceniaj osobno
wyszukiwanie (recall@k — lekcja 12) i odpowiedź; w agentach — czy wybrał
właściwe narzędzie z właściwymi argumentami (lekcja 09).

## Ćwiczenia

1. `wczytaj_zestaw(tekst)` — JSON Lines z walidacją.
2. `normalizuj`, `ocena_dokladna`, `ocena_liczbowa`, `ocena_zawiera` — oceniacze kodem.
3. `prompt_sedziego(...)` i `parsuj_werdykt(tekst)` — model jako sędzia.
4. `uruchom_eval(model, przypadki, oceniacz)` — raport z wynikami wg tagów.
5. `porownaj(przed, po)` — regresje i poprawy.
6. `przedzial_wilsona(sukcesy, proby)`.

Potem: `python demo_eval.py` — porównanie dwóch wersji „asystenta” na
`zestaw.jsonl` (z opcją `--claude` dla prawdziwego modelu).

## Podpowiedzi

- **cw1**: `enumerate(tekst.splitlines(), start=1)`, pomiń puste linie, `json.loads`; sprawdzaj pola `id`, `wejscie`, `oczekiwane` i powtórzone `id` (zbiór widzianych). Brak `tagi` → `[]`.
- **cw2**: `normalizuj`: `lower()`, `re.sub(r"[^\w\s]", " ", ...)`, potem `" ".join(tekst.split())`. Liczba: `re.search(r"-?\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?", odpowiedz)`, usuń spacje, zamień `,` na `.`.
- **cw3**: w `parsuj_werdykt` weź tekst od pierwszego `{` do ostatniego `}` i `json.loads`. Sprawdź, że `ocena` to `int` (nie `bool`!) z zakresu 1–5.
- **cw4**: `try: odpowiedz = model(p["wejscie"])` / `except Exception as blad:` → porażka z `f"BŁĄD: {blad}"`. Wynik = zaliczone / wszystkie.
- **cw5**: słowniki `id → zaliczony` z obu raportów; różne zbiory id → `ValueError`.
- **cw6**: wzór z teorii; `math.sqrt`.
