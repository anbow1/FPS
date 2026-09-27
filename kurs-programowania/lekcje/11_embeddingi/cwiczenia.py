# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 11   (albo: python kurs.py obserwuj 11)
"""Lekcja 11 — Embeddingi na czystym Pythonie."""

import math
import re
import zlib

Wektor = list[float]


# Ćwiczenie 1
def tokenizuj(tekst: str) -> list[str]:
    """Słowa (ciągi liter/cyfr) małymi literami.

    >>> tokenizuj("Jak zresetować HASŁO? Krok 2.")
    ['jak', 'zresetować', 'hasło', 'krok', '2']
    """
    # Podpowiedź: re.findall(r"\w+", ...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def wektor_bow(tokeny: list[str], slownik: list[str]) -> Wektor:
    """Worek słów: na pozycji i — ile razy slownik[i] występuje w tokenach (float).

    >>> wektor_bow(["kot", "ma", "kot"], ["kot", "pies", "ma"])
    [2.0, 0.0, 1.0]
    """
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def podobienstwo_cosinusowe(a: Wektor, b: Wektor) -> float:
    """cos(a, b) = a·b / (|a|·|b|).

    Różne długości wektorów → ValueError. Któryś wektor zerowy → 0.0.
    """
    # Podpowiedź: iloczyn skalarny i dwie normy
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def normalizuj(wektor: Wektor) -> Wektor:
    """Wektor o tym samym kierunku i długości 1. Wektor zerowy → ValueError."""
    # Podpowiedź: podziel każdą współrzędną przez normę
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def embedding_haszujacy(tekst: str, wymiar: int = 64) -> Wektor:
    """Hashing trick: każdy token dodaje 1.0 na pozycji crc32(token) % wymiar.

    Wynik znormalizowany do długości 1; tekst bez tokenów → same zera.
    wymiar < 1 → ValueError.
    """
    # Podpowiedź: zlib.crc32(token.encode("utf-8")) % wymiar
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def wagi_idf(dokumenty: list[list[str]]) -> dict[str, float]:
    """IDF dla każdego słowa z dokumentów (listy tokenów):

        idf = ln((1 + N) / (1 + df)) + 1
    N — liczba dokumentów, df — w ilu dokumentach słowo występuje (co najmniej raz).
    """
    # Podpowiedź: policz df po set(tokeny) każdego dokumentu
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 7
def najblizsze(zapytanie: Wektor, wektory: dict[str, Wektor], k: int = 3) -> list[tuple[str, float]]:
    """k najbardziej podobnych (cosinus) wektorów: [(id, podobieństwo), ...].

    Sortuj malejąco po podobieństwie, przy remisie rosnąco po id. k < 1 → ValueError.
    """
    # Podpowiedź: sorted(..., key=lambda para: (-para[1], para[0]))[:k]
    raise NotImplementedError("Do zrobienia")
