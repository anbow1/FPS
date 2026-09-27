"""Quiz z pliku quiz.json: pytania jednokrotnego wyboru z wyjaśnieniem."""

import json
import random
from collections.abc import Callable
from pathlib import Path
from typing import Any

LITERY = "abcdefgh"


def wczytaj_pytania(plik: Path) -> list[dict[str, Any]]:
    pytania = json.loads(plik.read_text(encoding="utf-8"))
    for numer, pytanie in enumerate(pytania, start=1):
        brakujace = {"pytanie", "odpowiedzi", "poprawna", "wyjasnienie"} - pytanie.keys()
        if brakujace:
            raise ValueError(f"{plik.name}: pytanie {numer} nie ma pól {sorted(brakujace)}")
        if not 0 <= pytanie["poprawna"] < len(pytanie["odpowiedzi"]):
            raise ValueError(
                f"{plik.name}: pytanie {numer} ma poprawna={pytanie['poprawna']}, "
                f"a odpowiedzi jest {len(pytanie['odpowiedzi'])}"
            )
    return pytania


def przeprowadz(
    pytania: list[dict[str, Any]],
    zapytaj: Callable[[str], str] = input,
    pokaz: Callable[[str], None] = print,
    tasuj: Callable[[list[int]], None] = random.shuffle,
) -> int:
    """Zadaje pytania i zwraca liczbę dobrych odpowiedzi.

    Kolejność odpowiedzi jest tasowana, żeby nie dało się zapamiętać "zawsze b".
    """
    dobre = 0
    for numer, pytanie in enumerate(pytania, start=1):
        pokaz(f"\n{numer}/{len(pytania)}. {pytanie['pytanie']}")
        kolejnosc = list(range(len(pytanie["odpowiedzi"])))
        tasuj(kolejnosc)
        litery = LITERY[: len(kolejnosc)]
        for litera, indeks in zip(litery, kolejnosc):
            pokaz(f"   {litera}) {pytanie['odpowiedzi'][indeks]}")
        wybor = zapytaj(f"Twoja odpowiedź [{'/'.join(litery)}]: ").strip().lower()
        while len(wybor) != 1 or wybor not in litery:
            wybor = zapytaj(f"Wpisz jedną literę: {', '.join(litery)}: ").strip().lower()
        poprawna_litera = litery[kolejnosc.index(pytanie["poprawna"])]
        if wybor == poprawna_litera:
            dobre += 1
            pokaz("   ✔ Dobrze!")
        else:
            pokaz(f"   ✘ Nie tym razem — poprawna: {poprawna_litera})")
        pokaz(f"   ℹ {pytanie['wyjasnienie']}")
    return dobre
