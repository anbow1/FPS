"""Testy lekcji 08. Uruchamiaj przez: python kurs.py sprawdz 08

Żaden test nie łączy się z internetem — sieć udają proste funkcje-atrapy.
"""

import importlib
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


def atrapa_serwera(odpowiedzi: list[Any]) -> tuple[Any, list[int]]:
    """Zwraca funkcję wyslij() oddającą kolejne odpowiedzi (albo rzucającą wyjątki) i licznik wywołań."""
    wywolania: list[int] = []

    def wyslij() -> tuple[int, str]:
        wywolania.append(1)
        odpowiedz = odpowiedzi[len(wywolania) - 1]
        if isinstance(odpowiedz, Exception):
            raise odpowiedz
        return odpowiedz

    return wyslij, wywolania


class TestZapytania(unittest.TestCase):
    def test_cw1_zbuduj_url(self) -> None:
        """cw1: ukośniki, kodowanie polskich znaków, pominięte None"""
        self.assertEqual(
            cw.zbuduj_url("https://api.example.com/v1/", "/szukaj", {"q": "zażółć", "strona": 2, "x": None}),
            "https://api.example.com/v1/szukaj?q=za%C5%BC%C3%B3%C5%82%C4%87&strona=2",
        )

    def test_cw1_bez_parametrow(self) -> None:
        """cw1: bez parametrów — bez znaku zapytania"""
        self.assertEqual(cw.zbuduj_url("https://a.pl", "b"), "https://a.pl/b")
        self.assertEqual(cw.zbuduj_url("https://a.pl", "b", {"x": None}), "https://a.pl/b")

    def test_cw2_naglowki(self) -> None:
        """cw2: Authorization tylko z tokenem"""
        self.assertEqual(
            cw.naglowki("abc"),
            {"Accept": "application/json", "User-Agent": "kurs-programowania/1.0", "Authorization": "Bearer abc"},
        )
        self.assertNotIn("Authorization", cw.naglowki(None))
        self.assertNotIn("Authorization", cw.naglowki(""))


class TestOdpowiedzi(unittest.TestCase):
    def test_cw3_sukces(self) -> None:
        """cw3: 200 → JSON, 204 → None"""
        self.assertEqual(cw.obsluz_odpowiedz(200, '{"id": 7}'), {"id": 7})
        self.assertIsNone(cw.obsluz_odpowiedz(204, ""))

    def test_cw3_blad_klienta_z_polem_error(self) -> None:
        """cw3: 404 → BladKlienta z komunikatem z pola "error\""""
        with self.assertRaises(cw.BladKlienta) as kontekst:
            cw.obsluz_odpowiedz(404, '{"error": "nie ma takiego klienta"}')
        self.assertEqual(kontekst.exception.status, 404)
        self.assertIn("nie ma takiego klienta", str(kontekst.exception))

    def test_cw3_blad_serwera_z_tekstem(self) -> None:
        """cw3: 503 z tekstem (nie JSON) → BladSerwera"""
        with self.assertRaises(cw.BladSerwera) as kontekst:
            cw.obsluz_odpowiedz(503, "Service Unavailable")
        self.assertIn("Service Unavailable", str(kontekst.exception))

    def test_cw4_czy_ponowic(self) -> None:
        """cw4: 429 i 5xx tak; 200, 400, 404 nie"""
        for status in (429, 500, 502, 503, 504):
            self.assertTrue(cw.czy_ponowic(status), status)
        for status in (200, 400, 401, 404):
            self.assertFalse(cw.czy_ponowic(status), status)

    def test_cw4_opoznienie_rosnie_do_limitu(self) -> None:
        """cw4: 0.5, 1, 2, 4, 8, 8…"""
        self.assertEqual([cw.opoznienie(p) for p in range(6)], [0.5, 1.0, 2.0, 4.0, 8.0, 8.0])


class TestPonowienia(unittest.TestCase):
    def test_cw5_ponawia_po_bledach_i_zwraca_wynik(self) -> None:
        """cw5: 503, ConnectionError, 200 → wynik; śpi 0.5 s i 1 s"""
        wyslij, wywolania = atrapa_serwera([(503, ""), ConnectionError("zerwane"), (200, '{"ok": true}')])
        drzemki: list[float] = []
        self.assertEqual(cw.pobierz_z_ponowieniami(wyslij, 5, drzemki.append), {"ok": True})
        self.assertEqual(len(wywolania), 3)
        self.assertEqual(drzemki, [0.5, 1.0])

    def test_cw5_nie_ponawia_bledu_klienta(self) -> None:
        """cw5: 400 → od razu BladKlienta, bez spania"""
        wyslij, wywolania = atrapa_serwera([(400, '{"error": "zły format"}')])
        drzemki: list[float] = []
        with self.assertRaises(cw.BladKlienta):
            cw.pobierz_z_ponowieniami(wyslij, 5, drzemki.append)
        self.assertEqual((len(wywolania), drzemki), (1, []))

    def test_cw5_konczy_po_max_probach(self) -> None:
        """cw5: 3× 503 przy max_prob=3 → BladSerwera, 2 drzemki"""
        wyslij, wywolania = atrapa_serwera([(503, "")] * 3)
        drzemki: list[float] = []
        with self.assertRaises(cw.BladSerwera):
            cw.pobierz_z_ponowieniami(wyslij, 3, drzemki.append)
        self.assertEqual((len(wywolania), drzemki), (3, [0.5, 1.0]))

    def test_cw5_ostatni_connection_error_leci_dalej(self) -> None:
        """cw5: same ConnectionError → ConnectionError po ostatniej próbie"""
        wyslij, _ = atrapa_serwera([ConnectionError("a"), ConnectionError("b")])
        with self.assertRaises(ConnectionError):
            cw.pobierz_z_ponowieniami(wyslij, 2, lambda _sekundy: None)

    def test_cw5_zla_liczba_prob(self) -> None:
        """cw5: max_prob=0 → ValueError"""
        with self.assertRaises(ValueError):
            cw.pobierz_z_ponowieniami(lambda: (200, "{}"), 0, lambda _sekundy: None)


class TestPaginacja(unittest.TestCase):
    def test_cw6_zbiera_wszystkie_strony(self) -> None:
        """cw6: trzy strony po kursorach → wszystkie dane po kolei"""
        strony = {None: ([1, 2], "b"), "b": ([3], "c"), "c": ([4, 5], None)}
        zapytania: list[Any] = []

        def pobierz_strone(kursor: str | None) -> dict[str, Any]:
            zapytania.append(kursor)
            dane, nastepna = strony[kursor]
            return {"dane": dane, "nastepna": nastepna}

        self.assertEqual(cw.pobierz_wszystkie_strony(pobierz_strone), [1, 2, 3, 4, 5])
        self.assertEqual(zapytania, [None, "b", "c"])

    def test_cw6_zapetlone_api(self) -> None:
        """cw6: API zawsze zwraca następną stronę → RuntimeError zamiast wiecznej pętli"""
        with oczekuj_runtime_error():
            cw.pobierz_wszystkie_strony(lambda _kursor: {"dane": [], "nastepna": "znowu"})


if __name__ == "__main__":
    unittest.main()
