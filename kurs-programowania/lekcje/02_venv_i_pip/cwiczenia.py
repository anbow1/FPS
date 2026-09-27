# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 02   (albo: python kurs.py obserwuj 02)
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
    # Podpowiedź: w venv te dwa katalogi się różnią
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def sciezka_pythona(katalog_venv: str, system: str) -> str:
    """Ścieżka do interpretera w venv jako tekst.

    system: "windows" → <venv>\\Scripts\\python.exe
            "linux" albo "macos" → <venv>/bin/python
    Inny system → ValueError.
    """
    # Podpowiedź: PureWindowsPath(katalog_venv) / "Scripts" / "python.exe"
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def komenda_aktywacji(powloka: str) -> str:
    """Komenda aktywująca venv o nazwie .venv w danej powłoce.

    "powershell" → .venv\\Scripts\\Activate.ps1
    "cmd"        → .venv\\Scripts\\activate.bat
    "bash"/"zsh" → source .venv/bin/activate
    Inna powłoka → ValueError.
    """
    # Podpowiedź: słownik powłoka → komenda
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def normalizuj_nazwe(nazwa: str) -> str:
    """Normalizacja nazwy pakietu wg PEP 503.

    >>> normalizuj_nazwe("Scikit_Learn")
    'scikit-learn'
    """
    # Podpowiedź: re.sub(r"[-_.]+", "-", ...) i lower()
    raise NotImplementedError("Do zrobienia")


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
    # Podpowiedź: re.match(r"[A-Za-z0-9._-]+", linia) wyciąga nazwę
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def porownaj_wersje(a: str, b: str) -> int:
    """Porównuje wersje liczbowe "X.Y.Z": -1 gdy a < b, 0 gdy równe, 1 gdy a > b.

    Brakujące segmenty to zera: "1.0" == "1.0.0".

    >>> porownaj_wersje("1.10.0", "1.9.2")
    1
    """
    # Podpowiedź: listy intów, dopełnione zerami do tej samej długości
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 7
def spelnia_warunek(wersja: str, warunek: str) -> bool:
    """Czy wersja spełnia warunek typu ">=2.0,<3"? Pusty warunek spełnia każda wersja.

    Operatory: == != >= <= > <  (stała OPERATORY). Nieznany → ValueError.

    >>> spelnia_warunek("2.5.1", ">=2.0,<3")
    True
    """
    # Podpowiedź: dla każdego fragmentu: znajdź operator, porównaj_wersje, sprawdź wynik
    raise NotImplementedError("Do zrobienia")
