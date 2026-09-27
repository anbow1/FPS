"""Testy lekcji 03. Uruchamiaj przez: python kurs.py sprawdz 03"""

import importlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestLicznik(unittest.TestCase):
    def test_cw1_policz_jak_wc(self) -> None:
        """cw1: policz("ala ma\\nkota\\n") → 2 linie, 3 słowa, 12 znaków"""
        self.assertEqual(cw.policz("ala ma\nkota\n"), {"linie": 2, "slowa": 3, "znaki": 12})

    def test_cw1_pusty_tekst(self) -> None:
        """cw1: pusty tekst → same zera"""
        self.assertEqual(cw.policz(""), {"linie": 0, "slowa": 0, "znaki": 0})

    def test_cw2_parser_flagi_i_pliki(self) -> None:
        """cw2: parser rozumie pliki i flagi -l -w -c"""
        opcje = cw.zbuduj_parser().parse_args(["a.txt", "b.txt", "-l", "--znaki"])
        self.assertEqual(opcje.pliki, ["a.txt", "b.txt"])
        self.assertTrue(opcje.linie)
        self.assertFalse(opcje.slowa)
        self.assertTrue(opcje.znaki)

    def test_cw2_parser_bez_argumentow(self) -> None:
        """cw2: bez argumentów → pusta lista plików"""
        opcje = cw.zbuduj_parser().parse_args([])
        self.assertEqual(opcje.pliki, [])


class TestMain(unittest.TestCase):
    def uruchom_main(self, argumenty: list[str], stdin: str = "") -> tuple[int, str, str]:
        wyjscie, bledy = io.StringIO(), io.StringIO()
        kod = cw.main(argumenty, io.StringIO(stdin), wyjscie, bledy)
        return kod, wyjscie.getvalue(), bledy.getvalue()

    def test_cw3_czyta_stdin_bez_plikow(self) -> None:
        """cw3: bez plików czyta stdin i wypisuje "linie słowa znaki\""""
        self.assertEqual(self.uruchom_main([], "ala ma\nkota\n"), (0, "2 3 12\n", ""))

    def test_cw3_flaga_wybiera_liczbe(self) -> None:
        """cw3: -w wypisuje tylko słowa"""
        self.assertEqual(self.uruchom_main(["-w"], "a b c"), (0, "3\n", ""))

    def test_cw3_pliki_i_brakujacy_plik(self) -> None:
        """cw3: pliki są liczone, brakujący → stderr i kod 1"""
        with tempfile.TemporaryDirectory() as katalog:
            plik = Path(katalog) / "a.txt"
            plik.write_text("ala ma\nkota\n", encoding="utf-8")
            brak = Path(katalog) / "brak.txt"
            kod, wyjscie, bledy = self.uruchom_main([str(plik), str(brak), "-l", "-c"])
        self.assertEqual(kod, 1)
        self.assertEqual(wyjscie, f"2 12 {plik}\n")
        self.assertEqual(bledy, f"licznik: brak pliku {brak}\n")


class TestEnvISubprocess(unittest.TestCase):
    def test_cw4_parsuj_env(self) -> None:
        """cw4: komentarze, export, cudzysłowy i spacje"""
        tekst = '# sekrety\n\nAPI_KEY=abc123\nexport BAZA = "sqlite:///x.db"\nIMIE=\'Ala\'\nPUSTA=\n'
        self.assertEqual(
            cw.parsuj_env(tekst),
            {"API_KEY": "abc123", "BAZA": "sqlite:///x.db", "IMIE": "Ala", "PUSTA": ""},
        )

    def test_cw4_linia_bez_rownosci_to_blad(self) -> None:
        """cw4: linia bez "=" → ValueError"""
        with self.assertRaises(ValueError):
            cw.parsuj_env("OK=1\nZEPSUTA LINIA\n")

    def test_cw5_uruchom_zwraca_stdout(self) -> None:
        """cw5: uruchom zwraca (0, stdout) dla udanego programu"""
        kod, wyjscie = cw.uruchom([sys.executable, "-c", "print('hej')"])
        self.assertEqual(kod, 0)
        self.assertEqual(wyjscie.strip(), "hej")

    def test_cw5_uruchom_przekazuje_kod_bledu(self) -> None:
        """cw5: uruchom zwraca kod wyjścia programu"""
        kod, _ = cw.uruchom([sys.executable, "-c", "import sys; sys.exit(3)"])
        self.assertEqual(kod, 3)


if __name__ == "__main__":
    unittest.main()
