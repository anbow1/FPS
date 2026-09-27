# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
"""Lekcja 02 — venv i pip."""

import re
from pathlib import PurePosixPath, PureWindowsPath

OPERATORY = ("==", "!=", ">=", "<=", ">", "<")


# Ćwiczenie 1
def czy_w_venv(prefix: str, base_prefix: str) -> bool:
    """Czy Python działa w venv? Przekaż sys.prefix i sys.base_prefix.

    >>> import sys
    >>> czy_w_venv(sys.prefix, sys.base_prefix)   # True po aktywacji .venv
    """
    # ROZWIĄZANIE-START: w venv te dwa katalogi się różnią
    return prefix != base_prefix
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def sciezka_pythona(katalog_venv: str, system: str) -> str:
    """Ścieżka do interpretera w venv jako tekst.

    system: "windows" → <venv>\\Scripts\\python.exe
            "linux" albo "macos" → <venv>/bin/python
    Inny system → ValueError.
    """
    # ROZWIĄZANIE-START: PureWindowsPath(katalog_venv) / "Scripts" / "python.exe"
    if system == "windows":
        return str(PureWindowsPath(katalog_venv) / "Scripts" / "python.exe")
    if system in ("linux", "macos"):
        return str(PurePosixPath(katalog_venv) / "bin" / "python")
    raise ValueError(f"nieznany system '{system}'; znane: windows, linux, macos")
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def komenda_aktywacji(powloka: str) -> str:
    """Komenda aktywująca venv o nazwie .venv w danej powłoce.

    "powershell" → .venv\\Scripts\\Activate.ps1
    "cmd"        → .venv\\Scripts\\activate.bat
    "bash"/"zsh" → source .venv/bin/activate
    Inna powłoka → ValueError.
    """
    # ROZWIĄZANIE-START: słownik powłoka → komenda
    komendy = {
        "powershell": r".venv\Scripts\Activate.ps1",
        "cmd": r".venv\Scripts\activate.bat",
        "bash": "source .venv/bin/activate",
        "zsh": "source .venv/bin/activate",
    }
    if powloka not in komendy:
        raise ValueError(f"nieznana powłoka '{powloka}'; znane: {', '.join(komendy)}")
    return komendy[powloka]
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def normalizuj_nazwe(nazwa: str) -> str:
    """Normalizacja nazwy pakietu wg PEP 503.

    >>> normalizuj_nazwe("Scikit_Learn")
    'scikit-learn'
    """
    # ROZWIĄZANIE-START: re.sub(r"[-_.]+", "-", ...) i lower()
    return re.sub(r"[-_.]+", "-", nazwa).lower()
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def parsuj_requirements(tekst: str) -> dict[str, str]:
    """Zamienia treść requirements.txt na słownik {znormalizowana_nazwa: specyfikator}.

    - komentarze (# ...) i puste linie pomijamy,
    - linie z opcjami (zaczynające się od "-", np. -r plik.txt) pomijamy,
    - extras ("requests[socks]") i znaczniki ("; python_version < '3.11'") odcinamy,
    - brak wersji → pusty specyfikator "",
    - w specyfikatorze usuwamy spacje: "pandas >= 2.0, <3" → ">=2.0,<3".

    >>> parsuj_requirements("pandas>=2.0  # dane\\nrequests[socks]==2.32.3")
    {'pandas': '>=2.0', 'requests': '==2.32.3'}
    """
    # ROZWIĄZANIE-START: re.match(r"[A-Za-z0-9._-]+", linia) wyciąga nazwę
    wynik = {}
    for surowa_linia in tekst.splitlines():
        linia = surowa_linia.split("#")[0].split(";")[0].strip()
        if not linia or linia.startswith("-"):
            continue
        dopasowanie = re.match(r"[A-Za-z0-9._-]+", linia)
        if dopasowanie is None:
            raise ValueError(f"nie rozumiem linii requirements: '{surowa_linia}'")
        nazwa = dopasowanie.group(0)
        reszta = linia[len(nazwa) :]
        if reszta.startswith("["):
            reszta = reszta[reszta.index("]") + 1 :]
        wynik[normalizuj_nazwe(nazwa)] = reszta.replace(" ", "")
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def porownaj_wersje(a: str, b: str) -> int:
    """Porównuje wersje liczbowe "X.Y.Z": -1 gdy a < b, 0 gdy równe, 1 gdy a > b.

    Brakujące segmenty to zera: "1.0" == "1.0.0".

    >>> porownaj_wersje("1.10.0", "1.9.2")
    1
    """
    # ROZWIĄZANIE-START: listy intów, dopełnione zerami do tej samej długości
    liczby_a = [int(segment) for segment in a.split(".")]
    liczby_b = [int(segment) for segment in b.split(".")]
    dlugosc = max(len(liczby_a), len(liczby_b))
    liczby_a += [0] * (dlugosc - len(liczby_a))
    liczby_b += [0] * (dlugosc - len(liczby_b))
    if liczby_a < liczby_b:
        return -1
    if liczby_a > liczby_b:
        return 1
    return 0
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 7
def spelnia_warunek(wersja: str, warunek: str) -> bool:
    """Czy wersja spełnia warunek typu ">=2.0,<3"? Pusty warunek spełnia każda wersja.

    Operatory: == != >= <= > <  (stała OPERATORY). Nieznany → ValueError.

    >>> spelnia_warunek("2.5.1", ">=2.0,<3")
    True
    """
    # ROZWIĄZANIE-START: dla każdego fragmentu: znajdź operator, porównaj_wersje, sprawdź wynik
    for fragment in warunek.replace(" ", "").split(","):
        if not fragment:
            continue
        operator = next((op for op in OPERATORY if fragment.startswith(op)), None)
        if operator is None:
            raise ValueError(f"brak operatora w '{fragment}'; znane: {' '.join(OPERATORY)}")
        wynik = porownaj_wersje(wersja, fragment[len(operator) :])
        spelniony = {
            "==": wynik == 0,
            "!=": wynik != 0,
            ">=": wynik >= 0,
            "<=": wynik <= 0,
            ">": wynik > 0,
            "<": wynik < 0,
        }[operator]
        if not spelniony:
            return False
    return True
    # ROZWIĄZANIE-KONIEC
