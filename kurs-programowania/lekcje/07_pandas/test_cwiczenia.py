"""Testy lekcji 07. Uruchamiaj przez: python kurs.py sprawdz 07"""

import importlib
import importlib.util
import os
import unittest
from pathlib import Path

MA_PANDAS = importlib.util.find_spec("pandas") is not None
POWOD = "brak pandas — w aktywnym venv: python -m pip install -r requirements.txt"
CSV = Path(__file__).parent / "sprzedaz.csv"

if MA_PANDAS:
    import pandas as pd

    cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


def maly_df() -> "pd.DataFrame":
    return pd.DataFrame(
        {
            "data": pd.to_datetime(["2026-01-05", "2026-01-20", "2026-02-02", "2026-02-10"]),
            "region": ["Północ", "Północ", "Południe", "Północ"],
            "produkt": ["Kawa", "Herbata", "Kawa", "Kawa"],
            "sztuki": [10, 8, 2, 1],
            "cena_zl": [25.0, 15.0, 25.0, 30.0],
        }
    )


@unittest.skipUnless(MA_PANDAS, POWOD)
class TestPandas(unittest.TestCase):
    def test_cw1_wczytaj_z_datami(self) -> None:
        """cw1: 9 wierszy, 5 kolumn, "data" jako datetime"""
        df = cw.wczytaj(CSV)
        self.assertEqual(df.shape, (9, 5))
        self.assertTrue(pd.api.types.is_datetime64_any_dtype(df["data"]))

    def test_cw2_dodaj_przychod_nie_zmienia_wejscia(self) -> None:
        """cw2: kolumna przychod = sztuki * cena, oryginał bez zmian"""
        df = maly_df()
        wynik = cw.dodaj_przychod(df)
        self.assertEqual(wynik["przychod"].tolist(), [250.0, 120.0, 50.0, 30.0])
        self.assertNotIn("przychod", df.columns)

    def test_cw3_filtruj(self) -> None:
        """cw3: region Północ, sztuki >= 5 → dwa wiersze z indeksem 0, 1"""
        wynik = cw.filtruj(maly_df(), "Północ", 5)
        self.assertEqual(wynik["produkt"].tolist(), ["Kawa", "Herbata"])
        self.assertEqual(wynik.index.tolist(), [0, 1])

    def test_cw3_filtruj_bez_wynikow(self) -> None:
        """cw3: brak pasujących → pusty DataFrame z tymi samymi kolumnami"""
        wynik = cw.filtruj(maly_df(), "Zachód", 1)
        self.assertTrue(wynik.empty)
        self.assertEqual(list(wynik.columns), list(maly_df().columns))

    def test_cw4_suma_wg_regionu(self) -> None:
        """cw4: suma przychodu na region, malejąco"""
        df = maly_df().assign(przychod=[250.0, 120.0, 50.0, 30.0])
        wynik = cw.suma_wg_regionu(df)
        self.assertEqual(wynik.to_dict(), {"Północ": 400.0, "Południe": 50.0})
        self.assertEqual(wynik.index.tolist(), ["Północ", "Południe"])

    def test_cw5_uzupelnij_braki(self) -> None:
        """cw5: brak sztuk → 0 (int), brak ceny kawy → mediana ceny kawy (25.0)"""
        df = pd.read_csv(CSV, parse_dates=["data"])
        wynik = cw.uzupelnij_braki(df)
        self.assertEqual(wynik["sztuki"].isna().sum() + wynik["cena_zl"].isna().sum(), 0)
        self.assertTrue(pd.api.types.is_integer_dtype(wynik["sztuki"]))
        self.assertEqual(wynik.loc[3, "sztuki"], 0)
        self.assertEqual(wynik.loc[4, "cena_zl"], 25.0)
        self.assertTrue(df["cena_zl"].isna().any(), "wejście nie powinno się zmienić")

    def test_cw6_tabela_przestawna(self) -> None:
        """cw6: region × produkt, brak sprzedaży = 0"""
        df = maly_df().assign(przychod=[250.0, 120.0, 50.0, 30.0])
        wynik = cw.tabela_przestawna(df)
        self.assertEqual(
            wynik.to_dict(orient="index"),
            {"Południe": {"Herbata": 0, "Kawa": 50.0}, "Północ": {"Herbata": 120.0, "Kawa": 280.0}},
        )

    def test_cw7_sprzedaz_miesieczna(self) -> None:
        """cw7: suma na miesiąc z indeksem "RRRR-MM\""""
        df = maly_df().assign(przychod=[250.0, 120.0, 50.0, 30.0])
        wynik = cw.sprzedaz_miesieczna(df)
        self.assertEqual(wynik.to_dict(), {"2026-01": 370.0, "2026-02": 80.0})
        self.assertEqual(wynik.name, "przychod")
        self.assertEqual(wynik.index.name, "miesiac")


if __name__ == "__main__":
    unittest.main()
