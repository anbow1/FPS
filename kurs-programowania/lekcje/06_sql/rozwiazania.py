# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: PRAGMA foreign_keys = ON, potem executescript z dwoma CREATE TABLE
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS klienci (
            id     INTEGER PRIMARY KEY,
            imie   TEXT NOT NULL,
            miasto TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS zamowienia (
            id        INTEGER PRIMARY KEY,
            klient_id INTEGER NOT NULL REFERENCES klienci(id),
            kwota_gr  INTEGER NOT NULL CHECK (kwota_gr > 0),
            data      TEXT NOT NULL
        );
        """
    )
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def dodaj_klienta(conn: sqlite3.Connection, imie: str, miasto: str) -> int:
    """Dodaje klienta i zwraca jego id. Używaj parametrów "?"."""
    # ROZWIĄZANIE-START: kursor.lastrowid
    kursor = conn.execute("INSERT INTO klienci (imie, miasto) VALUES (?, ?)", (imie, miasto))
    conn.commit()
    return kursor.lastrowid or 0
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def dodaj_zamowienie(conn: sqlite3.Connection, klient_id: int, kwota_gr: int, data: str) -> int:
    """Dodaje zamówienie i zwraca jego id.

    Nieistniejący klient albo kwota <= 0 → sqlite3.IntegrityError (pilnuje baza,
    dzięki schematowi z ćw. 1 — nie sprawdzaj tego w Pythonie).
    """
    # ROZWIĄZANIE-START
    kursor = conn.execute(
        "INSERT INTO zamowienia (klient_id, kwota_gr, data) VALUES (?, ?, ?)", (klient_id, kwota_gr, data)
    )
    conn.commit()
    return kursor.lastrowid or 0
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def klienci_z_miasta(conn: sqlite3.Connection, miasto: str) -> list[str]:
    """Imiona klientów z danego miasta, alfabetycznie."""
    # ROZWIĄZANIE-START: WHERE miasto = ? ORDER BY imie
    wiersze = conn.execute("SELECT imie FROM klienci WHERE miasto = ? ORDER BY imie", (miasto,))
    return [imie for (imie,) in wiersze]
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def raport_sprzedazy(conn: sqlite3.Connection) -> list[tuple[str, int, int]]:
    """Dla KAŻDEGO klienta: (imie, liczba_zamowien, suma_gr).

    Klient bez zamówień → (imie, 0, 0). Sortuj malejąco po sumie, przy remisie po imieniu.
    """
    # ROZWIĄZANIE-START: LEFT JOIN, COUNT(z.id), COALESCE(SUM(...), 0), GROUP BY k.id
    zapytanie = """
        SELECT k.imie,
               COUNT(z.id) AS liczba,
               COALESCE(SUM(z.kwota_gr), 0) AS suma
        FROM klienci AS k
        LEFT JOIN zamowienia AS z ON z.klient_id = k.id
        GROUP BY k.id
        ORDER BY suma DESC, k.imie
    """
    return conn.execute(zapytanie).fetchall()
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def usun_klienta(conn: sqlite3.Connection, klient_id: int) -> int:
    """Usuwa klienta razem z jego zamówieniami, w jednej transakcji.

    Zwraca liczbę usuniętych zamówień. Nieistniejący klient → LookupError
    i nic się nie zmienia.
    """
    # ROZWIĄZANIE-START: with conn: ... ; kursor.rowcount
    with conn:
        istnieje = conn.execute("SELECT 1 FROM klienci WHERE id = ?", (klient_id,)).fetchone()
        if istnieje is None:
            raise LookupError(f"nie ma klienta o id {klient_id}")
        usuniete = conn.execute("DELETE FROM zamowienia WHERE klient_id = ?", (klient_id,)).rowcount
        conn.execute("DELETE FROM klienci WHERE id = ?", (klient_id,))
    return usuniete
    # ROZWIĄZANIE-KONIEC
