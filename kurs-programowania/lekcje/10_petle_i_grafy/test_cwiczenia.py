"""Testy lekcji 10. Uruchamiaj przez: python kurs.py sprawdz 10"""

import importlib
import math
import os
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


@contextmanager
def oczekuj_runtime_error() -> Iterator[None]:
    """Jak assertRaises(RuntimeError), ale przepuszcza NotImplementedError.

    NotImplementedError dziedziczy po RuntimeError, więc zwykłe assertRaises
    zaliczałoby test na niezrobionym ćwiczeniu.
    """
    try:
        yield
    except NotImplementedError:
        raise
    except RuntimeError:
        return
    raise AssertionError("oczekiwano RuntimeError, a funkcja zakończyła się bez błędu")


class TestGeneratory(unittest.TestCase):
    def test_cw1_partie(self) -> None:
        """cw1: partie po 2 z resztą; pusta sekwencja → brak partii"""
        self.assertEqual(list(cw.partie(range(5), 2)), [[0, 1], [2, 3], [4]])
        self.assertEqual(list(cw.partie([], 3)), [])

    def test_cw1_partie_sa_leniwe(self) -> None:
        """cw1: partie działają na nieskończonym generatorze (są leniwe)"""
        def naturalne() -> Any:
            liczba = 0
            while True:
                yield liczba
                liczba += 1
        self.assertEqual(next(iter(cw.partie(naturalne(), 3))), [0, 1, 2])

    def test_cw1_zly_rozmiar(self) -> None:
        """cw1: rozmiar 0 → ValueError"""
        with self.assertRaises(ValueError):
            list(cw.partie([1, 2], 0))

    def test_cw2_okna(self) -> None:
        """cw2: okna na napisie i liście, z krokiem"""
        self.assertEqual(list(cw.okna("abcde", 3)), ["abc", "bcd", "cde"])
        self.assertEqual(list(cw.okna([1, 2, 3, 4, 5], 2, krok=2)), [[1, 2], [3, 4]])
        self.assertEqual(list(cw.okna("ab", 3)), [])

    def test_cw2_zly_krok(self) -> None:
        """cw2: krok 0 → ValueError"""
        with self.assertRaises(ValueError):
            list(cw.okna("abc", 2, krok=0))


class TestZbieznosc(unittest.TestCase):
    def test_cw3_pierwiastek(self) -> None:
        """cw3: √2, √0.25, √1e6 zgodne z math.sqrt"""
        for liczba in (2.0, 0.25, 1e6):
            wynik, iteracje = cw.pierwiastek(liczba)
            self.assertAlmostEqual(wynik, math.sqrt(liczba), places=9)
            self.assertLess(iteracje, 100)

    def test_cw3_przypadki_brzegowe(self) -> None:
        """cw3: 0 → (0.0, 0); liczba ujemna → ValueError"""
        self.assertEqual(cw.pierwiastek(0), (0.0, 0))
        with self.assertRaises(ValueError):
            cw.pierwiastek(-4)

    def test_cw3_bezpiecznik(self) -> None:
        """cw3: za mało iteracji → RuntimeError zamiast złego wyniku"""
        with oczekuj_runtime_error():
            cw.pierwiastek(1e6, maks_iteracji=2)


