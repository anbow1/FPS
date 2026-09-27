"""Testy silnika kursu. Z katalogu kursu: python -m unittest discover -s testy_kursu -t ."""

import json
import tempfile
import textwrap
import unittest
from pathlib import Path

from silnik import postep, quiz
from silnik.generator import oczekiwane_cwiczenia, wygeneruj_cwiczenia
from silnik.lekcje import Lekcja, sekcja_readme, wszystkie_lekcje, znajdz_lekcje
from silnik.sprawdzanie import BLAD, DO_ZROBIENIA, OK, POMINIETY, sprawdz_lekcje

LICZBA_LEKCJI = 14


class TestStrukturyKursu(unittest.TestCase):
    def test_lekcje_sa_ponumerowane_po_kolei_i_kompletne(self) -> None:
        lekcje = wszystkie_lekcje()
        self.assertEqual([lekcja.numer for lekcja in lekcje], list(range(1, LICZBA_LEKCJI + 1)))
        for lekcja in lekcje:
            for plik in (lekcja.readme, lekcja.cwiczenia, lekcja.rozwiazania, lekcja.quiz,
                         lekcja.katalog / "test_cwiczenia.py"):
                self.assertTrue(plik.exists(), f"brak {plik}")

    def test_kazde_readme_ma_tytul_cwiczenia_i_podpowiedzi(self) -> None:
        for lekcja in wszystkie_lekcje():
            self.assertTrue(lekcja.tytul.startswith(f"Lekcja {lekcja.kod} — "), lekcja.tytul)
            self.assertTrue(sekcja_readme(lekcja, "Ćwiczenia"), lekcja.katalog.name)
            self.assertTrue(sekcja_readme(lekcja, "Podpowiedzi"), lekcja.katalog.name)

    def test_kazdy_quiz_jest_poprawny(self) -> None:
        for lekcja in wszystkie_lekcje():
            pytania = quiz.wczytaj_pytania(lekcja.quiz)
            self.assertGreaterEqual(len(pytania), 4, lekcja.katalog.name)

    def test_cwiczenia_sa_aktualne_wzgledem_rozwiazan(self) -> None:
        for lekcja in wszystkie_lekcje():
            self.assertEqual(
                lekcja.cwiczenia.read_text(encoding="utf-8"), oczekiwane_cwiczenia(lekcja),
                f"{lekcja.katalog.name}: uruchom python -m silnik.generator",
            )


class TestSprawdzaniaWszystkichLekcji(unittest.TestCase):
    def test_rozwiazania_przechodza_wszystkie_testy(self) -> None:
        for lekcja in wszystkie_lekcje():
            wynik = sprawdz_lekcje(lekcja, "rozwiazania")
            niezaliczone = [(test.nazwa, test.komunikat) for test in wynik.testy if test.status not in (OK, POMINIETY)]
            self.assertEqual(niezaliczone, [], lekcja.katalog.name)

    def test_nieruszone_cwiczenia_sa_tylko_do_zrobienia(self) -> None:
        # Żaden test nie może przejść ani wybuchnąć na szkielecie — uczeń ma zobaczyć "…", nie ✔ czy ✘.
        for lekcja in wszystkie_lekcje():
            wynik = sprawdz_lekcje(lekcja, "cwiczenia")
            inne = [(test.nazwa, test.status) for test in wynik.testy if test.status not in (DO_ZROBIENIA, POMINIETY)]
            self.assertEqual(inne, [], lekcja.katalog.name)


class TestWyszukiwaniaLekcji(unittest.TestCase):
    def test_po_numerze_i_fragmencie_nazwy(self) -> None:
        self.assertEqual(znajdz_lekcje("3").numer, 3)
        self.assertEqual(znajdz_lekcje("03").numer, 3)
        self.assertEqual(znajdz_lekcje("sql").slug, "sql")
        self.assertEqual(znajdz_lekcje(" MCP ").numer, 13)

    def test_nieznana_lekcja_podaje_dostepne(self) -> None:
        with self.assertRaises(LookupError) as kontekst:
            znajdz_lekcje("999")
        self.assertIn("01 (python_podstawy)", str(kontekst.exception))


class TestGeneratora(unittest.TestCase):
    def test_blok_rozwiazania_zamienia_sie_w_raise_z_podpowiedzia(self) -> None:
        rozwiazanie = textwrap.dedent('''\
            # ROZWIĄZANIA: nagłówek tylko dla rozwiązań
            def f(x):
                """Opis."""
                # ROZWIĄZANIE-START: użyj mnożenia
                return x * 2
                # ROZWIĄZANIE-KONIEC
            ''')
        wynik = wygeneruj_cwiczenia(rozwiazanie, "07")
        self.assertIn("python kurs.py sprawdz 07", wynik)
        self.assertNotIn("nagłówek tylko dla rozwiązań", wynik)
        self.assertNotIn("x * 2", wynik)
        self.assertIn('    # Podpowiedź: użyj mnożenia\n    raise NotImplementedError("Do zrobienia")\n', wynik)

    def test_niezamkniety_blok_to_blad(self) -> None:
        with self.assertRaises(ValueError):
            wygeneruj_cwiczenia("# ROZWIĄZANIE-START\nx = 1\n", "01")
        with self.assertRaises(ValueError):
            wygeneruj_cwiczenia("# ROZWIĄZANIE-KONIEC\n", "01")


