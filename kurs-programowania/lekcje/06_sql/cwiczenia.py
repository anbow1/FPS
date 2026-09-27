# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 06   (albo: python kurs.py obserwuj 06)
"""Lekcja 06 — SQL na SQLite.

Tabele:
  klienci(id INTEGER PRIMARY KEY, imie TEXT NOT NULL, miasto TEXT NOT NULL)
  zamowienia(id INTEGER PRIMARY KEY,
             klient_id INTEGER NOT NULL REFERENCES klienci(id),
             kwota_gr INTEGER NOT NULL CHECK (kwota_gr > 0),
             data TEXT NOT NULL)
"""

import sqlite3


# Ćwiczenie 1
def utworz_schemat(conn: sqlite3.Connection) -> None:
    """Włącza klucze obce i tworzy obie tabele (IF NOT EXISTS — można wołać wielokrotnie)."""
    # Podpowiedź: PRAGMA foreign_keys = ON, potem executescript z dwoma CREATE TABLE
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def dodaj_klienta(conn: sqlite3.Connection, imie: str, miasto: str) -> int:
    """Dodaje klienta i zwraca jego id. Używaj parametrów "?"."""
    # Podpowiedź: kursor.lastrowid
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def dodaj_zamowienie(conn: sqlite3.Connection, klient_id: int, kwota_gr: int, data: str) -> int:
    """Dodaje zamówienie i zwraca jego id.

    Nieistniejący klient albo kwota <= 0 → sqlite3.IntegrityError (pilnuje baza,
    dzięki schematowi z ćw. 1 — nie sprawdzaj tego w Pythonie).
    """
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def klienci_z_miasta(conn: sqlite3.Connection, miasto: str) -> list[str]:
    """Imiona klientów z danego miasta, alfabetycznie."""
    # Podpowiedź: WHERE miasto = ? ORDER BY imie
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def raport_sprzedazy(conn: sqlite3.Connection) -> list[tuple[str, int, int]]:
    """Dla KAŻDEGO klienta: (imie, liczba_zamowien, suma_gr).

    Klient bez zamówień → (imie, 0, 0). Sortuj malejąco po sumie, przy remisie po imieniu.
    """
    # Podpowiedź: LEFT JOIN, COUNT(z.id), COALESCE(SUM(...), 0), GROUP BY k.id
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def usun_klienta(conn: sqlite3.Connection, klient_id: int) -> int:
    """Usuwa klienta razem z jego zamówieniami, w jednej transakcji.

    Zwraca liczbę usuniętych zamówień. Nieistniejący klient → LookupError
    i nic się nie zmienia.
    """
    # Podpowiedź: with conn: ... ; kursor.rowcount
    raise NotImplementedError("Do zrobienia")
