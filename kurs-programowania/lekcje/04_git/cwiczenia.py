# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 04   (albo: python kurs.py obserwuj 04)
"""Lekcja 04 — Git."""

import re
import subprocess
from pathlib import Path

TYPY_COMMITOW = ("feat", "fix", "docs", "style", "refactor", "test", "chore", "build", "ci", "perf")
# Popularna granica: tyle mieści się w widoku historii GitHuba bez obcinania.
MAKS_DLUGOSC_TYTULU = 72


# Ćwiczenie 1
def parsuj_status(porcelain: str) -> dict[str, list[str]]:
    """Zamienia wynik `git status --porcelain` na słownik list ścieżek:

    - "w_poczekalni": X nie jest spacją (zmiany dodane przez git add),
    - "zmienione":    Y nie jest spacją (zmiany jeszcze niedodane),
    - "nowe":         pliki nieśledzone ("??").
    Plik może być na obu pierwszych listach naraz ("MM"). Przy zmianie nazwy
    ("R  a.py -> b.py") bierzemy nową nazwę. Kolejność jak w wejściu.
    """
    # Podpowiedź: X = linia[0], Y = linia[1], ścieżka = linia[3:]
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def czy_poprawny_commit(wiadomosc: str) -> bool:
    """Czy wiadomość spełnia Conventional Commits (wersja kursowa)?

    - pierwsza linia: typ(zakres opcjonalny)!opcjonalny: opis
      typ z TYPY_COMMITOW, zakres z [a-z0-9-], po dwukropku spacja i niepusty opis,
    - pierwsza linia najwyżej MAKS_DLUGOSC_TYTULU znaków,
    - jeśli jest treść, druga linia musi być pusta.
    """
    # Podpowiedź: re.fullmatch na pierwszej linii, potem długość i druga linia
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def parsuj_log(tekst: str) -> list[tuple[str, str]]:
    """`git log --oneline` → [(hash, opis), ...]. Puste linie pomijamy.

    >>> parsuj_log("3f2a9c1 feat: start\\n")
    [('3f2a9c1', 'feat: start')]
    """
    # Podpowiedź: linia.split(" ", 1)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def nazwa_galezi(opis: str, typ: str = "feature") -> str:
    """Nazwa gałęzi z opisu zadania: typ/male-litery-bez-polskich-znakow.

    >>> nazwa_galezi("Dodaj logowanie przez Google!")
    'feature/dodaj-logowanie-przez-google'
    Opis bez liter i cyfr → ValueError.
    """
    # Podpowiedź: lower(), translate() polskich znaków, re.sub, strip("-")
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def rozwiaz_konflikt(tekst: str, strona: str) -> str:
    """Usuwa znaczniki konfliktu, zostawiając wybraną wersję.

    strona: "nasza" (część nad =======), "ich" (pod =======) albo "obie"
    (nasza, potem ich). Linie poza konfliktami zostają bez zmian.
    Inna strona → ValueError.
    """
    # Podpowiedź: stan = "poza" / "nasza" / "ich", przełączany przez znaczniki
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def utworz_repo(katalog: Path) -> str:
    """W pustym katalogu: git init, plik README.md z tekstem "# Projekt\\n",
    git add, commit "feat: pierwszy commit". Zwraca pełny hash commita.

    Błąd komendy gita → subprocess.CalledProcessError (check=True).
    """
    # Podpowiedź: subprocess.run([...], cwd=katalog, check=True, capture_output=True, text=True)
    raise NotImplementedError("Do zrobienia")
