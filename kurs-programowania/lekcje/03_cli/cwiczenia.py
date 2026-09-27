# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 03   (albo: python kurs.py obserwuj 03)
"""Lekcja 03 — narzędzie `licznik` (jak wc) i praca z terminalem.

Uruchom z katalogu lekcji:
    python cwiczenia.py README.md -l
    Get-Content README.md | python cwiczenia.py -w     (PowerShell)
    cat README.md | python cwiczenia.py -w             (bash)
"""

import argparse
import subprocess
import sys
from pathlib import Path
from typing import TextIO


# Ćwiczenie 1
def policz(tekst: str) -> dict[str, int]:
    """Zwraca {"linie": ..., "slowa": ..., "znaki": ...}.

    >>> policz("ala ma\\nkota\\n")
    {'linie': 2, 'slowa': 3, 'znaki': 12}
    """
    # Podpowiedź: splitlines(), split(), len()
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def zbuduj_parser() -> argparse.ArgumentParser:
    """Parser narzędzia "licznik":

    - pliki: zero lub więcej nazw plików (brak → czytamy stdin),
    - -l/--linie, -w/--slowa, -c/--znaki: flagi (store_true).
    """
    # Podpowiedź: argparse.ArgumentParser(prog="licznik", ...), add_argument(...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def main(argumenty: list[str], wejscie: TextIO, wyjscie: TextIO, bledy: TextIO) -> int:
    """Uruchamia licznik i zwraca kod wyjścia.

    - Dla każdego pliku wypisz na `wyjscie` wybrane liczby w kolejności
      linie, słowa, znaki, a na końcu nazwę pliku, rozdzielone spacją: "2 3 12 a.txt".
    - Bez flag wypisz wszystkie trzy liczby.
    - Bez plików: policz tekst z `wejscie` i wypisz same liczby: "2 3 12".
    - Nieistniejący plik: na `bledy` wypisz "licznik: brak pliku <nazwa>",
      policz pozostałe i zwróć 1. Wszystko w porządku → 0.
    """
    # Podpowiedź: parse_args, pętla po plikach, try/except FileNotFoundError
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def parsuj_env(tekst: str) -> dict[str, str]:
    """Czyta plik .env: linie KLUCZ=wartość.

    - puste linie i komentarze (# na początku) pomijamy,
    - opcjonalny prefiks "export " ignorujemy,
    - spacje wokół klucza i wartości obcinamy,
    - wartość w cudzysłowach "..." lub '...' tracimy cudzysłowy,
    - linia bez "=" to błąd: ValueError z numerem linii.
    """
    # Podpowiedź: linia.partition("="), removeprefix("export ")
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def uruchom(komenda: list[str]) -> tuple[int, str]:
    """Uruchamia program (lista argumentów, bez powłoki) i zwraca (kod_wyjścia, stdout)."""
    # Podpowiedź: subprocess.run(..., capture_output=True, text=True)
    raise NotImplementedError("Do zrobienia")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], sys.stdin, sys.stdout, sys.stderr))
