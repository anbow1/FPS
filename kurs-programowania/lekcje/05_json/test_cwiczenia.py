"""Testy lekcji 05. Uruchamiaj przez: python kurs.py sprawdz 05"""

import importlib
import json
import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestJson(unittest.TestCase):
    def test_cw1_wczytuje_poprawny_json(self) -> None:
        """cw1: poprawny JSON → obiekt Pythona"""
        self.assertEqual(cw.wczytaj_json('{"a": [1, null, true]}'), {"a": [1, None, True]})

    def test_cw1_blad_podaje_linie_i_kolumne(self) -> None:
        """cw1: błąd mówi, w której linii i kolumnie"""
        with self.assertRaises(ValueError) as kontekst:
            cw.wczytaj_json('{\n  "a": 1,\n  "b": tak\n}')
        self.assertIn("linia 3", str(kontekst.exception))
        self.assertIn("kolumna 8", str(kontekst.exception))

    def test_cw2_ladny_json_z_polskimi_znakami(self) -> None:
        """cw2: wcięcie 2, posortowane klucze, "Kraków" wprost"""
        self.assertEqual(cw.do_json({"b": 1, "a": "Kraków"}), '{\n  "a": "Kraków",\n  "b": 1\n}')

    def test_cw2_daty_i_zbiory(self) -> None:
        """cw2: daty → ISO, zbiory → posortowane listy"""
        tekst = cw.do_json({"d": date(2026, 9, 27), "t": datetime(2026, 9, 27, 12, 30), "s": {3, 1, 2}})
        self.assertEqual(json.loads(tekst), {"d": "2026-09-27", "t": "2026-09-27T12:30:00", "s": [1, 2, 3]})

    def test_cw2_nieznany_typ_to_typeerror(self) -> None:
        """cw2: obiekt nieznanego typu → TypeError"""
        with self.assertRaises(TypeError):
            cw.do_json({"x": object()})


class TestSciezki(unittest.TestCase):
    DANE = {"uzytkownicy": [{"imie": "Ala", "adres": {"miasto": "Kraków"}}, {"imie": "Olek"}]}

    def test_cw3_pobiera_zagniezdzona_wartosc(self) -> None:
        """cw3: "uzytkownicy.0.adres.miasto" → "Kraków\""""
        self.assertEqual(cw.pobierz(self.DANE, "uzytkownicy.0.adres.miasto"), "Kraków")
        self.assertEqual(cw.pobierz(self.DANE, "uzytkownicy.1.imie"), "Olek")

    def test_cw3_brak_zwraca_domyslna(self) -> None:
        """cw3: brakujący klucz, indeks za zakresem, zły typ → domyślna"""
        self.assertIsNone(cw.pobierz(self.DANE, "uzytkownicy.1.adres.miasto"))
        self.assertEqual(cw.pobierz(self.DANE, "uzytkownicy.5.imie", "?"), "?")
        self.assertEqual(cw.pobierz(self.DANE, "uzytkownicy.x", "?"), "?")
        self.assertEqual(cw.pobierz(self.DANE, "uzytkownicy.0.imie.cos", "?"), "?")

    def test_cw6_splaszcz(self) -> None:
        """cw6: splaszcz zamienia zagnieżdżenia na klucze z kropkami"""
        self.assertEqual(
            cw.splaszcz({"a": {"b": 1, "c": [10, 20]}, "d": None, "e": {}}),
            {"a.b": 1, "a.c.0": 10, "a.c.1": 20, "d": None},
        )


class TestWalidacja(unittest.TestCase):
    SCHEMAT = {"imie": str, "wiek": int, "aktywny": bool}

    def test_cw4_poprawny_obiekt(self) -> None:
        """cw4: poprawny obiekt → brak błędów (dodatkowe pola są OK)"""
        self.assertEqual(cw.waliduj({"imie": "Ala", "wiek": 30, "aktywny": True, "x": 1}, self.SCHEMAT), [])

    def test_cw4_braki_i_zle_typy(self) -> None:
        """cw4: brak pola i zły typ — w kolejności schematu"""
        self.assertEqual(
            cw.waliduj({"wiek": "30", "aktywny": False}, self.SCHEMAT),
            ["brak pola 'imie'", "pole 'wiek' ma typ str, oczekiwano int"],
        )

    def test_cw4_bool_to_nie_int(self) -> None:
        """cw4: True nie przechodzi jako int"""
        self.assertEqual(
            cw.waliduj({"imie": "A", "wiek": True, "aktywny": True}, self.SCHEMAT),
            ["pole 'wiek' ma typ bool, oczekiwano int"],
        )

    def test_cw4_nie_slownik(self) -> None:
        """cw4: lista zamiast obiektu → jeden czytelny błąd"""
        self.assertEqual(cw.waliduj([1, 2], self.SCHEMAT), ["oczekiwano obiektu JSON (dict), jest list"])


class TestJsonLines(unittest.TestCase):
    def test_cw5_zapis_i_odczyt_jsonl(self) -> None:
        """cw5: zapisane rekordy wczytują się z powrotem; jedna linia na rekord"""
        rekordy = [{"id": 1, "tekst": "zażółć"}, {"id": 2, "tekst": "gęślą jaźń"}]
        with tempfile.TemporaryDirectory() as katalog:
            sciezka = Path(katalog) / "dane.jsonl"
            cw.zapisz_jsonl(sciezka, rekordy)
            surowe = sciezka.read_text(encoding="utf-8")
            sciezka.write_text(surowe + "\n\n", encoding="utf-8")  # puste linie na końcu
            self.assertEqual(cw.wczytaj_jsonl(sciezka), rekordy)
        self.assertEqual(surowe.count("\n"), 2)
        self.assertIn("zażółć", surowe)


if __name__ == "__main__":
    unittest.main()
