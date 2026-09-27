"""Testy lekcji 01. Uruchamiaj przez: python kurs.py sprawdz 01"""

import importlib
import os
import unittest

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestPodstawy(unittest.TestCase):
    def test_cw1_powitanie_zawiera_imie(self) -> None:
        """cw1: powitanie("Ala") zwraca "Cześć, Ala!\""""
        self.assertEqual(cw.powitanie("Ala"), "Cześć, Ala!")
        self.assertEqual(cw.powitanie("Jan"), "Cześć, Jan!")

    def test_cw2_suma_parzystych(self) -> None:
        """cw2: suma_parzystych sumuje tylko liczby parzyste"""
        self.assertEqual(cw.suma_parzystych([1, 2, 3, 4]), 6)
        self.assertEqual(cw.suma_parzystych([-2, 3, 10]), 8)

    def test_cw2_suma_parzystych_pustej_listy_to_zero(self) -> None:
        """cw2: pusta lista → 0"""
        self.assertEqual(cw.suma_parzystych([]), 0)

    def test_cw3_policz_litery_ignoruje_wielkosc_i_znaki(self) -> None:
        """cw3: policz_litery liczy tylko litery, bez względu na wielkość"""
        self.assertEqual(cw.policz_litery("Ala ma!"), {"a": 3, "l": 1, "m": 1})

    def test_cw3_policz_litery_polskie_znaki(self) -> None:
        """cw3: polskie litery też są literami"""
        self.assertEqual(cw.policz_litery("Żółw"), {"ż": 1, "ó": 1, "ł": 1, "w": 1})

    def test_cw4_fizzbuzz_pierwsze_15(self) -> None:
        """cw4: fizzbuzz(15) — znana sekwencja"""
        oczekiwane = ["1", "2", "Fizz", "4", "Buzz", "Fizz", "7", "8", "Fizz", "Buzz",
                      "11", "Fizz", "13", "14", "FizzBuzz"]
        self.assertEqual(cw.fizzbuzz(15), oczekiwane)

    def test_cw4_fizzbuzz_zero_to_pusta_lista(self) -> None:
        """cw4: fizzbuzz(0) → []"""
        self.assertEqual(cw.fizzbuzz(0), [])

    def test_cw5_statystyki(self) -> None:
        """cw5: statystyki zwraca (min, max, średnia)"""
        self.assertEqual(cw.statystyki([2, 4, 9]), (2, 9, 5.0))
        self.assertEqual(cw.statystyki([7]), (7, 7, 7.0))

    def test_cw5_statystyki_pustej_listy_to_blad(self) -> None:
        """cw5: pusta lista → ValueError"""
        with self.assertRaises(ValueError):
            cw.statystyki([])

    def test_cw6_odwroc_slowa(self) -> None:
        """cw6: odwroc_slowa odwraca kolejność i zjada nadmiarowe spacje"""
        self.assertEqual(cw.odwroc_slowa("ala  ma kota"), "kota ma ala")
        self.assertEqual(cw.odwroc_slowa(""), "")


class TestKonto(unittest.TestCase):
    def test_cw7_nowe_konto_ma_zerowe_saldo(self) -> None:
        """cw7: nowe konto ma saldo 0 i pustą historię"""
        konto = cw.Konto("Ala")
        self.assertEqual(konto.wlasciciel, "Ala")
        self.assertEqual(konto.saldo_gr, 0)
        self.assertEqual(konto.historia, [])

    def test_cw7_wplata_i_wyplata_zmieniaja_saldo(self) -> None:
        """cw7: wpłata i wypłata zmieniają saldo i trafiają do historii"""
        konto = cw.Konto("Ala")
        self.assertEqual(konto.wplac(500), 500)
        self.assertEqual(konto.wyplac(200), 300)
        self.assertEqual(konto.historia, [("wplata", 500), ("wyplata", 200)])

    def test_cw7_nie_mozna_wyplacic_wiecej_niz_saldo(self) -> None:
        """cw7: za duża wypłata → ValueError, saldo bez zmian"""
        konto = cw.Konto("Ala")
        konto.wplac(100)
        with self.assertRaises(ValueError):
            konto.wyplac(101)
        self.assertEqual(konto.saldo_gr, 100)

    def test_cw7_kwoty_musza_byc_dodatnie(self) -> None:
        """cw7: wpłata/wypłata 0 lub ujemna → ValueError"""
        konto = cw.Konto("Ala")
        for zla_kwota in (0, -5):
            with self.assertRaises(ValueError):
                konto.wplac(zla_kwota)
            with self.assertRaises(ValueError):
                konto.wyplac(zla_kwota)


if __name__ == "__main__":
    unittest.main()