class TestGrafy(unittest.TestCase):
    MIASTA = {
        "Gdańsk": ["Warszawa", "Poznań"],
        "Warszawa": ["Kraków", "Łódź"],
        "Poznań": ["Wrocław"],
        "Łódź": ["Kraków"],
        "Wrocław": ["Kraków"],
        "Kraków": ["Zakopane"],
    }

    def test_cw4_najkrotsza_sciezka(self) -> None:
        """cw4: BFS znajduje najkrótszą trasę"""
        self.assertEqual(cw.najkrotsza_sciezka(self.MIASTA, "Gdańsk", "Zakopane"),
                         ["Gdańsk", "Warszawa", "Kraków", "Zakopane"])
        self.assertEqual(cw.najkrotsza_sciezka(self.MIASTA, "Poznań", "Kraków"), ["Poznań", "Wrocław", "Kraków"])

    def test_cw4_brak_sciezki_i_start_rowny_celowi(self) -> None:
        """cw4: brak drogi → None; start == cel → [start]"""
        self.assertIsNone(cw.najkrotsza_sciezka(self.MIASTA, "Zakopane", "Gdańsk"))
        self.assertEqual(cw.najkrotsza_sciezka(self.MIASTA, "Łódź", "Łódź"), ["Łódź"])

    def test_cw4_cykl_nie_zapetla(self) -> None:
        """cw4: graf z cyklem nie zapętla BFS"""
        self.assertIsNone(cw.najkrotsza_sciezka({"A": ["B"], "B": ["A"]}, "A", "C"))

    def test_cw5_kolejnosc_zadan(self) -> None:
        """cw5: potok CI w poprawnej, deterministycznej kolejności"""
        zaleznosci = {"test": ["build"], "build": ["install"], "deploy": ["test", "lint"], "lint": ["install"]}
        self.assertEqual(cw.kolejnosc_zadan(zaleznosci), ["install", "build", "lint", "test", "deploy"])

    def test_cw5_cykl(self) -> None:
        """cw5: cykl → ValueError z nazwami zadań w cyklu"""
        with self.assertRaises(ValueError) as kontekst:
            cw.kolejnosc_zadan({"a": ["b"], "b": ["c"], "c": ["a"], "d": []})
        self.assertIn("a, b, c", str(kontekst.exception))


def zbuduj_agenta() -> Any:
    """Graf: planuj → dzialaj → (sprawdz) → dzialaj… aż 3 próby, potem KONIEC."""
    graf = cw.GrafStanow()
    graf.dodaj_wezel("planuj", lambda stan: {"plan": f"zrób: {stan['zadanie']}"})
    graf.dodaj_wezel("dzialaj", lambda stan: {"proby": stan["proby"] + 1})
    graf.dodaj_krawedz("planuj", "dzialaj")
    graf.dodaj_krawedz_warunkowa("dzialaj", lambda stan: cw.KONIEC if stan["proby"] >= 3 else "dzialaj")
    graf.ustaw_start("planuj")
    return graf


class TestGrafStanow(unittest.TestCase):
    def test_cw6_przeplyw_z_cyklem(self) -> None:
        """cw6: stan jest scalany, cykl kończy krawędź warunkowa"""
        wejscie = {"zadanie": "raport", "proby": 0}
        stan, sciezka = zbuduj_agenta().uruchom(wejscie)
        self.assertEqual(stan, {"zadanie": "raport", "proby": 3, "plan": "zrób: raport"})
        self.assertEqual(sciezka, ["planuj", "dzialaj", "dzialaj", "dzialaj"])
        self.assertEqual(wejscie, {"zadanie": "raport", "proby": 0}, "wejście nie może się zmienić")

    def test_cw6_limit_krokow(self) -> None:
        """cw6: za mały limit → RuntimeError"""
        with oczekuj_runtime_error():
            zbuduj_agenta().uruchom({"zadanie": "x", "proby": 0}, maks_krokow=3)

    def test_cw6_bledy_budowy(self) -> None:
        """cw6: duplikat węzła, nieznany cel, drugie wyjście, brak startu → ValueError"""
        graf = cw.GrafStanow()
        graf.dodaj_wezel("a", lambda stan: {})
        with self.assertRaises(ValueError):
            graf.dodaj_wezel("a", lambda stan: {})
        with self.assertRaises(ValueError):
            graf.dodaj_krawedz("a", "nieznany")
        graf.dodaj_krawedz("a", cw.KONIEC)
        with self.assertRaises(ValueError):
            graf.dodaj_krawedz_warunkowa("a", lambda stan: cw.KONIEC)
        with self.assertRaises(ValueError):
            graf.uruchom({})

    def test_cw6_bledy_w_trakcie(self) -> None:
        """cw6: węzeł bez wyjścia albo wybór nieznanego węzła → RuntimeError"""
        graf = cw.GrafStanow()
        graf.dodaj_wezel("a", lambda stan: {})
        graf.ustaw_start("a")
        with oczekuj_runtime_error():
            graf.uruchom({})
        graf.dodaj_krawedz_warunkowa("a", lambda stan: "zgubiony")
        with oczekuj_runtime_error():
            graf.uruchom({})


if __name__ == "__main__":
    unittest.main()
