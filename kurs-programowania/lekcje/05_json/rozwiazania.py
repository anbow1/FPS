# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: try/except json.JSONDecodeError, raise ValueError(...) from blad
    try:
        return json.loads(tekst)
    except json.JSONDecodeError as blad:
        raise ValueError(f"niepoprawny JSON: linia {blad.lineno}, kolumna {blad.colno}: {blad.msg}") from blad
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def do_json(obiekt: Any) -> str:
    """Ładny JSON: wcięcie 2, posortowane klucze, polskie znaki wprost.

    Daty (date i datetime) → napis ISO, zbiory → posortowane listy.
    Inny nieznany typ → TypeError.
    """
    # ROZWIĄZANIE-START: json.dumps(..., default=funkcja_pomocnicza)
    def na_json(wartosc: Any) -> Any:
        if isinstance(wartosc, date):  # datetime jest podklasą date
            return wartosc.isoformat()
        if isinstance(wartosc, (set, frozenset)):
            return sorted(wartosc)
        raise TypeError(f"typu {type(wartosc).__name__} nie da się zapisać w JSON")

    return json.dumps(obiekt, indent=2, ensure_ascii=False, sort_keys=True, default=na_json)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def pobierz(dane: Any, sciezka: str, domyslna: Any = None) -> Any:
    """Idzie po ścieżce kluczy rozdzielonych kropką; liczby indeksują listy.

    >>> pobierz({"u": [{"imie": "Ala"}]}, "u.0.imie")
    'Ala'
    Brak czegokolwiek po drodze → `domyslna`.
    """
    # ROZWIĄZANIE-START: pętla po sciezka.split("."), łap KeyError/IndexError/TypeError/ValueError
    biezace = dane
    for klucz in sciezka.split("."):
        try:
            if isinstance(biezace, list):
                biezace = biezace[int(klucz)]
            else:
                biezace = biezace[klucz]
        except (KeyError, IndexError, TypeError, ValueError):
            return domyslna
    return biezace
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: dla bool sprawdź osobno — isinstance(True, int) jest True
    if not isinstance(obiekt, dict):
        return [f"oczekiwano obiektu JSON (dict), jest {type(obiekt).__name__}"]
    bledy = []
    for pole, typ in schemat.items():
        if pole not in obiekt:
            bledy.append(f"brak pola '{pole}'")
            continue
        wartosc = obiekt[pole]
        zly_bool = isinstance(wartosc, bool) and typ is not bool
        if zly_bool or not isinstance(wartosc, typ):
            bledy.append(f"pole '{pole}' ma typ {type(wartosc).__name__}, oczekiwano {typ.__name__}")
    return bledy
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def zapisz_jsonl(sciezka: Path, rekordy: list[dict[str, Any]]) -> None:
    """Zapisuje rekordy w formacie JSON Lines (UTF-8, polskie znaki wprost)."""
    # ROZWIĄZANIE-START: jedna linia json.dumps na rekord, write_text(..., encoding="utf-8")
    linie = [json.dumps(rekord, ensure_ascii=False) + "\n" for rekord in rekordy]
    sciezka.write_text("".join(linie), encoding="utf-8")
    # ROZWIĄZANIE-KONIEC


def wczytaj_jsonl(sciezka: Path) -> list[dict[str, Any]]:
    """Czyta plik JSON Lines; puste linie pomija."""
    # ROZWIĄZANIE-START
    rekordy = []
    for linia in sciezka.read_text(encoding="utf-8").splitlines():
        if linia.strip():
            rekordy.append(json.loads(linia))
    return rekordy
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def splaszcz(dane: Any, prefiks: str = "") -> dict[str, Any]:
    """Spłaszcza zagnieżdżone słowniki i listy do kluczy z kropkami.

    >>> splaszcz({"a": {"b": 1, "c": [10, 20]}, "d": None})
    {'a.b': 1, 'a.c.0': 10, 'a.c.1': 20, 'd': None}
    Pusty słownik/lista w środku znika (nie ma liści).
    """
    # ROZWIĄZANIE-START: rekurencja; dla listy użyj enumerate
    wynik: dict[str, Any] = {}
    if isinstance(dane, dict):
        pary = dane.items()
    elif isinstance(dane, list):
        pary = enumerate(dane)
    else:
        return {prefiks.rstrip("."): dane}
    for klucz, wartosc in pary:
        wynik.update(splaszcz(wartosc, f"{prefiks}{klucz}."))
    return wynik
    # ROZWIĄZANIE-KONIEC
