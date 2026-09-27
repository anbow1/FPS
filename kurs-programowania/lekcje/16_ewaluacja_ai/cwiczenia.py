# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 16   (albo: python kurs.py obserwuj 16)
"""Lekcja 16 — ewaluacja aplikacji AI."""

import json
import math
import re
from collections.abc import Callable
from typing import Any

Przypadek = dict[str, Any]
Raport = dict[str, Any]
WYMAGANE_POLA = ("id", "wejscie", "oczekiwane")


# Ćwiczenie 1
def wczytaj_zestaw(tekst: str) -> list[Przypadek]:
    """Zestaw w formacie JSON Lines → lista przypadków.

    - puste linie pomijamy,
    - każdy przypadek musi mieć pola "id", "wejscie", "oczekiwane"; brak →
      ValueError z numerem linii (np. "linia 3: brak pola 'wejscie'"),
    - powtórzone id → ValueError,
    - brak "tagi" → [] (pozostałe pola zostają bez zmian).
    """
    # Podpowiedź: enumerate(..., start=1), json.loads, zbiór widzianych id
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def normalizuj(tekst: str) -> str:
    """Małe litery, interpunkcja zamieniona na spacje, pojedyncze spacje, bez spacji na brzegach.

    >>> normalizuj("  Nie wiem!  ")
    'nie wiem'
    """
    # Podpowiedź: lower(), re.sub(r"[^\w\s]", " ", ...), " ".join(split())
    raise NotImplementedError("Do zrobienia")


def ocena_dokladna(odpowiedz: str, oczekiwane: str) -> bool:
    """Czy odpowiedź po normalizacji jest równa oczekiwanej po normalizacji."""
    raise NotImplementedError("Do zrobienia")


def ocena_liczbowa(odpowiedz: str, oczekiwana: float, tolerancja: float = 0.01) -> bool:
    """Pierwsza liczba w odpowiedzi jest równa oczekiwanej z tolerancją.

    Rozumie zapis polski i angielski: "15 zł", "1 234,56", "1234.56", "-3".
    Brak liczby → False.
    """
    # Podpowiedź: re.search, usuń spacje (także  ), "," → "."
    raise NotImplementedError("Do zrobienia")


def ocena_zawiera(odpowiedz: str, wymagane: list[str], zakazane: list[str]) -> bool:
    """Po normalizacji: każda wymagana fraza występuje jako całe słowa, żadna zakazana nie występuje.

    "nie" pasuje do "Nie, nie wysyłamy", ale nie do "niestety".
    """
    # Podpowiedź: f" {fraza} " in f" {tekst} " daje granice słów
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def prompt_sedziego(pytanie: str, odpowiedz: str, kryteria: list[str]) -> str:
    """Prompt dla modelu-sędziego, dokładnie w tym układzie (linie łączone "\\n"):

        Oceń odpowiedź asystenta według kryteriów.
        (pusta linia)
        Pytanie: <pytanie>
        Odpowiedź: <odpowiedz>
        (pusta linia)
        Kryteria:
        - <kryterium 1>
        - <kryterium 2>
        (pusta linia)
        Zwróć wyłącznie JSON: {"ocena": <liczba 1-5>, "uzasadnienie": "<jedno zdanie>"}

    Brak kryteriów → ValueError (sędzia bez kryteriów ocenia „na oko”).
    """
    # Podpowiedź: lista linii + "\n".join
    raise NotImplementedError("Do zrobienia")


def parsuj_werdykt(tekst: str) -> dict[str, Any]:
    """Wyciąga werdykt sędziego: {"ocena": int 1-5, "uzasadnienie": str}.

    JSON może być otoczony tekstem albo blokiem ```json … ```. Brak JSON-a,
    zły JSON, brak pól, ocena spoza 1–5 albo nie-int (także bool) → ValueError.
    """
    # Podpowiedź: tekst[tekst.find("{") : tekst.rfind("}") + 1]
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def uruchom_eval(
    model: Callable[[str], str],
    przypadki: list[Przypadek],
    oceniacz: Callable[[str, Przypadek], bool],
) -> Raport:
    """Uruchamia model na każdym przypadku i ocenia odpowiedzi.

    Zwraca:
      {"wyniki": [{"id": ..., "zaliczony": bool, "odpowiedz": str}, ...],   (kolejność przypadków)
       "wynik": ułamek zaliczonych (0.0 dla pustego zestawu),
       "wg_tagow": {tag: ułamek zaliczonych wśród przypadków z tym tagiem}}
    Wyjątek modelu → przypadek niezaliczony, odpowiedz = "BŁĄD: <treść>"; eval idzie dalej.
    """
    # Podpowiedź: pętla z try/except wokół model(...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def porownaj(przed: Raport, po: Raport) -> dict[str, list[str]]:
    """{"regresje": id zaliczone przed, a niezaliczone po; "poprawy": odwrotnie} — posortowane.

    Raporty z różnymi zbiorami id → ValueError.
    """
    # Podpowiedź: słowniki id → zaliczony
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def przedzial_wilsona(sukcesy: int, proby: int, z: float = 1.96) -> tuple[float, float]:
    """95% przedział ufności Wilsona dla odsetka sukcesów: (dolny, górny).

    proby < 1 albo sukcesy spoza 0..proby → ValueError.
    """
    # Podpowiedź: wzór z README
    raise NotImplementedError("Do zrobienia")
