"""Uruchamianie testów lekcji i zamiana wyników na przyjazne komunikaty."""

import os
import sys
import traceback
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType

from silnik.lekcje import Lekcja

OK = "ok"
BLAD = "blad"
DO_ZROBIENIA = "do_zrobienia"
POMINIETY = "pominiety"

# Testy wybierają moduł do sprawdzenia z tej zmiennej: "cwiczenia" (domyślnie) albo "rozwiazania".
ZMIENNA_MODULU = "KURS_MODUL"

_InfoWyjatku = tuple[type[BaseException], BaseException, TracebackType | None]


@dataclass
class WynikTestu:
    nazwa: str
    opis: str
    status: str
    komunikat: str = ""


@dataclass
class WynikLekcji:
    lekcja: Lekcja
    testy: list[WynikTestu] = field(default_factory=list)

    def ile(self, status: str) -> int:
        return sum(1 for test in self.testy if test.status == status)

    @property
    def zaliczona(self) -> bool:
        return bool(self.testy) and self.ile(OK) == len(self.testy)


def sprawdz_lekcje(lekcja: Lekcja, modul: str = "cwiczenia") -> WynikLekcji:
    """Uruchamia test_*.py z katalogu lekcji przeciwko modułowi `modul`."""
    if modul not in ("cwiczenia", "rozwiazania"):
        raise ValueError(f"moduł '{modul}' nieznany; dozwolone: cwiczenia, rozwiazania")
    katalog = str(lekcja.katalog)
    poprzedni_modul = os.environ.get(ZMIENNA_MODULU)
    os.environ[ZMIENNA_MODULU] = modul
    sys.path.insert(0, katalog)
    # Każda lekcja ma własne "cwiczenia" i "test_cwiczenia" — bez czyszczenia
    # druga lekcja dostałaby moduły z pierwszej, zapamiętane w sys.modules.
    _zapomnij_moduly_z(lekcja.katalog)
    try:
        zestaw = unittest.TestLoader().discover(katalog, pattern="test_*.py", top_level_dir=katalog)
        zbieracz = _Zbieracz(lekcja.katalog)
        zestaw.run(zbieracz)
    finally:
        sys.path.remove(katalog)
        _zapomnij_moduly_z(lekcja.katalog)
        if poprzedni_modul is None:
            os.environ.pop(ZMIENNA_MODULU, None)
        else:
            os.environ[ZMIENNA_MODULU] = poprzedni_modul
    wynik = WynikLekcji(lekcja, sorted(zbieracz.wyniki, key=lambda test: test.nazwa))
    return wynik


def _zapomnij_moduly_z(katalog: Path) -> None:
    for nazwa, modul in list(sys.modules.items()):
        plik = getattr(modul, "__file__", None)
        if plik and Path(plik).resolve().parent == katalog.resolve():
            del sys.modules[nazwa]


class _Zbieracz(unittest.TestResult):
    """Zbiera wyniki jako WynikTestu zamiast drukować kropki."""

    def __init__(self, katalog_lekcji: Path) -> None:
        super().__init__()
        self.katalog_lekcji = katalog_lekcji
        self.wyniki: list[WynikTestu] = []

    def addSuccess(self, test: unittest.TestCase) -> None:
        super().addSuccess(test)
        self._dodaj(test, OK)

    def addSkip(self, test: unittest.TestCase, reason: str) -> None:
        super().addSkip(test, reason)
        self._dodaj(test, POMINIETY, reason)

    def addFailure(self, test: unittest.TestCase, err: _InfoWyjatku) -> None:  # type: ignore[override]  # stdlib types err loosely
        super().addFailure(test, err)
        self._dodaj(test, BLAD, _opisz_wyjatek(err, self.katalog_lekcji))

    def addError(self, test: unittest.TestCase, err: _InfoWyjatku) -> None:  # type: ignore[override]  # stdlib types err loosely
        super().addError(test, err)
        typ_wyjatku = err[0]
        if issubclass(typ_wyjatku, NotImplementedError):
            self._dodaj(test, DO_ZROBIENIA, "funkcja jeszcze nie napisana")
        else:
            self._dodaj(test, BLAD, _opisz_wyjatek(err, self.katalog_lekcji))

    def _dodaj(self, test: unittest.TestCase, status: str, komunikat: str = "") -> None:
        nazwa = test.id().split(".")[-1]
        opis = test.shortDescription() or nazwa.removeprefix("test_").replace("_", " ")
        self.wyniki.append(WynikTestu(nazwa, opis, status, komunikat))


def _opisz_wyjatek(err: _InfoWyjatku, katalog_lekcji: Path) -> str:
    """Krótki opis błędu: typ, treść i ostatnia linia z pliku ucznia."""
    typ_wyjatku, wartosc, slad = err
    tresc = str(wartosc).strip()
    linie = [f"{typ_wyjatku.__name__}: {tresc}" if tresc else typ_wyjatku.__name__]
    miejsce = _ostatnia_ramka_ucznia(slad, katalog_lekcji)
    if miejsce:
        linie.append(miejsce)
    return "\n".join(linie)


def _ostatnia_ramka_ucznia(slad: TracebackType | None, katalog_lekcji: Path) -> str:
    ostatnia = ""
    for ramka in traceback.extract_tb(slad):
        sciezka = Path(ramka.filename)
        if sciezka.parent == katalog_lekcji and not sciezka.name.startswith("test_"):
            ostatnia = f"{sciezka.name}:{ramka.lineno}  →  {(ramka.line or '').strip()}"
    return ostatnia
