"""Testy lekcji 12. Uruchamiaj przez: python kurs.py sprawdz 12"""

import importlib
import os
import unittest
from pathlib import Path

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))

DOKUMENTY = {sciezka.stem: sciezka.read_text(encoding="utf-8")
             for sciezka in sorted((Path(__file__).parent / "dokumenty").glob("*.md"))}


def fragment(zrodlo: str, tekst: str) -> "cw.Fragment":
    return cw.Fragment(zrodlo, tekst, cw.embedding_haszujacy(tekst))


class TestIndeksowanie(unittest.TestCase):
    def test_cw1_fragmenty_z_zakladka(self) -> None:
        """cw1: "a b c d e f g" po 3 z zakładką 1 → abc, cde, efg"""
        self.assertEqual(cw.podziel_na_fragmenty("a b c d e f g", 3, 1), ["a b c", "c d e", "e f g"])

    def test_cw1_krotki_ostatni_i_bez_zakladki(self) -> None:
        """cw1: ostatni fragment krótszy; bez zakładki; tekst krótszy niż rozmiar"""
        self.assertEqual(cw.podziel_na_fragmenty("a b c d e", 2, 0), ["a b", "c d", "e"])
        self.assertEqual(cw.podziel_na_fragmenty("a b c d e f", 4, 2), ["a b c d", "c d e f"])
        self.assertEqual(cw.podziel_na_fragmenty("a  b\nc", 10, 3), ["a b c"])
        self.assertEqual(cw.podziel_na_fragmenty("   ", 3, 1), [])

    def test_cw1_zle_parametry(self) -> None:
        """cw1: zakładka >= rozmiar albo rozmiar 0 → ValueError"""
        for rozmiar, zakladka in ((3, 3), (0, 0), (3, -1)):
            with self.assertRaises(ValueError):
                cw.podziel_na_fragmenty("a b c", rozmiar, zakladka)

    def test_cw2_zbuduj_indeks(self) -> None:
        """cw2: źródła "nazwa#numer" i wektory z embedding_haszujacy"""
        indeks = cw.zbuduj_indeks({"x": "a b c d e", "y": "f g"}, rozmiar=3, zakladka=1)
        self.assertEqual([f.zrodlo for f in indeks], ["x#0", "x#1", "y#0"])
        self.assertEqual([f.tekst for f in indeks], ["a b c", "c d e", "f g"])
        self.assertEqual(indeks[2].wektor, cw.embedding_haszujacy("f g"))


