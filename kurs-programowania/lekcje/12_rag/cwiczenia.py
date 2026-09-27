# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 12   (albo: python kurs.py obserwuj 12)
"""Lekcja 12 — RAG od zera."""

import math
import re
import zlib
from collections.abc import Callable
from dataclasses import dataclass

Wektor = list[float]

INSTRUKCJA = (
    "Odpowiedz na pytanie, korzystając WYŁĄCZNIE z poniższych źródeł.\n"
    "Po każdym fakcie podaj numer źródła w nawiasie kwadratowym, np. [1].\n"
    'Jeśli źródła nie zawierają odpowiedzi, napisz: "Nie wiem na podstawie dostępnych dokumentów."'
)
BRAK_ODPOWIEDZI = "Nie znalazłem informacji na ten temat w dokumentach."
# Dobrane ręcznie na dokumentach z katalogu dokumenty/: najlepsze trafienie dla pytań na temat
# ma >= 0.28, dla pytań nie na temat <= 0.23. Prawdziwe embeddingi rozdzielają to dużo wyraźniej.
DOMYSLNY_PROG = 0.25


# --- gotowe funkcje pomocnicze (z lekcji 11, lekko ulepszone) ------------------


def tokenizuj(tekst: str) -> list[str]:
    return re.findall(r"\w+", tekst.lower())


def embedding_haszujacy(tekst: str, wymiar: int = 512) -> Wektor:
    """Hashing trick na słowach i trójkach liter.

    Trójki liter ("zwr", "wro", "rot"…) sprawiają, że "zwrot" i "zwrotu" są
    blisko — ważne w polskim z jego odmianą.
    """
    wektor = [0.0] * wymiar
    for slowo in tokenizuj(tekst):
        cechy = [slowo] + [slowo[i : i + 3] for i in range(max(1, len(slowo) - 2))]
        for cecha in cechy:
            wektor[zlib.crc32(cecha.encode("utf-8")) % wymiar] += 1.0
    norma = math.sqrt(sum(x * x for x in wektor))
    return [x / norma for x in wektor] if norma else wektor


def cosinus(a: Wektor, b: Wektor) -> float:
    norma = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return sum(x * y for x, y in zip(a, b)) / norma if norma else 0.0


@dataclass(frozen=True)
class Fragment:
    zrodlo: str  # np. "zwroty#0" — plik i numer fragmentu
    tekst: str
    wektor: Wektor


# --- ćwiczenia -------------------------------------------------------------------


# Ćwiczenie 1
def podziel_na_fragmenty(tekst: str, rozmiar: int, zakladka: int) -> list[str]:
    """Dzieli tekst na fragmenty po `rozmiar` słów; kolejne zaczynają się co (rozmiar - zakladka) słów.

    - słowa łączymy pojedynczą spacją,
    - ostatni fragment może być krótszy; kończymy na pierwszym fragmencie sięgającym końca,
    - pusty tekst → [],
    - rozmiar < 1, zakladka < 0 albo zakladka >= rozmiar → ValueError.

    >>> podziel_na_fragmenty("a b c d e f g", 3, 1)
    ['a b c', 'c d e', 'e f g']
    """
    # Podpowiedź: slowa = tekst.split(); krok = rozmiar - zakladka
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def zbuduj_indeks(dokumenty: dict[str, str], rozmiar: int = 40, zakladka: int = 10) -> list[Fragment]:
    """Indeks: fragmenty wszystkich dokumentów (w kolejności słownika) z wektorami.

    zrodlo = "<nazwa dokumentu>#<numer fragmentu od 0>", wektor = embedding_haszujacy(tekst).
    """
    # Podpowiedź: dwie pętle: dokumenty, potem enumerate(fragmenty)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def wyszukaj(indeks: list[Fragment], pytanie: str, k: int = 3, prog: float = DOMYSLNY_PROG) -> list[tuple[Fragment, float]]:
    """Najwyżej k fragmentów o podobieństwie >= prog, od najbardziej podobnego.

    Przy remisie zachowaj kolejność z indeksu. k < 1 → ValueError.
    """
    # Podpowiedź: sorted(...) jest stabilne — remisy zachowują kolejność
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def zbuduj_prompt(pytanie: str, trafienia: list[tuple[Fragment, float]]) -> str:
    """Prompt w dokładnie takim układzie (linie łączone "\\n"):

        <INSTRUKCJA>
        (pusta linia)
        Źródła:
        [1] (<zrodlo>) <tekst>
        [2] (<zrodlo>) <tekst>
        (pusta linia)
        Pytanie: <pytanie>
    """
    # Podpowiedź: lista linii + "\n".join
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def sprawdz_cytowania(odpowiedz: str, liczba_zrodel: int) -> tuple[list[int], list[int]]:
    """Znajduje cytowania [n] w odpowiedzi. Zwraca (poprawne, niepoprawne):
    posortowane listy bez powtórzeń; poprawne to 1..liczba_zrodel."""
    # Podpowiedź: re.findall(r"\[(\d+)\]", ...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def recall_at_k(wyniki: list[list[str]], oczekiwane: list[str], k: int) -> float:
    """Odsetek pytań, dla których oczekiwany dokument jest wśród k pierwszych wyników.

    wyniki[i] — nazwy dokumentów znalezionych dla pytania i (od najlepszego),
    oczekiwane[i] — nazwa dokumentu, który powinien się znaleźć.
    Puste albo różnej długości listy → ValueError.
    """
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 7
def odpowiedz_rag(
    pytanie: str, indeks: list[Fragment], model: Callable[[str], str], k: int = 3, prog: float = DOMYSLNY_PROG
) -> str:
    """Cały potok: wyszukaj → (brak trafień: BRAK_ODPOWIEDZI, model NIE jest wołany)
    → zbuduj_prompt → model(prompt) → jeśli są niepoprawne cytowania, dopisz na końcu
    "\\n\\nUwaga: odpowiedź cytuje nieistniejące źródła: [7], [9]"."""
    raise NotImplementedError("Do zrobienia")
