# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 05   (albo: python kurs.py obserwuj 05)
"""Lekcja 05 — JSON."""

import json
from datetime import date
from pathlib import Path
from typing import Any


# Ćwiczenie 1
def wczytaj_json(tekst: str) -> Any:
    """json.loads z czytelnym błędem.

    Niepoprawny JSON → ValueError z komunikatem zawierającym
    "linia <nr>, kolumna <nr>".
    """
    # Podpowiedź: try/except json.JSONDecodeError, raise ValueError(...) from blad
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def do_json(obiekt: Any) -> str:
    """Ładny JSON: wcięcie 2, posortowane klucze, polskie znaki wprost.

    Daty (date i datetime) → napis ISO, zbiory → posortowane listy.
    Inny nieznany typ → TypeError.
    """
    # Podpowiedź: json.dumps(..., default=funkcja_pomocnicza)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def pobierz(dane: Any, sciezka: str, domyslna: Any = None) -> Any:
    """Idzie po ścieżce kluczy rozdzielonych kropką; liczby indeksują listy.

    >>> pobierz({"u": [{"imie": "Ala"}]}, "u.0.imie")
    'Ala'
    Brak czegokolwiek po drodze → `domyslna`.
    """
    # Podpowiedź: pętla po sciezka.split("."), łap KeyError/IndexError/TypeError/ValueError
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def waliduj(obiekt: Any, schemat: dict[str, type]) -> list[str]:
    """Sprawdza, czy obiekt to słownik z wymaganymi polami właściwych typów.

    schemat: {"nazwa_pola": typ}, np. {"imie": str, "wiek": int}.
    Zwraca listę komunikatów (pusta = poprawny), w kolejności pól w schemacie:
      "brak pola 'wiek'"
      "pole 'wiek' ma typ str, oczekiwano int"
    Uwaga: True/False NIE jest poprawnym int ani float.
    Obiekt, który nie jest słownikiem → ["oczekiwano obiektu JSON (dict), jest <typ>"].
    """
    # Podpowiedź: dla bool sprawdź osobno — isinstance(True, int) jest True
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def zapisz_jsonl(sciezka: Path, rekordy: list[dict[str, Any]]) -> None:
    """Zapisuje rekordy w formacie JSON Lines (UTF-8, polskie znaki wprost)."""
    # Podpowiedź: jedna linia json.dumps na rekord, write_text(..., encoding="utf-8")
    raise NotImplementedError("Do zrobienia")


def wczytaj_jsonl(sciezka: Path) -> list[dict[str, Any]]:
    """Czyta plik JSON Lines; puste linie pomija."""
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def splaszcz(dane: Any, prefiks: str = "") -> dict[str, Any]:
    """Spłaszcza zagnieżdżone słowniki i listy do kluczy z kropkami.

    >>> splaszcz({"a": {"b": 1, "c": [10, 20]}, "d": None})
    {'a.b': 1, 'a.c.0': 10, 'a.c.1': 20, 'd': None}
    Pusty słownik/lista w środku znika (nie ma liści).
    """
    # Podpowiedź: rekurencja; dla listy użyj enumerate
    raise NotImplementedError("Do zrobienia")