class TestWyszukiwanie(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.indeks = [
            fragment("zwroty#0", "Zwrot towaru możliwy w ciągu 30 dni od dostarczenia."),
            fragment("dostawa#0", "Dostawa kurierem kosztuje 15 zł, paczkomat 12 zł."),
            fragment("punkty#0", "Za każde 10 zł dostajesz punkt w programie lojalnościowym."),
        ]

    def test_cw3_najlepsze_trafienie(self) -> None:
        """cw3: pytanie o dostawę → najpierw fragment o dostawie"""
        wynik = cw.wyszukaj(self.indeks, "Ile kosztuje dostawa kurierem?", k=2, prog=0.0)
        self.assertEqual(wynik[0][0].zrodlo, "dostawa#0")
        self.assertEqual(len(wynik), 2)
        self.assertGreaterEqual(wynik[0][1], wynik[1][1])

    def test_cw3_prog_odcina_nietrafione(self) -> None:
        """cw3: pytanie nie na temat przy progu 0.25 → brak wyników; k=0 → ValueError"""
        self.assertEqual(cw.wyszukaj(self.indeks, "Jaka jest stolica Australii?", k=3, prog=0.25), [])
        with self.assertRaises(ValueError):
            cw.wyszukaj(self.indeks, "dostawa", k=0)

    def test_cw6_recall_na_prawdziwych_dokumentach(self) -> None:
        """cw6: recall@1 wyszukiwarki na dokumentach z katalogu dokumenty/ wynosi 1.0"""
        indeks = cw.zbuduj_indeks(DOKUMENTY)
        pytania = {
            "Ile mam czasu na zwrot towaru?": "zwroty",
            "Ile kosztuje dostawa kurierem?": "dostawa",
            "Na co mogę wymienić punkty?": "program_lojalnosciowy",
            "Czy wysyłacie za granicę?": "dostawa",
            "Jak zgłosić reklamację?": "zwroty",
            "Czy dostanę coś w urodziny?": "program_lojalnosciowy",
        }
        wyniki = [[f.zrodlo.split("#")[0] for f, _ in cw.wyszukaj(indeks, pytanie, k=3, prog=0.0)] for pytanie in pytania]
        self.assertEqual(cw.recall_at_k(wyniki, list(pytania.values()), k=1), 1.0)

    def test_cw6_recall_znane_wartosci(self) -> None:
        """cw6: 2 z 4 w top-1, 3 z 4 w top-2; złe dane → ValueError"""
        wyniki = [["a", "b"], ["b", "a"], ["c", "x"], ["x", "y"]]
        oczekiwane = ["a", "a", "c", "z"]
        self.assertEqual(cw.recall_at_k(wyniki, oczekiwane, 1), 0.5)
        self.assertEqual(cw.recall_at_k(wyniki, oczekiwane, 2), 0.75)
        with self.assertRaises(ValueError):
            cw.recall_at_k([], [], 1)


class TestGeneracja(unittest.TestCase):
    def test_cw4_uklad_promptu(self) -> None:
        """cw4: instrukcja, numerowane źródła, pytanie"""
        trafienia = [(fragment("a#0", "Tekst A."), 0.9), (fragment("b#2", "Tekst B."), 0.5)]
        oczekiwany = cw.INSTRUKCJA + "\n\nŹródła:\n[1] (a#0) Tekst A.\n[2] (b#2) Tekst B.\n\nPytanie: Co?"
        self.assertEqual(cw.zbuduj_prompt("Co?", trafienia), oczekiwany)

    def test_cw5_cytowania(self) -> None:
        """cw5: poprawne i zmyślone numery, bez powtórzeń, posortowane"""
        self.assertEqual(cw.sprawdz_cytowania("Tak [2]. Także [1] i [2], ale [7] i [0].", 3), ([1, 2], [0, 7]))
        self.assertEqual(cw.sprawdz_cytowania("Bez cytowań.", 3), ([], []))

    def test_cw7_pelny_potok(self) -> None:
        """cw7: model dostaje prompt ze źródłami; zmyślone cytowanie → ostrzeżenie"""
        indeks = cw.zbuduj_indeks(DOKUMENTY)
        prompty: list[str] = []

        def model(prompt: str) -> str:
            prompty.append(prompt)
            return "Masz 30 dni [1] [5]."

        odpowiedz = cw.odpowiedz_rag("Ile mam czasu na zwrot towaru?", indeks, model)
        self.assertEqual(len(prompty), 1)
        self.assertIn("(zwroty#0)", prompty[0])
        self.assertTrue(odpowiedz.startswith("Masz 30 dni [1] [5]."))
        self.assertTrue(odpowiedz.endswith("Uwaga: odpowiedź cytuje nieistniejące źródła: [5]"))

    def test_cw7_brak_trafien_nie_wola_modelu(self) -> None:
        """cw7: pytanie nie na temat → BRAK_ODPOWIEDZI, model nie jest wołany"""
        indeks = cw.zbuduj_indeks(DOKUMENTY)

        def model(prompt: str) -> str:
            raise AssertionError("model nie powinien być wołany bez kontekstu")

        self.assertEqual(cw.odpowiedz_rag("Jaka jest stolica Australii?", indeks, model), cw.BRAK_ODPOWIEDZI)


if __name__ == "__main__":
    unittest.main()
