# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 07   (albo: python kurs.py obserwuj 07)
"""Lekcja 07 — pandas. Dane: sprzedaz.csv (data, region, produkt, sztuki, cena_zl)."""

from pathlib import Path

import pandas as pd


# Ćwiczenie 1
def wczytaj(sciezka: Path) -> pd.DataFrame:
    """Wczytuje CSV; kolumna "data" ma być typu datetime."""
    # Podpowiedź: pd.read_csv(..., parse_dates=[...])
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def dodaj_przychod(df: pd.DataFrame) -> pd.DataFrame:
    """Zwraca NOWY DataFrame z kolumną "przychod" = sztuki * cena_zl. Wejście bez zmian."""
    # Podpowiedź: df.assign(...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def filtruj(df: pd.DataFrame, region: str, min_sztuk: int) -> pd.DataFrame:
    """Wiersze z danego regionu, gdzie sztuki >= min_sztuk. Indeks od nowa (0, 1, 2…)."""
    # Podpowiedź: maska z & i nawiasami, potem reset_index(drop=True)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def suma_wg_regionu(df: pd.DataFrame) -> pd.Series:
    """Suma kolumny "przychod" w każdym regionie, od największej."""
    # Podpowiedź: groupby("region")["przychod"].sum().sort_values(...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def uzupelnij_braki(df: pd.DataFrame) -> pd.DataFrame:
    """Zwraca kopię z uzupełnionymi brakami:

    - brak "sztuki" → 0, a kolumna ma typ int,
    - brak "cena_zl" → mediana ceny tego samego produktu.
    Wejście bez zmian.
    """
    # Podpowiedź: df.copy(), fillna(0).astype(int), groupby(...).transform("median")
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def tabela_przestawna(df: pd.DataFrame) -> pd.DataFrame:
    """Suma "przychod": wiersze = region, kolumny = produkt, braki = 0."""
    # Podpowiedź: pd.pivot_table(...)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 7
def sprzedaz_miesieczna(df: pd.DataFrame) -> pd.Series:
    """Suma "przychod" na miesiąc. Indeks: napisy "RRRR-MM" o nazwie "miesiac",
    Series o nazwie "przychod", miesiące rosnąco."""
    # Podpowiedź: groupby(df["data"].dt.to_period("M").astype(str))
    raise NotImplementedError("Do zrobienia")
