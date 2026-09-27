"""Testy lekcji 16. Uruchamiaj przez: python kurs.py sprawdz 16"""

import importlib
import os
import unittest
from pathlib import Path
from typing import Any

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))

ZESTAW = (Path(__file__).parent / "zestaw.jsonl").read_text(encoding="utf-8")


class TestZestawu(unittest.TestCase):
    def test_cw1_wczytuje_zestaw_z_lekcji(self) -> None:
        """cw1: 10 przypadków z zestaw.jsonl, pola zachowane"""
        przypadki = cw.wczytaj_zestaw(ZESTAW)
        self.assertEqual(len(przypadki), 10)
        self.assertEqual(przypadki[0]["id"], "dostawa-kurier")
        self.assertEqual(przypadki[0]["typ"], "liczba")

    def test_cw1_domyslne_tagi_i_puste_linie(self) -> None:
        """cw1: brak tagów → []; puste linie pominięte"""
        przypadki = cw.wczytaj_zestaw('\n{"id": "a", "wejscie": "x", "oczekiwane": 1}\n\n')
        self.assertEqual(przypadki, [{"id": "a", "wejscie": "x", "oczekiwane": 1, "tagi": []}])

    def test_cw1_bledy(self) -> None:
        """cw1: brak pola (z numerem linii) i powtórzone id → ValueError"""
        with self.assertRaises(ValueError) as kontekst:
            cw.wczytaj_zestaw('{"id": "a", "wejscie": "x", "oczekiwane": 1}\n{"id": "b", "oczekiwane": 2}')
        self.assertIn("linia 2", str(kontekst.exception))
        with self.assertRaises(ValueError):
            cw.wczytaj_zestaw('{"id": "a", "wejscie": "x", "oczekiwane": 1}\n{"id": "a", "wejscie": "y", "oczekiwane": 2}')


class TestOceniaczy(unittest.TestCase):
    def test_cw2_normalizuj_i_dokladna(self) -> None:
        """cw2: wielkość liter, interpunkcja i spacje nie mają znaczenia"""
        self.assertEqual(cw.normalizuj("  Nie   wiem!  "), "nie wiem")
        self.assertTrue(cw.ocena_dokladna("Nie wiem.", "nie wiem"))
        self.assertFalse(cw.ocena_dokladna("Canberra", "nie wiem"))

    def test_cw2_liczbowa(self) -> None:
        """cw2: liczby w tekście, zapis polski i angielski, tolerancja, brak liczby"""
        self.assertTrue(cw.ocena_liczbowa("Dostawa kurierem kosztuje 15 zł.", 15))
        self.assertTrue(cw.ocena_liczbowa("Razem 1 234,56 zł", 1234.56))
        self.assertTrue(cw.ocena_liczbowa("Total: 1234.56", 1234.56))
        self.assertTrue(cw.ocena_liczbowa("Saldo: -3", -3))
        self.assertFalse(cw.ocena_liczbowa("Kosztuje 16 zł", 15))
        self.assertTrue(cw.ocena_liczbowa("Kosztuje 15,4 zł", 15, tolerancja=0.5))
        self.assertFalse(cw.ocena_liczbowa("Nie wiem", 15))

    def test_cw2_zawiera(self) -> None:
        """cw2: frazy jako całe słowa; zakazane frazy oblewają"""
        self.assertTrue(cw.ocena_zawiera("Nie, nie wysyłamy za granicę.", ["nie"], ["tak, wysyłamy"]))
        self.assertFalse(cw.ocena_zawiera("Niestety wysyłamy tylko w Polsce", ["nie"], []))
        self.assertFalse(cw.ocena_zawiera("Tak, wysyłamy! A może nie?", ["nie"], ["tak, wysyłamy"]))


