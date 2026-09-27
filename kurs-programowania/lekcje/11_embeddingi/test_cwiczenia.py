"""Testy lekcji 11. Uruchamiaj przez: python kurs.py sprawdz 11"""

import importlib
import math
import os
import subprocess
import sys
import unittest
from pathlib import Path

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestWektory(unittest.TestCase):
    def test_cw1_tokenizuj(self) -> None:
        """cw1: małe litery, polskie znaki, bez interpunkcji"""
        self.assertEqual(cw.tokenizuj("Jak zresetować HASŁO? Krok 2."), ["jak", "zresetować", "hasło", "krok", "2"])
        self.assertEqual(cw.tokenizuj("  ...  "), [])

    def test_cw2_worek_slow(self) -> None:
        """cw2: liczniki słów w kolejności słownika"""
        self.assertEqual(cw.wektor_bow(["kot", "ma", "kot"], ["kot", "pies", "ma"]), [2.0, 0.0, 1.0])

    def test_cw3_cosinus_znane_wartosci(self) -> None:
        """cw3: ten sam kierunek 1, prostopadłe 0, przeciwne -1, 45° → √2/2"""
        self.assertAlmostEqual(cw.podobienstwo_cosinusowe([1, 2], [2, 4]), 1.0)
        self.assertAlmostEqual(cw.podobienstwo_cosinusowe([1, 0], [0, 3]), 0.0)
        self.assertAlmostEqual(cw.podobienstwo_cosinusowe([1, 1], [-1, -1]), -1.0)
        self.assertAlmostEqual(cw.podobienstwo_cosinusowe([1, 0], [1, 1]), math.sqrt(2) / 2)

    def test_cw3_przypadki_brzegowe(self) -> None:
        """cw3: wektor zerowy → 0.0; różne wymiary → ValueError"""
        self.assertEqual(cw.podobienstwo_cosinusowe([0, 0], [1, 2]), 0.0)
        with self.assertRaises(ValueError):
            cw.podobienstwo_cosinusowe([1, 2], [1, 2, 3])

    def test_cw4_normalizuj(self) -> None:
        """cw4: [3, 4] → [0.6, 0.8]; zerowy → ValueError"""
        wynik = cw.normalizuj([3.0, 4.0])
        self.assertAlmostEqual(wynik[0], 0.6)
        self.assertAlmostEqual(wynik[1], 0.8)
        with self.assertRaises(ValueError):
            cw.normalizuj([0.0, 0.0])


class TestHaszowanie(unittest.TestCase):
    def test_cw5_dlugosc_i_normalizacja(self) -> None:
        """cw5: wektor ma zadany wymiar i długość 1"""
        wektor = cw.embedding_haszujacy("ala ma kota", 16)
        self.assertEqual(len(wektor), 16)
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in wektor)), 1.0)

    def test_cw5_znana_pozycja(self) -> None:
        """cw5: "kot" trafia na pozycję crc32("kot") % 8 == 6"""
        self.assertEqual(cw.embedding_haszujacy("Kot!", 8), [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0])

    def test_cw5_pusty_tekst_i_zly_wymiar(self) -> None:
        """cw5: pusty tekst → zera; wymiar 0 → ValueError"""
        self.assertEqual(cw.embedding_haszujacy("", 4), [0.0, 0.0, 0.0, 0.0])
        with self.assertRaises(ValueError):
            cw.embedding_haszujacy("x", 0)

    def test_cw5_stabilny_miedzy_uruchomieniami(self) -> None:
        """cw5: ten sam wynik w innym procesie Pythona (nie używaj hash())"""
        oczekiwany = str(cw.embedding_haszujacy("zażółć gęślą jaźń", 32))  # najpierw w tym procesie
        katalog = str(Path(__file__).parent)
        modul = os.environ.get("KURS_MODUL", "cwiczenia")
        kod = f"import sys; sys.path.insert(0, {katalog!r}); import {modul} as m; print(m.embedding_haszujacy('zażółć gęślą jaźń', 32))"
        inny_proces = subprocess.run([sys.executable, "-c", kod], capture_output=True, text=True, check=True,
                                     env={**os.environ, "PYTHONHASHSEED": "random"})
        self.assertEqual(inny_proces.stdout.strip(), oczekiwany)


class TestWyszukiwanie(unittest.TestCase):
    def test_cw6_idf(self) -> None:
        """cw6: słowo we wszystkich dokumentach ma wagę 1, rzadkie — większą"""
        wagi = cw.wagi_idf([["kot", "ma"], ["pies", "ma"], ["ma", "ma"]])
        self.assertAlmostEqual(wagi["ma"], 1.0)
        self.assertAlmostEqual(wagi["kot"], math.log(4 / 2) + 1)
        self.assertEqual(set(wagi), {"kot", "pies", "ma"})

    def test_cw7_najblizsze(self) -> None:
        """cw7: sortowanie po podobieństwie, remis po id, limit k"""
        wektory = {"b": [1.0, 0.0], "a": [2.0, 0.0], "c": [0.0, 1.0], "d": [1.0, 1.0]}
        wynik = cw.najblizsze([1.0, 0.0], wektory, k=3)
        self.assertEqual([identyfikator for identyfikator, _ in wynik], ["a", "b", "d"])
        self.assertAlmostEqual(wynik[2][1], math.sqrt(2) / 2)
        with self.assertRaises(ValueError):
            cw.najblizsze([1.0, 0.0], wektory, k=0)


if __name__ == "__main__":
    unittest.main()
