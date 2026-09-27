# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 15   (albo: python kurs.py obserwuj 15)
"""Lekcja 15 — narzędzia jakości: testy, które łapią błędy, i wyniki narzędzi jako dane."""

import re
import statistics
import time
from collections import Counter
from collections.abc import Callable
from typing import Any


def oczekuj_bledu(typ: type[BaseException], funkcja: Callable[..., Any], *argumenty: Any) -> None:
    """Gotowy pomocnik: rzuca AssertionError, jeśli funkcja(*argumenty) NIE zgłosi błędu `typ`."""
    try:
        funkcja(*argumenty)
    except typ:
        return
    raise AssertionError(f"oczekiwano {typ.__name__} dla argumentów {argumenty}")


# Ćwiczenie 1
def sprawdz_cene_z_rabatem(cena_z_rabatem: Callable[[int, int], int]) -> None:
    """Napisz testy (instrukcje assert) funkcji o takiej umowie:

        cena_z_rabatem(cena_gr, rabat_procent) -> int
        - cena po rabacie w groszach, zaokrąglona W DÓŁ do pełnego grosza,
        - rabat_procent od 0 do 100 włącznie; spoza zakresu → ValueError,
        - cena_gr < 0 → ValueError.

    Poprawna funkcja ma przejść Twoje testy bez błędu. Test lekcji podsunie też
    6 zepsutych wersji (mutantów) — każdą Twoje testy muszą odrzucić.
    """
    # Podpowiedź: po jednym assercie na każde zdanie umowy + przypadki brzegowe
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def parsuj_ruff(tekst: str) -> list[dict[str, Any]]:
    """Wynik `ruff check --output-format concise` → lista słowników:

        {"plik": "src/a.py", "linia": 3, "kolumna": 8, "kod": "F401",
         "naprawialny": True, "opis": "`os` imported but unused"}

    "naprawialny" = w linii jest "[*]" (ruff --fix umie to poprawić).
    Linie niepasujące (np. "Found 3 errors.") pomijamy. Ścieżki z Windows
    (C:\\projekt\\a.py) muszą działać.
    """
    # Podpowiedź: re.match z leniwym (.+?) dla ścieżki
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def podsumuj(uwagi: list[dict[str, Any]]) -> list[tuple[str, int]]:
    """[(kod, liczba_wystąpień), ...] od najczęstszego; przy remisie alfabetycznie po kodzie."""
    # Podpowiedź: Counter + sorted
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def parsuj_pytest(linia: str) -> dict[str, float]:
    """Linia podsumowania pytest → liczby.

    "=== 2 failed, 10 passed, 1 skipped, 1 error, 3 warnings in 0.52s ==="
    → {"passed": 10, "failed": 2, "skipped": 1, "errors": 1, "warnings": 3, "czas_s": 0.52}

    Zawsze wszystkie klucze (brak = 0). "error"/"errors" → "errors",
    "warning"/"warnings" → "warnings". Brak czasu → czas_s = 0.0.
    """
    # Podpowiedź: re.findall na parach "liczba słowo", re.search na czasie
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def zakresy(linie: list[int]) -> str:
    """Numery linii jako zwarte zakresy, jak kolumna "Missing" w raporcie pokrycia.

    >>> zakresy([9, 3, 4, 5, 11, 12, 4])
    '3-5, 9, 11-12'
    Pusta lista → "".
    """
    # Podpowiedź: sorted(set(...)), zamykaj zakres, gdy następna liczba nie jest o 1 większa
    raise NotImplementedError("Do zrobienia")


def procent_pokrycia(wykonane: int, wszystkie: int) -> float:
    """Procent wykonanych instrukcji, zaokrąglony do 1 miejsca. 0 instrukcji → 100.0.
    wykonane < 0, wszystkie < 0 albo wykonane > wszystkie → ValueError."""
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def zmierz(funkcja: Callable[[], Any], powtorzenia: int = 5, zegar: Callable[[], float] = time.perf_counter) -> float:
    """Mediana czasu (w sekundach) z `powtorzenia` wywołań funkcja().

    Każdy pomiar: zegar() przed i po wywołaniu. powtorzenia < 1 → ValueError.
    """
    # Podpowiedź: lista czasów, statistics.median
    raise NotImplementedError("Do zrobienia")
