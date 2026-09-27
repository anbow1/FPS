# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: po jednym assercie na każde zdanie umowy + przypadki brzegowe
    assert cena_z_rabatem(1000, 10) == 900
    assert cena_z_rabatem(999, 15) == 849  # 849.15 → w dół
    assert cena_z_rabatem(500, 0) == 500
    assert cena_z_rabatem(500, 100) == 0
    assert cena_z_rabatem(0, 50) == 0
    oczekuj_bledu(ValueError, cena_z_rabatem, 100, 101)
    oczekuj_bledu(ValueError, cena_z_rabatem, 100, -1)
    oczekuj_bledu(ValueError, cena_z_rabatem, -1, 10)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def parsuj_ruff(tekst: str) -> list[dict[str, Any]]:
    """Wynik `ruff check --output-format concise` → lista słowników:

        {"plik": "src/a.py", "linia": 3, "kolumna": 8, "kod": "F401",
         "naprawialny": True, "opis": "`os` imported but unused"}

    "naprawialny" = w linii jest "[*]" (ruff --fix umie to poprawić).
    Linie niepasujące (np. "Found 3 errors.") pomijamy. Ścieżki z Windows
    (C:\\projekt\\a.py) muszą działać.
    """
    # ROZWIĄZANIE-START: re.match z leniwym (.+?) dla ścieżki
    wzor = re.compile(r"^(.+?):(\d+):(\d+): ([A-Z]+[0-9]+) (\[\*\] )?(.*)$")
    uwagi = []
    for linia in tekst.splitlines():
        dopasowanie = wzor.match(linia.strip())
        if dopasowanie is None:
            continue
        plik, numer_linii, kolumna, kod, naprawialny, opis = dopasowanie.groups()
        uwagi.append({
            "plik": plik, "linia": int(numer_linii), "kolumna": int(kolumna),
            "kod": kod, "naprawialny": naprawialny is not None, "opis": opis,
        })
    return uwagi
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def podsumuj(uwagi: list[dict[str, Any]]) -> list[tuple[str, int]]:
    """[(kod, liczba_wystąpień), ...] od najczęstszego; przy remisie alfabetycznie po kodzie."""
    # ROZWIĄZANIE-START: Counter + sorted
    liczniki = Counter(uwaga["kod"] for uwaga in uwagi)
    return sorted(liczniki.items(), key=lambda para: (-para[1], para[0]))
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def parsuj_pytest(linia: str) -> dict[str, float]:
    """Linia podsumowania pytest → liczby.

    "=== 2 failed, 10 passed, 1 skipped, 1 error, 3 warnings in 0.52s ==="
    → {"passed": 10, "failed": 2, "skipped": 1, "errors": 1, "warnings": 3, "czas_s": 0.52}

    Zawsze wszystkie klucze (brak = 0). "error"/"errors" → "errors",
    "warning"/"warnings" → "warnings". Brak czasu → czas_s = 0.0.
    """
    # ROZWIĄZANIE-START: re.findall na parach "liczba słowo", re.search na czasie
    wynik: dict[str, float] = {"passed": 0, "failed": 0, "skipped": 0, "errors": 0, "warnings": 0, "czas_s": 0.0}
    for liczba, slowo in re.findall(r"(\d+) (passed|failed|skipped|errors?|warnings?)\b", linia):
        klucz = {"error": "errors", "warning": "warnings"}.get(slowo, slowo)
        wynik[klucz] = int(liczba)
    czas = re.search(r"in ([\d.]+)s", linia)
    if czas:
        wynik["czas_s"] = float(czas.group(1))
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def zakresy(linie: list[int]) -> str:
    """Numery linii jako zwarte zakresy, jak kolumna "Missing" w raporcie pokrycia.

    >>> zakresy([9, 3, 4, 5, 11, 12, 4])
    '3-5, 9, 11-12'
    Pusta lista → "".
    """
    # ROZWIĄZANIE-START: sorted(set(...)), zamykaj zakres, gdy następna liczba nie jest o 1 większa
    liczby = sorted(set(linie))
    if not liczby:
        return ""
    czesci = []
    poczatek = poprzednia = liczby[0]
    for liczba in liczby[1:]:
        if liczba == poprzednia + 1:
            poprzednia = liczba
            continue
        czesci.append(_zakres(poczatek, poprzednia))
        poczatek = poprzednia = liczba
    czesci.append(_zakres(poczatek, poprzednia))
    return ", ".join(czesci)


def _zakres(poczatek: int, koniec: int) -> str:
    return str(poczatek) if poczatek == koniec else f"{poczatek}-{koniec}"
    # ROZWIĄZANIE-KONIEC


def procent_pokrycia(wykonane: int, wszystkie: int) -> float:
    """Procent wykonanych instrukcji, zaokrąglony do 1 miejsca. 0 instrukcji → 100.0.
    wykonane < 0, wszystkie < 0 albo wykonane > wszystkie → ValueError."""
    # ROZWIĄZANIE-START
    if wykonane < 0 or wszystkie < 0 or wykonane > wszystkie:
        raise ValueError(f"niemożliwe liczby: wykonane={wykonane}, wszystkie={wszystkie}")
    if wszystkie == 0:
        return 100.0
    return round(100 * wykonane / wszystkie, 1)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def zmierz(funkcja: Callable[[], Any], powtorzenia: int = 5, zegar: Callable[[], float] = time.perf_counter) -> float:
    """Mediana czasu (w sekundach) z `powtorzenia` wywołań funkcja().

    Każdy pomiar: zegar() przed i po wywołaniu. powtorzenia < 1 → ValueError.
    """
    # ROZWIĄZANIE-START: lista czasów, statistics.median
    if powtorzenia < 1:
        raise ValueError(f"potrzeba co najmniej 1 powtórzenia, dostałem {powtorzenia}")
    czasy = []
    for _ in range(powtorzenia):
        start = zegar()
        funkcja()
        czasy.append(zegar() - start)
    return statistics.median(czasy)
    # ROZWIĄZANIE-KONIEC
