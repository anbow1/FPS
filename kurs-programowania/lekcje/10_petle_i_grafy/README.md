# Lekcja 10 — Pętle, generatory i programowanie grafowe

Cel: piszesz pętle, które zawsze się kończą, leniwe generatory, klasyczne
algorytmy na grafach (BFS, sortowanie topologiczne) i własny mały silnik
**grafu stanów** — tak jak zbudowane są frameworki agentów (np. LangGraph).

## Teoria

### Pętle — przypomnienie z niuansami

```python
for i, imie in enumerate(["Ala", "Olek"], start=1):   # numer + element
    print(i, imie)
for a, b in zip([1, 2, 3], "abc"):                      # równoległe przechodzenie
    print(a, b)

for liczba in liczby:
    if liczba < 0:
        break          # wyjście z pętli
    if liczba == 0:
        continue       # następny obrót
else:
    print("pętla przeszła bez break")   # rzadko używane, ale bywa przydatne
```

### Pętle, które muszą się skończyć

`while warunek:` kończy się tylko wtedy, gdy warunek kiedyś stanie się fałszem.
W kodzie, który zależy od świata (sieć, model AI, obliczenia numeryczne), dodaj
**bezpiecznik**: maksymalną liczbę iteracji i jasny błąd, gdy go przekroczysz.

```python
for iteracja in range(MAKS_ITERACJI):
    ...
    if gotowe:
        break
else:
    raise RuntimeError(f"brak zbieżności po {MAKS_ITERACJI} iteracjach")
```

### Generatory — pętle na żądanie

Funkcja z `yield` nie liczy wszystkiego naraz — oddaje elementy po jednym,
gdy ktoś o nie poprosi. Oszczędza pamięć (pliki po 10 GB!) i pozwala budować
potoki.

```python
def linie_z_bledem(sciezka):
    with open(sciezka, encoding="utf-8") as plik:
        for linia in plik:                # plik też jest leniwy
            if "ERROR" in linia:
                yield linia.rstrip()

for linia in linie_z_bledem("app.log"):  # czyta tylko tyle, ile trzeba
    print(linia)

kwadraty = (x * x for x in range(10**9))  # wyrażenie generatorowe: nic jeszcze nie policzone
next(kwadraty)                            # 0
```

Typowe wzorce: **partie** (wysyłanie danych do API po 100 sztuk) i **okna
przesuwne** (średnia krocząca, n-gramy, fragmenty tekstu do RAG).

### Grafy

Graf to **węzły** i **krawędzie**. Wszędzie: sieci drogowe, zależności
pakietów, zadania w CI, przepływ w agencie AI.

Najprostsza reprezentacja w Pythonie — **lista sąsiedztwa** w słowniku:

```python
graf = {
    "A": ["B", "C"],     # z A można przejść do B i C (graf skierowany)
    "B": ["D"],
    "C": ["D"],
    "D": [],
}
```

**BFS** (przeszukiwanie wszerz) odwiedza węzły warstwami — w grafie bez wag
znajduje najkrótszą ścieżkę. Potrzebuje kolejki (`collections.deque`) i zbioru
odwiedzonych, żeby nie krążyć w cyklach:

```python
from collections import deque

def bfs(graf, start):
    odwiedzone, kolejka = {start}, deque([start])
    while kolejka:
        wezel = kolejka.popleft()
        for sasiad in graf.get(wezel, []):
            if sasiad not in odwiedzone:
                odwiedzone.add(sasiad)
                kolejka.append(sasiad)
    return odwiedzone
```

### DAG i sortowanie topologiczne

Graf skierowany **bez cykli** (DAG) opisuje zależności: „testy po budowaniu”,
„pandas wymaga numpy”. **Sortowanie topologiczne** daje kolejność, w której
każde zadanie idzie po swoich zależnościach. Algorytm Kahna: bierz zadania bez
niespełnionych zależności, „odhaczaj” je, powtarzaj. Jeśli zostaną zadania,
których nie da się wziąć — jest **cykl**.

### Grafy stanów — jak działają agenci

Pętla agenta z lekcji 09 to też graf: węzeł „model” → (jeśli `tool_use`)
węzeł „narzędzia” → z powrotem do „modelu”; (jeśli `end_turn`) → KONIEC.

```
         ┌──────────────┐
START ─▶ │    model     │ ── end_turn ──▶ KONIEC
         └──────────────┘
            ▲        │ tool_use
            │        ▼
         ┌──────────────┐
         │  narzędzia   │
         └──────────────┘
```

Frameworki jak LangGraph uogólniają to na:

- **stan** — słownik danych płynący przez graf,
- **węzły** — funkcje `stan → aktualizacja stanu`,
- **krawędzie** — stałe („po A zawsze B”) albo **warunkowe** (funkcja patrzy
  na stan i wybiera następny węzeł),
- **cykle** — to właśnie pętle agenta; więc znowu: limit kroków.

Zalety nad jedną wielką pętlą: każdy krok jest osobną, testowalną funkcją,
przepływ widać na diagramie, łatwo wstawić krok „człowiek zatwierdza”.

## Ćwiczenia

1. `partie(elementy, rozmiar)` — generator partii.
2. `okna(sekwencja, rozmiar, krok)` — generator okien przesuwnych.
3. `pierwiastek(liczba, tolerancja, maks_iteracji)` — metoda Newtona z bezpiecznikiem.
4. `najkrotsza_sciezka(graf, start, cel)` — BFS z odtworzeniem ścieżki.
5. `kolejnosc_zadan(zaleznosci)` — sortowanie topologiczne z wykrywaniem cykli.
6. `GrafStanow` — mini-silnik grafu stanów z krawędziami warunkowymi.

## Podpowiedzi

- **cw1**: zbieraj do listy `partia`; gdy `len(partia) == rozmiar`, `yield partia` i zacznij nową. Po pętli oddaj resztę (jeśli niepusta).
- **cw2**: `for poczatek in range(0, len(sekwencja) - rozmiar + 1, krok): yield sekwencja[poczatek:poczatek + rozmiar]`.
- **cw3**: Newton dla √a: `x_nowe = (x + a / x) / 2`, start `x = a` (albo 1 dla a < 1). Koniec, gdy `abs(x_nowe - x) < tolerancja`.
- **cw4**: zamiast zbioru odwiedzonych trzymaj słownik `poprzednik[wezel]`. Po dotarciu do celu idź po poprzednikach wstecz i odwróć listę.
- **cw5**: policz `brakujace[zadanie] = liczba zależności`. Gotowe = te z zerem; bierz zawsze najmniejsze alfabetycznie (`heapq` albo `sorted`), a po wzięciu zmniejsz licznik zadań, które od niego zależą.
- **cw6**: `uruchom`: `biezacy = self.start`; w pętli (z limitem) wywołaj funkcję węzła, scal stan `{**stan, **aktualizacja}`, wybierz następny węzeł: krawędź warunkowa → `funkcja(stan)`, zwykła → cel krawędzi. `KONIEC` kończy.