class TestSedziego(unittest.TestCase):
    def test_cw3_prompt_sedziego(self) -> None:
        """cw3: dokładny układ promptu; brak kryteriów → ValueError"""
        oczekiwany = (
            "Oceń odpowiedź asystenta według kryteriów.\n\n"
            "Pytanie: Ile kosztuje kurier?\nOdpowiedź: 15 zł.\n\n"
            "Kryteria:\n- podaje poprawną cenę\n- jest uprzejma\n\n"
            'Zwróć wyłącznie JSON: {"ocena": <liczba 1-5>, "uzasadnienie": "<jedno zdanie>"}'
        )
        self.assertEqual(cw.prompt_sedziego("Ile kosztuje kurier?", "15 zł.", ["podaje poprawną cenę", "jest uprzejma"]),
                         oczekiwany)
        with self.assertRaises(ValueError):
            cw.prompt_sedziego("?", "!", [])

    def test_cw3_werdykt_w_tekscie_i_bloku_kodu(self) -> None:
        """cw3: JSON otoczony tekstem albo ```json"""
        self.assertEqual(cw.parsuj_werdykt('Moja ocena: {"ocena": 4, "uzasadnienie": "Poprawna cena."} Koniec.'),
                         {"ocena": 4, "uzasadnienie": "Poprawna cena."})
        self.assertEqual(cw.parsuj_werdykt('```json\n{"uzasadnienie": "ok", "ocena": 5}\n```')["ocena"], 5)

    def test_cw3_zle_werdykty(self) -> None:
        """cw3: brak JSON, zły JSON, ocena 7, ocena true, brak uzasadnienia → ValueError"""
        for tekst in ("Daję piątkę!", '{"ocena": 5,', '{"ocena": 7, "uzasadnienie": "x"}',
                      '{"ocena": true, "uzasadnienie": "x"}', '{"ocena": 3}'):
            with self.assertRaises(ValueError, msg=tekst):
                cw.parsuj_werdykt(tekst)


def oceniacz_dokladny(odpowiedz: str, przypadek: dict[str, Any]) -> bool:
    return odpowiedz == przypadek["oczekiwane"]


PRZYPADKI = [
    {"id": "a", "wejscie": "1+1", "oczekiwane": "2", "tagi": ["dodawanie"]},
    {"id": "b", "wejscie": "2+2", "oczekiwane": "4", "tagi": ["dodawanie"]},
    {"id": "c", "wejscie": "3*3", "oczekiwane": "9", "tagi": ["mnozenie"]},
    {"id": "d", "wejscie": "boom", "oczekiwane": "?", "tagi": []},
]


def model_v1(wejscie: str) -> str:
    if wejscie == "boom":
        raise TimeoutError("model nie odpowiedział")
    return {"1+1": "2", "2+2": "5", "3*3": "9"}[wejscie]


def model_v2(wejscie: str) -> str:
    return {"1+1": "2", "2+2": "4", "3*3": "6", "boom": "?"}[wejscie]


class TestEvala(unittest.TestCase):
    def test_cw4_raport(self) -> None:
        """cw4: wyniki po kolei, ułamek zaliczonych, wyniki wg tagów, wyjątek modelu nie przerywa"""
        raport = cw.uruchom_eval(model_v1, PRZYPADKI, oceniacz_dokladny)
        self.assertEqual([w["zaliczony"] for w in raport["wyniki"]], [True, False, True, False])
        self.assertEqual(raport["wyniki"][3]["odpowiedz"], "BŁĄD: model nie odpowiedział")
        self.assertEqual(raport["wynik"], 0.5)
        self.assertEqual(raport["wg_tagow"], {"dodawanie": 0.5, "mnozenie": 1.0})

    def test_cw4_pusty_zestaw(self) -> None:
        """cw4: pusty zestaw → wynik 0.0, bez dzielenia przez zero"""
        self.assertEqual(cw.uruchom_eval(model_v1, [], oceniacz_dokladny), {"wyniki": [], "wynik": 0.0, "wg_tagow": {}})

    def test_cw5_porownaj(self) -> None:
        """cw5: regresja c, poprawy b i d"""
        przed = cw.uruchom_eval(model_v1, PRZYPADKI, oceniacz_dokladny)
        po = cw.uruchom_eval(model_v2, PRZYPADKI, oceniacz_dokladny)
        self.assertEqual(cw.porownaj(przed, po), {"regresje": ["c"], "poprawy": ["b", "d"]})
        with self.assertRaises(ValueError):
            cw.porownaj(przed, cw.uruchom_eval(model_v2, PRZYPADKI[:2], oceniacz_dokladny))

    def test_cw6_przedzial_wilsona_znane_wartosci(self) -> None:
        """cw6: 8/10 → (0.490, 0.943); 0/10 → (0, 0.278); 10/10 → (0.722, 1)"""
        for (sukcesy, proby), (dolny, gorny) in {(8, 10): (0.490, 0.943), (0, 10): (0.0, 0.278),
                                                  (10, 10): (0.722, 1.0)}.items():
            wynik = cw.przedzial_wilsona(sukcesy, proby)
            self.assertAlmostEqual(wynik[0], dolny, places=3)
            self.assertAlmostEqual(wynik[1], gorny, places=3)

    def test_cw6_zle_dane(self) -> None:
        """cw6: 0 prób albo więcej sukcesów niż prób → ValueError"""
        for sukcesy, proby in ((0, 0), (5, 3), (-1, 3)):
            with self.assertRaises(ValueError):
                cw.przedzial_wilsona(sukcesy, proby)


if __name__ == "__main__":
    unittest.main()
