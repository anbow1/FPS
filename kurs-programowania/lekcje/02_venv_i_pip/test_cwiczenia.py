"""Testy lekcji 02. Uruchamiaj przez: python kurs.py sprawdz 02"""

import importlib
import os
import sys
import unittest

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestVenv(unittest.TestCase):
    def test_cw1_rozne_prefiksy_to_venv(self) -> None:
        """cw1: różne prefix i base_prefix → jesteśmy w venv"""
        self.assertTrue(cw.czy_w_venv("C:/proj/.venv", "C:/Python312"))
        self.assertFalse(cw.czy_w_venv("/usr", "/usr"))

    def test_cw1_zgadza_sie_z_biezacym_pythonem(self) -> None:
        """cw1: wynik dla bieżącego interpretera zgadza się z sys"""
        self.assertEqual(cw.czy_w_venv(sys.prefix, sys.base_prefix), sys.prefix != sys.base_prefix)

    def test_cw2_sciezka_windows(self) -> None:
        """cw2: Windows → .venv\\Scripts\\python.exe"""
        self.assertEqual(cw.sciezka_pythona(".venv", "windows"), ".venv\\Scripts\\python.exe")

    def test_cw2_sciezka_linux_i_macos(self) -> None:
        """cw2: Linux/macOS → .venv/bin/python"""
        self.assertEqual(cw.sciezka_pythona(".venv", "linux"), ".venv/bin/python")
        self.assertEqual(cw.sciezka_pythona("env", "macos"), "env/bin/python")

    def test_cw2_nieznany_system_to_blad(self) -> None:
        """cw2: nieznany system → ValueError"""
        with self.assertRaises(ValueError):
            cw.sciezka_pythona(".venv", "amiga")

    def test_cw3_komendy_aktywacji(self) -> None:
        """cw3: komendy aktywacji dla PowerShell, cmd i bash"""
        self.assertEqual(cw.komenda_aktywacji("powershell"), ".venv\\Scripts\\Activate.ps1")
        self.assertEqual(cw.komenda_aktywacji("cmd"), ".venv\\Scripts\\activate.bat")
        self.assertEqual(cw.komenda_aktywacji("bash"), "source .venv/bin/activate")
        with self.assertRaises(ValueError):
            cw.komenda_aktywacji("fish-and-chips")

    def test_cw4_normalizacja_nazw(self) -> None:
        """cw4: Scikit_Learn, scikit.learn, scikit--learn → scikit-learn"""
        for nazwa in ("Scikit_Learn", "scikit.learn", "scikit--learn", "SCIKIT-LEARN"):
            self.assertEqual(cw.normalizuj_nazwe(nazwa), "scikit-learn")


class TestRequirements(unittest.TestCase):
    PLIK = """
# zależności kursu
pandas >= 2.0, <3      # dane
requests[socks]==2.32.3
Typing_Extensions
tomli; python_version < "3.11"
-r requirements-dev.txt

"""

    def test_cw5_parsuje_typowy_plik(self) -> None:
        """cw5: komentarze, extras, znaczniki i opcje są obsłużone"""
        self.assertEqual(
            cw.parsuj_requirements(self.PLIK),
            {"pandas": ">=2.0,<3", "requests": "==2.32.3", "typing-extensions": "", "tomli": ""},
        )

    def test_cw5_pusty_plik(self) -> None:
        """cw5: pusty plik → pusty słownik"""
        self.assertEqual(cw.parsuj_requirements(""), {})

    def test_cw6_porownanie_liczbowe_nie_tekstowe(self) -> None:
        """cw6: 1.10.0 > 1.9.2 (porównanie liczbowe)"""
        self.assertEqual(cw.porownaj_wersje("1.10.0", "1.9.2"), 1)
        self.assertEqual(cw.porownaj_wersje("1.9.2", "1.10.0"), -1)

    def test_cw6_brakujace_segmenty_to_zera(self) -> None:
        """cw6: 1.0 == 1.0.0"""
        self.assertEqual(cw.porownaj_wersje("1.0", "1.0.0"), 0)
        self.assertEqual(cw.porownaj_wersje("2", "2.0.1"), -1)

    def test_cw7_zakres_wersji(self) -> None:
        """cw7: ">=2.0,<3" przepuszcza 2.x, a nie 1.x ani 3.x"""
        self.assertTrue(cw.spelnia_warunek("2.5.1", ">=2.0,<3"))
        self.assertFalse(cw.spelnia_warunek("3.0", ">=2.0,<3"))
        self.assertFalse(cw.spelnia_warunek("1.9", ">=2.0,<3"))

    def test_cw7_pozostale_operatory(self) -> None:
        """cw7: ==, != i pusty warunek"""
        self.assertTrue(cw.spelnia_warunek("1.4", "==1.4.0"))
        self.assertFalse(cw.spelnia_warunek("1.2", "!=1.2"))
        self.assertTrue(cw.spelnia_warunek("0.1", ""))

    def test_cw7_nieznany_operator_to_blad(self) -> None:
        """cw7: "~2.0" → ValueError"""
        with self.assertRaises(ValueError):
            cw.spelnia_warunek("2.0", "~2.0")


if __name__ == "__main__":
    unittest.main()