class TestSprawdzaniaStatusow(unittest.TestCase):
    """Sztuczna lekcja z każdym rodzajem wyniku."""

    def test_statusy_i_miejsce_bledu(self) -> None:
        with tempfile.TemporaryDirectory() as tymczasowy:
            katalog = Path(tymczasowy) / "99_proba"
            katalog.mkdir()
            (katalog / "cwiczenia.py").write_text(textwrap.dedent("""\
                def dobra():
                    return 1

                def zla():
                    return 2

                def niezrobiona():
                    raise NotImplementedError("Do zrobienia")

                def wybuchowa():
                    return {}["brak"]
                """), encoding="utf-8")
            (katalog / "test_cwiczenia.py").write_text(textwrap.dedent('''\
                import importlib, os, unittest
                cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))

                class T(unittest.TestCase):
                    def test_a(self):
                        """a: dobra"""
                        self.assertEqual(cw.dobra(), 1)
                    def test_b(self):
                        self.assertEqual(cw.zla(), 1)
                    def test_c(self):
                        cw.niezrobiona()
                    def test_d(self):
                        cw.wybuchowa()
                    @unittest.skip("brak narzędzia")
                    def test_e(self):
                        pass
                '''), encoding="utf-8")
            wynik = sprawdz_lekcje(Lekcja(99, "proba", katalog))
        statusy = {test.nazwa: test.status for test in wynik.testy}
        self.assertEqual(statusy, {"test_a": OK, "test_b": BLAD, "test_c": DO_ZROBIENIA, "test_d": BLAD, "test_e": POMINIETY})
        opisy = {test.nazwa: test for test in wynik.testy}
        self.assertEqual(opisy["test_a"].opis, "a: dobra")
        self.assertIn("2 != 1", opisy["test_b"].komunikat)
        self.assertIn("KeyError", opisy["test_d"].komunikat)
        self.assertIn("cwiczenia.py:11", opisy["test_d"].komunikat)
        self.assertFalse(wynik.zaliczona)


class TestQuizuIPostepu(unittest.TestCase):
    def test_quiz_liczy_dobre_i_ponawia_zle_wpisane(self) -> None:
        pytania = [
            {"pytanie": "1+1?", "odpowiedzi": ["1", "2"], "poprawna": 1, "wyjasnienie": "."},
            {"pytanie": "2+2?", "odpowiedzi": ["4", "5", "6"], "poprawna": 0, "wyjasnienie": "."},
        ]
        wpisy = iter(["b", "", "ab", "z", "C"])
        bez_tasowania = quiz.przeprowadz(
            pytania, zapytaj=lambda _tekst: next(wpisy), pokaz=lambda _tekst: None, tasuj=lambda _kolejnosc: None
        )
        self.assertEqual(bez_tasowania, 1)

    def test_quiz_po_tasowaniu_sprawdza_przestawiona_odpowiedz(self) -> None:
        pytania = [{"pytanie": "1+1?", "odpowiedzi": ["1", "2", "3"], "poprawna": 1, "wyjasnienie": "."}]
        # Odwrócona kolejność: a) 3, b) 2, c) 1 — poprawna "2" nadal pod b.
        odwroc = list.reverse
        self.assertEqual(quiz.przeprowadz(pytania, lambda _t: "b", lambda _t: None, tasuj=odwroc), 1)
        # Przesunięcie: a) 2, b) 3, c) 1 — poprawna teraz pod a.
        def przesun(kolejnosc: list[int]) -> None:
            kolejnosc.append(kolejnosc.pop(0))
        self.assertEqual(quiz.przeprowadz(pytania, lambda _t: "a", lambda _t: None, tasuj=przesun), 1)
        self.assertEqual(quiz.przeprowadz(pytania, lambda _t: "b", lambda _t: None, tasuj=przesun), 0)

    def test_zly_quiz_jest_wykrywany(self) -> None:
        with tempfile.TemporaryDirectory() as tymczasowy:
            plik = Path(tymczasowy) / "quiz.json"
            plik.write_text(json.dumps([{"pytanie": "?", "odpowiedzi": ["a"], "poprawna": 3, "wyjasnienie": ""}]),
                            encoding="utf-8")
            with self.assertRaises(ValueError):
                quiz.wczytaj_pytania(plik)

    def test_postep_zapisuje_lekcje_i_najlepszy_quiz(self) -> None:
        with tempfile.TemporaryDirectory() as tymczasowy:
            plik = Path(tymczasowy) / ".postep.json"
            self.assertEqual(postep.wczytaj(plik), {"lekcje": {}, "quizy": {}})
            postep.zapisz_lekcje("01", 3, 3, plik)
            postep.zapisz_lekcje("02", 1, 5, plik)
            postep.zapisz_quiz("01", 4, 4, plik)
            postep.zapisz_quiz("01", 2, 4, plik)
            dane = postep.wczytaj(plik)
        self.assertTrue(dane["lekcje"]["01"]["zaliczona"])
        self.assertFalse(dane["lekcje"]["02"]["zaliczona"])
        self.assertEqual(dane["quizy"]["01"], {"najlepszy": 4, "pytania": 4})

    def test_uszkodzony_plik_postepu(self) -> None:
        with tempfile.TemporaryDirectory() as tymczasowy:
            plik = Path(tymczasowy) / ".postep.json"
            plik.write_text("{zepsuty", encoding="utf-8")
            with self.assertRaises(ValueError):
                postep.wczytaj(plik)


if __name__ == "__main__":
    unittest.main()
