# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 10   (albo: python kurs.py obserwuj 10)
"""Lekcja 10 — pętle, generatory i grafy."""

import heapq
from collections import deque
from collections.abc import Callable, Iterable, Iterator, Sequence
from typing import Any, TypeVar

T = TypeVar("T")
KONIEC = "__koniec__"
Stan = dict[str, Any]


# Ćwiczenie 1
def partie(elementy: Iterable[T], rozmiar: int) -> Iterator[list[T]]:
    """Generator partii po `rozmiar` elementów; ostatnia może być krótsza.

    >>> list(partie(range(5), 2))
    [[0, 1], [2, 3], [4]]
    rozmiar < 1 → ValueError (zgłoszony od razu przy pierwszym next()).
    """
    # Podpowiedź: zbieraj do listy, yield gdy pełna, na końcu reszta
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def okna(sekwencja: Sequence[T], rozmiar: int, krok: int = 1) -> Iterator[Sequence[T]]:
    """Okna przesuwne długości `rozmiar`, przesuwane o `krok`. Tylko pełne okna.

    >>> list(okna("abcde", 3))
    ['abc', 'bcd', 'cde']
    >>> list(okna([1, 2, 3, 4, 5], 2, krok=2))
    [[1, 2], [3, 4]]
    rozmiar < 1 albo krok < 1 → ValueError.
    """
    # Podpowiedź: range(0, len - rozmiar + 1, krok) i wycinki
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def pierwiastek(liczba: float, tolerancja: float = 1e-10, maks_iteracji: int = 100) -> tuple[float, int]:
    """Pierwiastek kwadratowy metodą Newtona. Zwraca (wynik, liczba_iteracji).

    - liczba < 0 → ValueError; liczba == 0 → (0.0, 0),
    - iteruj x = (x + liczba / x) / 2, start x = max(liczba, 1.0),
    - koniec, gdy |x_nowe - x| < tolerancja (liczymy tę iterację),
    - brak zbieżności po maks_iteracji → RuntimeError.
    """
    # Podpowiedź: for iteracja in range(1, maks_iteracji + 1): ...
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def najkrotsza_sciezka(graf: dict[str, list[str]], start: str, cel: str) -> list[str] | None:
    """Najkrótsza ścieżka (lista węzłów od start do cel włącznie) w grafie skierowanym bez wag.

    Brak ścieżki → None. start == cel → [start]. Sąsiadów odwiedzaj w kolejności z listy.
    Węzeł może nie mieć własnego klucza w słowniku — wtedy nie ma sąsiadów.
    """
    # Podpowiedź: BFS z deque i słownikiem poprzedników
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def kolejnosc_zadan(zaleznosci: dict[str, list[str]]) -> list[str]:
    """Sortowanie topologiczne. zaleznosci[zadanie] = lista zadań, które muszą być PRZED nim.

    - zadania wymienione tylko jako zależność też trafiają do wyniku,
    - spośród gotowych zawsze bierz najmniejsze alfabetycznie (wynik deterministyczny),
    - cykl → ValueError z posortowaną listą zadań, których nie dało się ułożyć.

    >>> kolejnosc_zadan({"test": ["build"], "build": ["install"], "deploy": ["test"]})
    ['install', 'build', 'test', 'deploy']
    """
    # Podpowiedź: algorytm Kahna z heapq
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
class GrafStanow:
    """Mini-silnik grafu stanów (w duchu LangGraph).

    graf = GrafStanow()
    graf.dodaj_wezel("planuj", funkcja)            # funkcja(stan) -> dict z aktualizacją stanu
    graf.dodaj_krawedz("planuj", "dzialaj")        # po "planuj" zawsze "dzialaj"
    graf.dodaj_krawedz_warunkowa("dzialaj", wybor) # wybor(stan) -> nazwa węzła albo KONIEC
    graf.ustaw_start("planuj")
    stan, sciezka = graf.uruchom({"proby": 0}, maks_krokow=20)

    Zasady:
    - dodanie węzła o istniejącej nazwie albo o nazwie KONIEC → ValueError,
    - każdy węzeł ma najwyżej jedno wyjście (zwykłe LUB warunkowe); drugie → ValueError,
    - krawędź z/do nieznanego węzła → ValueError (cel KONIEC jest dozwolony),
    - uruchom bez ustawionego startu → ValueError,
    - węzeł bez wyjścia albo wybór nieznanego węzła w trakcie → RuntimeError,
    - stan scalamy: nowy = {**stary, **aktualizacja}; wejściowego słownika nie zmieniamy,
    - `sciezka` = nazwy wykonanych węzłów po kolei,
    - więcej niż maks_krokow wykonanych węzłów → RuntimeError.
    """

    def __init__(self) -> None:
        # Podpowiedź: słowniki węzłów i wyjść, start = None
        raise NotImplementedError("Do zrobienia")

    def dodaj_wezel(self, nazwa: str, funkcja: Callable[[Stan], Stan]) -> None:
        raise NotImplementedError("Do zrobienia")

    def dodaj_krawedz(self, z: str, do: str) -> None:
        raise NotImplementedError("Do zrobienia")

    def dodaj_krawedz_warunkowa(self, z: str, wybor: Callable[[Stan], str]) -> None:
        raise NotImplementedError("Do zrobienia")

    def ustaw_start(self, nazwa: str) -> None:
        raise NotImplementedError("Do zrobienia")

    def uruchom(self, stan: Stan, maks_krokow: int = 25) -> tuple[Stan, list[str]]:
        # Podpowiedź: pętla z limitem; zwykła krawędź to str, warunkowa to funkcja
        raise NotImplementedError("Do zrobienia")
