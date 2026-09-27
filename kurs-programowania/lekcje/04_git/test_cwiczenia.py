"""Testy lekcji 04. Uruchamiaj przez: python kurs.py sprawdz 04"""

import importlib
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestStatusILog(unittest.TestCase):
    def test_cw1_parsuj_status(self) -> None:
        """cw1: rozróżnia poczekalnię, zmiany i pliki nowe"""
        porcelain = "M  kurs.py\n M README.md\nMM oba.py\nA  nowy.py\n D stary.py\nR  a.py -> b.py\n?? notatki.txt\n"
        self.assertEqual(
            cw.parsuj_status(porcelain),
            {
                "w_poczekalni": ["kurs.py", "oba.py", "nowy.py", "b.py"],
                "zmienione": ["README.md", "oba.py", "stary.py"],
                "nowe": ["notatki.txt"],
            },
        )

    def test_cw1_czyste_repo(self) -> None:
        """cw1: czyste repo → puste listy"""
        self.assertEqual(cw.parsuj_status(""), {"w_poczekalni": [], "zmienione": [], "nowe": []})

    def test_cw3_parsuj_log(self) -> None:
        """cw3: parsuj_log zwraca pary (hash, opis)"""
        tekst = "3f2a9c1 feat: start\n\nab12cd3 fix(api): ponów po 429\n"
        self.assertEqual(
            cw.parsuj_log(tekst), [("3f2a9c1", "feat: start"), ("ab12cd3", "fix(api): ponów po 429")]
        )


class TestCommity(unittest.TestCase):
    def test_cw2_poprawne_wiadomosci(self) -> None:
        """cw2: typowe poprawne wiadomości przechodzą"""
        for wiadomosc in (
            "feat: dodaj licznik",
            "fix(api): ponawiaj po 429",
            "feat!: usuń stare API",
            "docs: README\n\nDłuższe wyjaśnienie dlaczego.",
        ):
            self.assertTrue(cw.czy_poprawny_commit(wiadomosc), wiadomosc)

    def test_cw2_niepoprawne_wiadomosci(self) -> None:
        """cw2: zły typ, brak spacji, pusty opis, za długi tytuł, brak pustej linii"""
        for wiadomosc in (
            "",
            "poprawki",
            "feature: coś",
            "fix:bez spacji",
            "fix: ",
            "fix(API): wielkie litery w zakresie",
            "feat: " + "x" * 80,
            "fix: tytuł\ntreść bez pustej linii",
        ):
            self.assertFalse(cw.czy_poprawny_commit(wiadomosc), wiadomosc)

    def test_cw4_nazwa_galezi(self) -> None:
        """cw4: polskie znaki, interpunkcja i wielkie litery"""
        self.assertEqual(cw.nazwa_galezi("Dodaj logowanie przez Google!"), "feature/dodaj-logowanie-przez-google")
        self.assertEqual(cw.nazwa_galezi("  Popraw błąd źle liczonej ŁĄCZNEJ sumy  ", "fix"),
                         "fix/popraw-blad-zle-liczonej-lacznej-sumy")

    def test_cw4_pusty_opis_to_blad(self) -> None:
        """cw4: opis bez liter → ValueError"""
        with self.assertRaises(ValueError):
            cw.nazwa_galezi("!!!")


class TestKonflikty(unittest.TestCase):
    TEKST = (
        "tytul = 'Kurs'\n"
        "<<<<<<< HEAD\n"
        "kolor = 'niebieski'\n"
        "=======\n"
        "kolor = 'zielony'\n"
        ">>>>>>> feature/kolory\n"
        "rozmiar = 12\n"
    )

    def test_cw5_nasza_wersja(self) -> None:
        """cw5: "nasza" zostawia część nad ======="""
        self.assertEqual(cw.rozwiaz_konflikt(self.TEKST, "nasza"), "tytul = 'Kurs'\nkolor = 'niebieski'\nrozmiar = 12\n")

    def test_cw5_ich_i_obie(self) -> None:
        """cw5: "ich" i "obie\""""
        self.assertEqual(cw.rozwiaz_konflikt(self.TEKST, "ich"), "tytul = 'Kurs'\nkolor = 'zielony'\nrozmiar = 12\n")
        self.assertEqual(
            cw.rozwiaz_konflikt(self.TEKST, "obie"),
            "tytul = 'Kurs'\nkolor = 'niebieski'\nkolor = 'zielony'\nrozmiar = 12\n",
        )

    def test_cw5_zla_strona_to_blad(self) -> None:
        """cw5: nieznana strona → ValueError"""
        with self.assertRaises(ValueError):
            cw.rozwiaz_konflikt(self.TEKST, "moja")


@unittest.skipUnless(shutil.which("git"), "git nie jest zainstalowany — zainstaluj go z git-scm.com")
class TestPrawdziweRepo(unittest.TestCase):
    def test_cw6_utworz_repo_zwraca_hash_commita(self) -> None:
        """cw6: utworz_repo robi init + commit i zwraca hash HEAD"""
        # Na Windows pliki w .git bywają tylko do odczytu i sprzątanie potrafi się nie udać.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tymczasowy:
            katalog = Path(tymczasowy)
            hash_commita = cw.utworz_repo(katalog)
            self.assertRegex(hash_commita, r"^[0-9a-f]{40}$")
            log = subprocess.run(
                ["git", "log", "--format=%H %s"], cwd=katalog, capture_output=True, text=True, check=True
            ).stdout
            self.assertEqual(log.strip(), f"{hash_commita} feat: pierwszy commit")
            self.assertTrue(re.match(r"# Projekt", (katalog / "README.md").read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
