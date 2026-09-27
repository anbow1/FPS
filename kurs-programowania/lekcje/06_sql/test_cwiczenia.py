"""Testy lekcji 06. Uruchamiaj przez: python kurs.py sprawdz 06"""

import importlib
import os
import sqlite3
import unittest

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


class TestSql(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = sqlite3.connect(":memory:")
        cw.utworz_schemat(self.conn)

    def tearDown(self) -> None:
        self.conn.close()

    def wypelnij(self) -> dict[str, int]:
        ala = cw.dodaj_klienta(self.conn, "Ala", "Kraków")
        olek = cw.dodaj_klienta(self.conn, "Olek", "Gdańsk")
        ewa = cw.dodaj_klienta(self.conn, "Ewa", "Kraków")
        cw.dodaj_klienta(self.conn, "Bartek", "Poznań")
        cw.dodaj_zamowienie(self.conn, ala, 5000, "2026-09-01")
        cw.dodaj_zamowienie(self.conn, ala, 2500, "2026-09-03")
        cw.dodaj_zamowienie(self.conn, olek, 7500, "2026-09-02")
        cw.dodaj_zamowienie(self.conn, ewa, 100, "2026-09-05")
        return {"ala": ala, "olek": olek, "ewa": ewa}

    def test_cw1_tworzy_tabele_i_mozna_wolac_dwa_razy(self) -> None:
        """cw1: obie tabele istnieją; drugi raz utworz_schemat nie wybucha"""
        cw.utworz_schemat(self.conn)
        tabele = {nazwa for (nazwa,) in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"klienci", "zamowienia"} <= tabele)

    def test_cw1_klucze_obce_wlaczone(self) -> None:
        """cw1: PRAGMA foreign_keys jest włączone"""
        self.assertEqual(self.conn.execute("PRAGMA foreign_keys").fetchone(), (1,))

    def test_cw2_dodaj_klienta_zwraca_kolejne_id(self) -> None:
        """cw2: dodaj_klienta zwraca id nowego wiersza"""
        pierwszy = cw.dodaj_klienta(self.conn, "Ala", "Kraków")
        drugi = cw.dodaj_klienta(self.conn, "Olek", "Gdańsk")
        self.assertEqual(drugi, pierwszy + 1)
        self.assertEqual(self.conn.execute("SELECT imie FROM klienci WHERE id = ?", (drugi,)).fetchone(), ("Olek",))

    def test_cw3_baza_pilnuje_poprawnosci_zamowien(self) -> None:
        """cw3: nieistniejący klient albo kwota 0 → IntegrityError"""
        ala = cw.dodaj_klienta(self.conn, "Ala", "Kraków")
        self.assertGreater(cw.dodaj_zamowienie(self.conn, ala, 100, "2026-09-01"), 0)
        with self.assertRaises(sqlite3.IntegrityError):
            cw.dodaj_zamowienie(self.conn, 999, 100, "2026-09-01")
        with self.assertRaises(sqlite3.IntegrityError):
            cw.dodaj_zamowienie(self.conn, ala, 0, "2026-09-01")

    def test_cw4_klienci_z_miasta(self) -> None:
        """cw4: imiona z miasta, alfabetycznie"""
        self.wypelnij()
        self.assertEqual(cw.klienci_z_miasta(self.conn, "Kraków"), ["Ala", "Ewa"])
        self.assertEqual(cw.klienci_z_miasta(self.conn, "Łódź"), [])

    def test_cw4_odporne_na_sql_injection(self) -> None:
        """cw4: "x' OR '1'='1" nie zwraca wszystkich klientów"""
        self.wypelnij()
        self.assertEqual(cw.klienci_z_miasta(self.conn, "x' OR '1'='1"), [])

    def test_cw5_raport_sprzedazy(self) -> None:
        """cw5: raport z klientem bez zamówień i remisem rozstrzygniętym imieniem"""
        self.wypelnij()
        self.assertEqual(
            cw.raport_sprzedazy(self.conn),
            [("Ala", 2, 7500), ("Olek", 1, 7500), ("Ewa", 1, 100), ("Bartek", 0, 0)],
        )

    def test_cw6_usun_klienta_z_zamowieniami(self) -> None:
        """cw6: usuwa klienta i jego zamówienia, zwraca ich liczbę"""
        ids = self.wypelnij()
        self.assertEqual(cw.usun_klienta(self.conn, ids["ala"]), 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM zamowienia").fetchone(), (2,))
        self.assertEqual(cw.klienci_z_miasta(self.conn, "Kraków"), ["Ewa"])

    def test_cw6_nieistniejacy_klient(self) -> None:
        """cw6: nieistniejący klient → LookupError, nic się nie zmienia"""
        self.wypelnij()
        with self.assertRaises(LookupError):
            cw.usun_klienta(self.conn, 999)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM zamowienia").fetchone(), (4,))


if __name__ == "__main__":
    unittest.main()
