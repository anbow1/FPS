# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
"""Lekcja 07 — pandas. Dane: sprzedaz.csv (data, region, produkt, sztuki, cena_zl)."""

from pathlib import Path

import pandas as pd


# Ćwiczenie 1
def wczytaj(sciezka: Path) -> pd.DataFrame:
    """Wczytuje CSV; kolumna "data" ma być typu datetime."""
    # ROZWIĄZANIE-START: pd.read_csv(..., parse_dates=[...])
    return pd.read_csv(sciezka, parse_dates=["data"])
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def dodaj_przychod(df: pd.DataFrame) -> pd.DataFrame:
    """Zwraca NOWY DataFrame z kolumną "przychod" = sztuki * cena_zl. Wejście bez zmian."""
    # ROZWIĄZANIE-START: df.assign(...)
    return df.assign(przychod=df["sztuki"] * df["cena_zl"])
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def filtruj(df: pd.DataFrame, region: str, min_sztuk: int) -> pd.DataFrame:
    """Wiersze z danego regionu, gdzie sztuki >= min_sztuk. Indeks od nowa (0, 1, 2…)."""
    # ROZWIĄZANIE-START: maska z & i nawiasami, potem reset_index(drop=True)
    maska = (df["region"] == region) & (df["sztuki"] >= min_sztuk)
    return df[maska].reset_index(drop=True)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def suma_wg_regionu(df: pd.DataFrame) -> pd.Series:
    """Suma kolumny "przychod" w każdym regionie, od największej."""
    # ROZWIĄZANIE-START: groupby("region")["przychod"].sum().sort_values(...)
    return df.groupby("region")["przychod"].sum().sort_values(ascending=False)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def uzupelnij_braki(df: pd.DataFrame) -> pd.DataFrame:
    """Zwraca kopię z uzupełnionymi brakami:

    - brak "sztuki" → 0, a kolumna ma typ int,
    - brak "cena_zl" → mediana ceny tego samego produktu.
    Wejście bez zmian.
    """
    # ROZWIĄZANIE-START: df.copy(), fillna(0).astype(int), groupby(...).transform("median")
    wynik = df.copy()
    wynik["sztuki"] = wynik["sztuki"].fillna(0).astype(int)
    mediana_produktu = wynik.groupby("produkt")["cena_zl"].transform("median")
    wynik["cena_zl"] = wynik["cena_zl"].fillna(mediana_produktu)
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def tabela_przestawna(df: pd.DataFrame) -> pd.DataFrame:
    """Suma "przychod": wiersze = region, kolumny = produkt, braki = 0."""
    # ROZWIĄZANIE-START: pd.pivot_table(...)
    return pd.pivot_table(df, index="region", columns="produkt", values="przychod", aggfunc="sum", fill_value=0)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 7
def sprzedaz_miesieczna(df: pd.DataFrame) -> pd.Series:
    """Suma "przychod" na miesiąc. Indeks: napisy "RRRR-MM" o nazwie "miesiac",
    Series o nazwie "przychod", miesiące rosnąco."""
    # ROZWIĄZANIE-START: groupby(df["data"].dt.to_period("M").astype(str))
    miesiac = df["data"].dt.to_period("M").astype(str)
    return df.groupby(miesiac)["przychod"].sum().rename("przychod").rename_axis("miesiac")
    # ROZWIĄZANIE-KONIEC
