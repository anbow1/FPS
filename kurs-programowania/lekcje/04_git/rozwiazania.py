# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: X = linia[0], Y = linia[1], ścieżka = linia[3:]
    wynik: dict[str, list[str]] = {"w_poczekalni": [], "zmienione": [], "nowe": []}
    for linia in porcelain.splitlines():
        if not linia.strip():
            continue
        x, y, sciezka = linia[0], linia[1], linia[3:]
        if " -> " in sciezka:
            sciezka = sciezka.split(" -> ", 1)[1]
        if x == "?" and y == "?":
            wynik["nowe"].append(sciezka)
            continue
        if x != " ":
            wynik["w_poczekalni"].append(sciezka)
        if y != " ":
            wynik["zmienione"].append(sciezka)
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def czy_poprawny_commit(wiadomosc: str) -> bool:
    """Czy wiadomość spełnia Conventional Commits (wersja kursowa)?

    - pierwsza linia: typ(zakres opcjonalny)!opcjonalny: opis
      typ z TYPY_COMMITOW, zakres z [a-z0-9-], po dwukropku spacja i niepusty opis,
    - pierwsza linia najwyżej MAKS_DLUGOSC_TYTULU znaków,
    - jeśli jest treść, druga linia musi być pusta.
    """
    # ROZWIĄZANIE-START: re.fullmatch na pierwszej linii, potem długość i druga linia
    linie = wiadomosc.splitlines()
    if not linie:
        return False
    tytul = linie[0]
    wzor = rf"({'|'.join(TYPY_COMMITOW)})(\([a-z0-9-]+\))?!?: \S.*"
    if not re.fullmatch(wzor, tytul):
        return False
    if len(tytul) > MAKS_DLUGOSC_TYTULU:
        return False
    if len(linie) > 1 and linie[1].strip():
        return False
    return True
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def parsuj_log(tekst: str) -> list[tuple[str, str]]:
    """`git log --oneline` → [(hash, opis), ...]. Puste linie pomijamy.

    >>> parsuj_log("3f2a9c1 feat: start\\n")
    [('3f2a9c1', 'feat: start')]
    """
    # ROZWIĄZANIE-START: linia.split(" ", 1)
    wynik = []
    for linia in tekst.splitlines():
        if not linia.strip():
            continue
        skrot, _, opis = linia.strip().partition(" ")
        wynik.append((skrot, opis))
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def nazwa_galezi(opis: str, typ: str = "feature") -> str:
    """Nazwa gałęzi z opisu zadania: typ/male-litery-bez-polskich-znakow.

    >>> nazwa_galezi("Dodaj logowanie przez Google!")
    'feature/dodaj-logowanie-przez-google'
    Opis bez liter i cyfr → ValueError.
    """
    # ROZWIĄZANIE-START: lower(), translate() polskich znaków, re.sub, strip("-")
    bez_polskich = opis.lower().translate(str.maketrans("ąćęłńóśźż", "acelnoszz"))
    slug = re.sub(r"[^a-z0-9]+", "-", bez_polskich).strip("-")
    if not slug:
        raise ValueError(f"z opisu '{opis}' nie da się zrobić nazwy gałęzi")
    return f"{typ}/{slug}"
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def rozwiaz_konflikt(tekst: str, strona: str) -> str:
    """Usuwa znaczniki konfliktu, zostawiając wybraną wersję.

    strona: "nasza" (część nad =======), "ich" (pod =======) albo "obie"
    (nasza, potem ich). Linie poza konfliktami zostają bez zmian.
    Inna strona → ValueError.
    """
    # ROZWIĄZANIE-START: stan = "poza" / "nasza" / "ich", przełączany przez znaczniki
    if strona not in ("nasza", "ich", "obie"):
        raise ValueError(f"strona '{strona}' nieznana; wybierz: nasza, ich, obie")
    wynik = []
    stan = "poza"
    for linia in tekst.splitlines(keepends=True):
        if linia.startswith("<<<<<<<"):
            stan = "nasza"
        elif linia.startswith("=======") and stan == "nasza":
            stan = "ich"
        elif linia.startswith(">>>>>>>") and stan == "ich":
            stan = "poza"
        elif stan == "poza" or stan == strona or strona == "obie":
            wynik.append(linia)
    return "".join(wynik)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def utworz_repo(katalog: Path) -> str:
    """W pustym katalogu: git init, plik README.md z tekstem "# Projekt\\n",
    git add, commit "feat: pierwszy commit". Zwraca pełny hash commita.

    Błąd komendy gita → subprocess.CalledProcessError (check=True).
    """
    # ROZWIĄZANIE-START: subprocess.run([...], cwd=katalog, check=True, capture_output=True, text=True)
    tozsamosc = ["-c", "user.name=Kurs", "-c", "user.email=kurs@example.com", "-c", "commit.gpgsign=false"]

    def git(*argumenty: str) -> str:
        wynik = subprocess.run(
            ["git", *tozsamosc, *argumenty], cwd=katalog, check=True, capture_output=True, text=True
        )
        return wynik.stdout

    git("init")
    (katalog / "README.md").write_text("# Projekt\n", encoding="utf-8")
    git("add", "README.md")
    git("commit", "-m", "feat: pierwszy commit")
    return git("rev-parse", "HEAD").strip()
    # ROZWIĄZANIE-KONIEC
