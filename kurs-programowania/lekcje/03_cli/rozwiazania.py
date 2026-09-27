# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: splitlines(), split(), len()
    return {"linie": len(tekst.splitlines()), "slowa": len(tekst.split()), "znaki": len(tekst)}
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def zbuduj_parser() -> argparse.ArgumentParser:
    """Parser narzędzia "licznik":

    - pliki: zero lub więcej nazw plików (brak → czytamy stdin),
    - -l/--linie, -w/--slowa, -c/--znaki: flagi (store_true).
    """
    # ROZWIĄZANIE-START: argparse.ArgumentParser(prog="licznik", ...), add_argument(...)
    parser = argparse.ArgumentParser(prog="licznik", description="Liczy linie, słowa i znaki.")
    parser.add_argument("pliki", nargs="*", help="pliki do policzenia (brak = stdin)")
    parser.add_argument("-l", "--linie", action="store_true", help="tylko linie")
    parser.add_argument("-w", "--slowa", action="store_true", help="tylko słowa")
    parser.add_argument("-c", "--znaki", action="store_true", help="tylko znaki")
    return parser
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: parse_args, pętla po plikach, try/except FileNotFoundError
    opcje = zbuduj_parser().parse_args(argumenty)
    wybrane = [nazwa for nazwa in ("linie", "slowa", "znaki") if getattr(opcje, nazwa)]
    if not wybrane:
        wybrane = ["linie", "slowa", "znaki"]

    if not opcje.pliki:
        liczby = policz(wejscie.read())
        print(" ".join(str(liczby[nazwa]) for nazwa in wybrane), file=wyjscie)
        return 0

    kod_wyjscia = 0
    for nazwa_pliku in opcje.pliki:
        try:
            tekst = Path(nazwa_pliku).read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"licznik: brak pliku {nazwa_pliku}", file=bledy)
            kod_wyjscia = 1
            continue
        liczby = policz(tekst)
        print(" ".join(str(liczby[nazwa]) for nazwa in wybrane), nazwa_pliku, file=wyjscie)
    return kod_wyjscia
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def parsuj_env(tekst: str) -> dict[str, str]:
    """Czyta plik .env: linie KLUCZ=wartość.

    - puste linie i komentarze (# na początku) pomijamy,
    - opcjonalny prefiks "export " ignorujemy,
    - spacje wokół klucza i wartości obcinamy,
    - wartość w cudzysłowach "..." lub '...' tracimy cudzysłowy,
    - linia bez "=" to błąd: ValueError z numerem linii.
    """
    # ROZWIĄZANIE-START: linia.partition("="), removeprefix("export ")
    wynik = {}
    for numer, surowa_linia in enumerate(tekst.splitlines(), start=1):
        linia = surowa_linia.strip()
        if not linia or linia.startswith("#"):
            continue
        klucz, znak_rownosci, wartosc = linia.removeprefix("export ").partition("=")
        if not znak_rownosci:
            raise ValueError(f"linia {numer} pliku .env nie ma '=': '{surowa_linia}'")
        wartosc = wartosc.strip()
        if len(wartosc) >= 2 and wartosc[0] == wartosc[-1] and wartosc[0] in "\"'":
            wartosc = wartosc[1:-1]
        wynik[klucz.strip()] = wartosc
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def uruchom(komenda: list[str]) -> tuple[int, str]:
    """Uruchamia program (lista argumentów, bez powłoki) i zwraca (kod_wyjścia, stdout)."""
    # ROZWIĄZANIE-START: subprocess.run(..., capture_output=True, text=True)
    wynik = subprocess.run(komenda, capture_output=True, text=True, check=False)
    return wynik.returncode, wynik.stdout
    # ROZWIĄZANIE-KONIEC


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], sys.stdin, sys.stdout, sys.stderr))
