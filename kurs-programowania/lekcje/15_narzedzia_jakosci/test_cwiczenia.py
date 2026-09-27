"""Testy lekcji 15. Uruchamiaj przez: python kurs.py sprawdz 15"""

import importlib
import os
import unittest
from collections.abc import Callable
from typing import Any

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


def poprawna(cena_gr: int, rabat_procent: int) -> int:
    if cena_gr < 0 or not 0 <= rabat_procent <= 100:
        raise ValueError("złe dane")
    return cena_gr * (100 - rabat_procent) // 100


def zaokragla_w_gore(cena_gr: int, rabat_procent: int) -> int:
    if cena_gr < 0 or not 0 <= rabat_procent <= 100:
        raise ValueError("złe dane")
    return -(-cena_gr * (100 - rabat_procent) // 100)


def odrzuca_rabat_100(cena_gr: int, rabat_procent: int) -> int:
    if cena_gr < 0 or not 0 <= rabat_procent < 100:
        raise ValueError("złe dane")
    return cena_gr * (100 - rabat_procent) // 100


def przyjmuje_ujemna_cene(cena_gr: int, rabat_procent: int) -> int:
    if not 0 <= rabat_procent <= 100:
        raise ValueError("złe dane")
    return cena_gr * (100 - rabat_procent) // 100


def przyjmuje_rabat_ponad_100(cena_gr: int, rabat_procent: int) -> int:
    if cena_gr < 0 or rabat_procent < 0:
        raise ValueError("złe dane")
    return max(0, cena_gr * (100 - rabat_procent) // 100)


def zwraca_ulamek(cena_gr: int, rabat_procent: int) -> float:
    if cena_gr < 0 or not 0 <= rabat_procent <= 100:
        raise ValueError("złe dane")
    return cena_gr * (100 - rabat_procent) / 100


def zwraca_sam_rabat(cena_gr: int, rabat_procent: int) -> int:
    if cena_gr < 0 or not 0 <= rabat_procent <= 100:
        raise ValueError("złe dane")
    return cena_gr * rabat_procent // 100


MUTANTY: dict[str, Callable[[int, int], Any]] = {
    "zaokrągla w górę zamiast w dół": zaokragla_w_gore,
    "odrzuca rabat 100%": odrzuca_rabat_100,
    "przyjmuje ujemną cenę": przyjmuje_ujemna_cene,
    "przyjmuje rabat powyżej 100%": przyjmuje_rabat_ponad_100,
    "zwraca ułamek groszy": zwraca_ulamek,
    "zwraca kwotę rabatu zamiast ceny": zwraca_sam_rabat,
}


def czy_mutant_zabity(mutant: Callable[[int, int], Any]) -> bool:
    try:
        cw.sprawdz_cene_z_rabatem(mutant)
    except NotImplementedError:
        raise
    except Exception:  # AssertionError albo nieoczekiwany wyjątek mutanta — tak czy inaczej wykryty
        return True
    return False


class TestMutacyjny(unittest.TestCase):
    def test_cw1_poprawna_funkcja_przechodzi_twoje_testy(self) -> None:
        """cw1: poprawna implementacja przechodzi Twoje testy"""
        cw.sprawdz_cene_z_rabatem(poprawna)

    def test_cw1_twoje_testy_zabijaja_wszystkie_mutanty(self) -> None:
        """cw1: Twoje testy wykrywają każdego z 6 mutantów"""
        przezyly = [opis for opis, mutant in MUTANTY.items() if not czy_mutant_zabity(mutant)]
        self.assertEqual(przezyly, [], f"mutanty, których Twoje testy nie wykryły: {przezyly}")


class TestWynikiNarzedzi(unittest.TestCase):
    RUFF = (
        "src/sklep/ceny.py:3:8: F401 [*] `os` imported but unused\n"
        "C:\\projekt\\app.py:12:5: E711 Comparison to `None` should be `cond is None`\n"
        "tests/test_a.py:1:1: I001 [*] Import block is un-sorted or un-formatted\n"
        "src/sklep/koszyk.py:7:1: F401 [*] `sys` imported but unused\n"
        "Found 4 errors.\n"
        "[*] 3 fixable with the `--fix` option.\n"
    )

    def test_cw2_parsuj_ruff(self) -> None:
        """cw2: pola uwag, flaga [*], ścieżka z Windows, linie podsumowania pominięte"""
        uwagi = cw.parsuj_ruff(self.RUFF)
        self.assertEqual(len(uwagi), 4)
        self.assertEqual(uwagi[0], {"plik": "src/sklep/ceny.py", "linia": 3, "kolumna": 8, "kod": "F401",
                                    "naprawialny": True, "opis": "`os` imported but unused"})
        self.assertEqual((uwagi[1]["plik"], uwagi[1]["linia"], uwagi[1]["kod"], uwagi[1]["naprawialny"]),
                         ("C:\\projekt\\app.py", 12, "E711", False))

    def test_cw3_podsumuj(self) -> None:
        """cw3: najczęstszy kod pierwszy, remis alfabetycznie"""
        self.assertEqual(cw.podsumuj(cw.parsuj_ruff(self.RUFF)), [("F401", 2), ("E711", 1), ("I001", 1)])
        self.assertEqual(cw.podsumuj([]), [])

    def test_cw4_parsuj_pytest(self) -> None:
        """cw4: wszystkie liczby, liczba pojedyncza i mnoga, czas"""
        self.assertEqual(
            cw.parsuj_pytest("=== 2 failed, 10 passed, 1 skipped, 1 error, 3 warnings in 0.52s ==="),
            {"passed": 10, "failed": 2, "skipped": 1, "errors": 1, "warnings": 3, "czas_s": 0.52},
        )
        self.assertEqual(
            cw.parsuj_pytest("9 passed, 2 errors, 1 warning in 1.03s"),
            {"passed": 9, "failed": 0, "skipped": 0, "errors": 2, "warnings": 1, "czas_s": 1.03},
        )
        self.assertEqual(cw.parsuj_pytest("no tests ran")["czas_s"], 0.0)

    def test_cw5_zakresy(self) -> None:
        """cw5: 3-5, 9, 11-12 (nieposortowane, z powtórzeniem); pusto; jedna linia"""
        self.assertEqual(cw.zakresy([9, 3, 4, 5, 11, 12, 4]), "3-5, 9, 11-12")
        self.assertEqual(cw.zakresy([]), "")
        self.assertEqual(cw.zakresy([7]), "7")

    def test_cw5_procent_pokrycia(self) -> None:
        """cw5: 17/20 → 85.0; 2/3 → 66.7; 0/0 → 100.0; złe dane → ValueError"""
        self.assertEqual(cw.procent_pokrycia(17, 20), 85.0)
        self.assertEqual(cw.procent_pokrycia(2, 3), 66.7)
        self.assertEqual(cw.procent_pokrycia(0, 0), 100.0)
        with self.assertRaises(ValueError):
            cw.procent_pokrycia(5, 3)

    def test_cw6_zmierz_mediana_z_falszywym_zegarem(self) -> None:
        """cw6: czasy 1, 5, 2 s → mediana 2 s; funkcja wywołana 3 razy"""
        odczyty = iter([0.0, 1.0, 10.0, 15.0, 20.0, 22.0])
        wywolania: list[int] = []
        wynik = cw.zmierz(lambda: wywolania.append(1), 3, zegar=lambda: next(odczyty))
        self.assertEqual((wynik, len(wywolania)), (2.0, 3))
        with self.assertRaises(ValueError):
            cw.zmierz(lambda: None, 0)


if __name__ == "__main__":
    unittest.main()
