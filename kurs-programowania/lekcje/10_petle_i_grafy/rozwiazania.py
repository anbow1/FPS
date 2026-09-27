# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: zbieraj do listy, yield gdy pełna, na końcu reszta
    if rozmiar < 1:
        raise ValueError(f"rozmiar partii musi być >= 1, dostałem {rozmiar}")
    partia: list[T] = []
    for element in elementy:
        partia.append(element)
        if len(partia) == rozmiar:
            yield partia
            partia = []
    if partia:
        yield partia
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def okna(sekwencja: Sequence[T], rozmiar: int, krok: int = 1) -> Iterator[Sequence[T]]:
    """Okna przesuwne długości `rozmiar`, przesuwane o `krok`. Tylko pełne okna.

    >>> list(okna("abcde", 3))
    ['abc', 'bcd', 'cde']
    >>> list(okna([1, 2, 3, 4, 5], 2, krok=2))
    [[1, 2], [3, 4]]
    rozmiar < 1 albo krok < 1 → ValueError.
    """
    # ROZWIĄZANIE-START: range(0, len - rozmiar + 1, krok) i wycinki
    if rozmiar < 1 or krok < 1:
        raise ValueError(f"rozmiar i krok muszą być >= 1, dostałem rozmiar={rozmiar}, krok={krok}")
    for poczatek in range(0, len(sekwencja) - rozmiar + 1, krok):
        yield sekwencja[poczatek : poczatek + rozmiar]
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def pierwiastek(liczba: float, tolerancja: float = 1e-10, maks_iteracji: int = 100) -> tuple[float, int]:
    """Pierwiastek kwadratowy metodą Newtona. Zwraca (wynik, liczba_iteracji).

    - liczba < 0 → ValueError; liczba == 0 → (0.0, 0),
    - iteruj x = (x + liczba / x) / 2, start x = max(liczba, 1.0),
    - koniec, gdy |x_nowe - x| < tolerancja (liczymy tę iterację),
    - brak zbieżności po maks_iteracji → RuntimeError.
    """
    # ROZWIĄZANIE-START: for iteracja in range(1, maks_iteracji + 1): ...
    if liczba < 0:
        raise ValueError(f"pierwiastek z liczby ujemnej ({liczba}) nie jest liczbą rzeczywistą")
    if liczba == 0:
        return 0.0, 0
    x = max(liczba, 1.0)
    for iteracja in range(1, maks_iteracji + 1):
        x_nowe = (x + liczba / x) / 2
        if abs(x_nowe - x) < tolerancja:
            return x_nowe, iteracja
        x = x_nowe
    raise RuntimeError(f"brak zbieżności po {maks_iteracji} iteracjach (ostatnie x={x})")
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def najkrotsza_sciezka(graf: dict[str, list[str]], start: str, cel: str) -> list[str] | None:
    """Najkrótsza ścieżka (lista węzłów od start do cel włącznie) w grafie skierowanym bez wag.

    Brak ścieżki → None. start == cel → [start]. Sąsiadów odwiedzaj w kolejności z listy.
    Węzeł może nie mieć własnego klucza w słowniku — wtedy nie ma sąsiadów.
    """
    # ROZWIĄZANIE-START: BFS z deque i słownikiem poprzedników
    poprzednik: dict[str, str | None] = {start: None}
    kolejka = deque([start])
    while kolejka:
        wezel = kolejka.popleft()
        if wezel == cel:
            sciezka = []
            biezacy: str | None = wezel
            while biezacy is not None:
                sciezka.append(biezacy)
                biezacy = poprzednik[biezacy]
            return sciezka[::-1]
        for sasiad in graf.get(wezel, []):
            if sasiad not in poprzednik:
                poprzednik[sasiad] = wezel
                kolejka.append(sasiad)
    return None
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def kolejnosc_zadan(zaleznosci: dict[str, list[str]]) -> list[str]:
    """Sortowanie topologiczne. zaleznosci[zadanie] = lista zadań, które muszą być PRZED nim.

    - zadania wymienione tylko jako zależność też trafiają do wyniku,
    - spośród gotowych zawsze bierz najmniejsze alfabetycznie (wynik deterministyczny),
    - cykl → ValueError z posortowaną listą zadań, których nie dało się ułożyć.

    >>> kolejnosc_zadan({"test": ["build"], "build": ["install"], "deploy": ["test"]})
    ['install', 'build', 'test', 'deploy']
    """
    # ROZWIĄZANIE-START: algorytm Kahna z heapq
    wszystkie = set(zaleznosci)
    for wymagane in zaleznosci.values():
        wszystkie.update(wymagane)
    brakujace = {zadanie: len(set(zaleznosci.get(zadanie, []))) for zadanie in wszystkie}
    nastepcy: dict[str, list[str]] = {zadanie: [] for zadanie in wszystkie}
    for zadanie, wymagane in zaleznosci.items():
        for wymagane_zadanie in set(wymagane):
            nastepcy[wymagane_zadanie].append(zadanie)

    gotowe = [zadanie for zadanie, liczba in brakujace.items() if liczba == 0]
    heapq.heapify(gotowe)
    kolejnosc = []
    while gotowe:
        zadanie = heapq.heappop(gotowe)
        kolejnosc.append(zadanie)
        for nastepca in nastepcy[zadanie]:
            brakujace[nastepca] -= 1
            if brakujace[nastepca] == 0:
                heapq.heappush(gotowe, nastepca)
    if len(kolejnosc) != len(wszystkie):
        w_cyklu = sorted(wszystkie - set(kolejnosc))
        raise ValueError(f"cykl w zależnościach; nie da się ułożyć: {', '.join(w_cyklu)}")
    return kolejnosc
    # ROZWIĄZANIE-KONIEC


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
        # ROZWIĄZANIE-START: słowniki węzłów i wyjść, start = None
        self.wezly: dict[str, Callable[[Stan], Stan]] = {}
        self.wyjscia: dict[str, str | Callable[[Stan], str]] = {}
        self.start: str | None = None
        # ROZWIĄZANIE-KONIEC

    def dodaj_wezel(self, nazwa: str, funkcja: Callable[[Stan], Stan]) -> None:
        # ROZWIĄZANIE-START
        if nazwa == KONIEC or nazwa in self.wezly:
            raise ValueError(f"węzeł '{nazwa}' już istnieje albo nazwa jest zarezerwowana")
        self.wezly[nazwa] = funkcja
        # ROZWIĄZANIE-KONIEC

    def dodaj_krawedz(self, z: str, do: str) -> None:
        # ROZWIĄZANIE-START
        self._sprawdz_wyjscie(z)
        if do != KONIEC and do not in self.wezly:
            raise ValueError(f"krawędź do nieznanego węzła '{do}'")
        self.wyjscia[z] = do
        # ROZWIĄZANIE-KONIEC

    def dodaj_krawedz_warunkowa(self, z: str, wybor: Callable[[Stan], str]) -> None:
        # ROZWIĄZANIE-START
        self._sprawdz_wyjscie(z)
        self.wyjscia[z] = wybor
        # ROZWIĄZANIE-KONIEC

    def ustaw_start(self, nazwa: str) -> None:
        # ROZWIĄZANIE-START
        if nazwa not in self.wezly:
            raise ValueError(f"start w nieznanym węźle '{nazwa}'")
        self.start = nazwa
        # ROZWIĄZANIE-KONIEC

    def uruchom(self, stan: Stan, maks_krokow: int = 25) -> tuple[Stan, list[str]]:
        # ROZWIĄZANIE-START: pętla z limitem; zwykła krawędź to str, warunkowa to funkcja
        if self.start is None:
            raise ValueError("najpierw ustaw_start(...)")
        stan = dict(stan)
        sciezka: list[str] = []
        biezacy = self.start
        for _ in range(maks_krokow):
            stan = {**stan, **self.wezly[biezacy](stan)}
            sciezka.append(biezacy)
            if biezacy not in self.wyjscia:
                raise RuntimeError(f"węzeł '{biezacy}' nie ma wyjścia")
            wyjscie = self.wyjscia[biezacy]
            nastepny = wyjscie if isinstance(wyjscie, str) else wyjscie(stan)
            if nastepny == KONIEC:
                return stan, sciezka
            if nastepny not in self.wezly:
                raise RuntimeError(f"z '{biezacy}' wybrano nieznany węzeł '{nastepny}'")
            biezacy = nastepny
        raise RuntimeError(f"graf nie doszedł do KONIEC w {maks_krokow} krokach; ścieżka: {sciezka[-5:]}")

    def _sprawdz_wyjscie(self, z: str) -> None:
        if z not in self.wezly:
            raise ValueError(f"krawędź z nieznanego węzła '{z}'")
        if z in self.wyjscia:
            raise ValueError(f"węzeł '{z}' ma już wyjście")
        # ROZWIĄZANIE-KONIEC
