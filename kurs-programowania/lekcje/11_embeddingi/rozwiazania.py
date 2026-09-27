# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: re.findall(r"\w+", ...)
    return re.findall(r"\w+", tekst.lower())
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def wektor_bow(tokeny: list[str], slownik: list[str]) -> Wektor:
    """Worek słów: na pozycji i — ile razy slownik[i] występuje w tokenach (float).

    >>> wektor_bow(["kot", "ma", "kot"], ["kot", "pies", "ma"])
    [2.0, 0.0, 1.0]
    """
    # ROZWIĄZANIE-START
    return [float(tokeny.count(slowo)) for slowo in slownik]
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def podobienstwo_cosinusowe(a: Wektor, b: Wektor) -> float:
    """cos(a, b) = a·b / (|a|·|b|).

    Różne długości wektorów → ValueError. Któryś wektor zerowy → 0.0.
    """
    # ROZWIĄZANIE-START: iloczyn skalarny i dwie normy
    if len(a) != len(b):
        raise ValueError(f"wektory mają różne wymiary: {len(a)} i {len(b)}")
    iloczyn = sum(x * y for x, y in zip(a, b))
    norma_a = math.sqrt(sum(x * x for x in a))
    norma_b = math.sqrt(sum(y * y for y in b))
    if norma_a == 0 or norma_b == 0:
        return 0.0
    return iloczyn / (norma_a * norma_b)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def normalizuj(wektor: Wektor) -> Wektor:
    """Wektor o tym samym kierunku i długości 1. Wektor zerowy → ValueError."""
    # ROZWIĄZANIE-START: podziel każdą współrzędną przez normę
    norma = math.sqrt(sum(x * x for x in wektor))
    if norma == 0:
        raise ValueError("nie da się znormalizować wektora zerowego")
    return [x / norma for x in wektor]
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def embedding_haszujacy(tekst: str, wymiar: int = 64) -> Wektor:
    """Hashing trick: każdy token dodaje 1.0 na pozycji crc32(token) % wymiar.

    Wynik znormalizowany do długości 1; tekst bez tokenów → same zera.
    wymiar < 1 → ValueError.
    """
    # ROZWIĄZANIE-START: zlib.crc32(token.encode("utf-8")) % wymiar
    if wymiar < 1:
        raise ValueError(f"wymiar musi być >= 1, dostałem {wymiar}")
    wektor = [0.0] * wymiar
    for token in tokenizuj(tekst):
        wektor[zlib.crc32(token.encode("utf-8")) % wymiar] += 1.0
    if not any(wektor):
        return wektor
    return normalizuj(wektor)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def wagi_idf(dokumenty: list[list[str]]) -> dict[str, float]:
    """IDF dla każdego słowa z dokumentów (listy tokenów):

        idf = ln((1 + N) / (1 + df)) + 1
    N — liczba dokumentów, df — w ilu dokumentach słowo występuje (co najmniej raz).
    """
    # ROZWIĄZANIE-START: policz df po set(tokeny) każdego dokumentu
    liczba_dokumentow = len(dokumenty)
    df: dict[str, int] = {}
    for tokeny in dokumenty:
        for slowo in set(tokeny):
            df[slowo] = df.get(slowo, 0) + 1
    return {slowo: math.log((1 + liczba_dokumentow) / (1 + ile)) + 1 for slowo, ile in df.items()}
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 7
def najblizsze(zapytanie: Wektor, wektory: dict[str, Wektor], k: int = 3) -> list[tuple[str, float]]:
    """k najbardziej podobnych (cosinus) wektorów: [(id, podobieństwo), ...].

    Sortuj malejąco po podobieństwie, przy remisie rosnąco po id. k < 1 → ValueError.
    """
    # ROZWIĄZANIE-START: sorted(..., key=lambda para: (-para[1], para[0]))[:k]
    if k < 1:
        raise ValueError(f"k musi być >= 1, dostałem {k}")
    wyniki = [(identyfikator, podobienstwo_cosinusowe(zapytanie, wektor)) for identyfikator, wektor in wektory.items()]
    return sorted(wyniki, key=lambda para: (-para[1], para[0]))[:k]
    # ROZWIĄZANIE-KONIEC
