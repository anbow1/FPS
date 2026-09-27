# Lekcja 06 — SQL (na przykładzie SQLite)

Cel: projektujesz proste tabele, piszesz zapytania z JOIN i GROUP BY,
używasz transakcji i **zawsze** parametrów zamiast sklejania tekstu.

## Teoria

### Relacyjna baza danych

Dane w **tabelach** (wiersze × kolumny). Każdy wiersz ma **klucz główny**
(`PRIMARY KEY`). Tabele łączymy **kluczami obcymi** (`FOREIGN KEY`).

```
klienci                      zamowienia
+----+-------+---------+     +----+-----------+----------+------------+
| id | imie  | miasto  |     | id | klient_id | kwota_gr | data       |
+----+-------+---------+     +----+-----------+----------+------------+
|  1 | Ala   | Kraków  | <-- |  1 |         1 |     5000 | 2026-09-01 |
|  2 | Olek  | Gdańsk  |     |  2 |         1 |     2500 | 2026-09-03 |
+----+-------+---------+     +----+-----------+----------+------------+
```

SQLite to cała baza w jednym pliku, wbudowana w Pythona (`import sqlite3`).
Te same zapytania zadziałają (z drobnymi różnicami) w PostgreSQL czy MySQL.

### Tworzenie tabel

```sql
CREATE TABLE IF NOT EXISTS klienci (
    id     INTEGER PRIMARY KEY,           -- w SQLite: automatycznie numerowany
    imie   TEXT NOT NULL,
    miasto TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS zamowienia (
    id        INTEGER PRIMARY KEY,
    klient_id INTEGER NOT NULL REFERENCES klienci(id),
    kwota_gr  INTEGER NOT NULL CHECK (kwota_gr > 0),   -- pieniądze w groszach, nie float!
    data      TEXT NOT NULL                             -- ISO: 2026-09-27
);
```

### Podstawowe zapytania (CRUD)

```sql
INSERT INTO klienci (imie, miasto) VALUES ('Ala', 'Kraków');
SELECT imie, miasto FROM klienci WHERE miasto = 'Kraków' ORDER BY imie LIMIT 10;
UPDATE klienci SET miasto = 'Wrocław' WHERE id = 2;
DELETE FROM zamowienia WHERE kwota_gr < 100;
```

`UPDATE`/`DELETE` bez `WHERE` zmieniają **całą tabelę**. Najpierw zrób
`SELECT` z tym samym `WHERE` i sprawdź, co trafisz.

### JOIN — łączenie tabel

```sql
-- INNER JOIN: tylko klienci, którzy mają zamówienia
SELECT k.imie, z.kwota_gr
FROM klienci AS k
JOIN zamowienia AS z ON z.klient_id = k.id;

-- LEFT JOIN: wszyscy klienci; brak zamówień → kolumny z NULL
SELECT k.imie, z.kwota_gr
FROM klienci AS k
LEFT JOIN zamowienia AS z ON z.klient_id = k.id;
```

### Agregacje: GROUP BY

```sql
SELECT k.imie,
       COUNT(z.id)               AS liczba,     -- COUNT(kolumna) nie liczy NULL-i
       COALESCE(SUM(z.kwota_gr), 0) AS suma      -- SUM z samych NULL-i to NULL
FROM klienci AS k
LEFT JOIN zamowienia AS z ON z.klient_id = k.id
GROUP BY k.id
HAVING suma > 1000                               -- filtr PO grupowaniu (WHERE — przed)
ORDER BY suma DESC, k.imie;
```

`NULL` to „nieznane”: `NULL = NULL` nie jest prawdą — pisz `IS NULL`.

### Python: sqlite3

```python
import sqlite3

conn = sqlite3.connect("sklep.db")        # albo ":memory:" — baza w RAM
conn.execute("PRAGMA foreign_keys = ON")  # SQLite domyślnie NIE pilnuje kluczy obcych!

kursor = conn.execute("INSERT INTO klienci (imie, miasto) VALUES (?, ?)", ("Ala", "Kraków"))
nowe_id = kursor.lastrowid
conn.commit()

for imie, miasto in conn.execute("SELECT imie, miasto FROM klienci"):
    print(imie, miasto)

wiersz = conn.execute("SELECT COUNT(*) FROM klienci").fetchone()   # (1,)
```

### SQL injection — najważniejsza zasada lekcji

```python
imie = "x' OR '1'='1"
conn.execute(f"SELECT * FROM klienci WHERE imie = '{imie}'")   # ŹLE: zwróci WSZYSTKICH
conn.execute("SELECT * FROM klienci WHERE imie = ?", (imie,))    # DOBRZE: szuka dosłownie
```

Wartości **zawsze** przez `?` (parametry). Sklejanie tekstu = luka.

### Transakcje

Kilka zmian, które muszą się udać razem albo wcale (np. przelew):

```python
with conn:                     # commit na końcu bloku, rollback przy wyjątku
    conn.execute("UPDATE konta SET saldo = saldo - ? WHERE id = ?", (100, 1))
    conn.execute("UPDATE konta SET saldo = saldo + ? WHERE id = ?", (100, 2))
```

### Indeksy

`CREATE INDEX idx_zam_klient ON zamowienia(klient_id);` — przyspiesza
wyszukiwanie i JOIN po tej kolumnie, kosztem wolniejszych zapisów.

### Konsola SQLite

```bash
sqlite3 sklep.db
sqlite> .tables
sqlite> .schema klienci
sqlite> SELECT * FROM klienci;
sqlite> .quit
```

## Ćwiczenia

1. `utworz_schemat(conn)` — dwie tabele z ograniczeniami + klucze obce włączone.
2. `dodaj_klienta(...)` — parametry `?`, zwróć nowe id.
3. `dodaj_zamowienie(...)` — to samo; zły klient lub kwota → błąd bazy.
4. `klienci_z_miasta(conn, miasto)` — odporne na SQL injection.
5. `raport_sprzedazy(conn)` — LEFT JOIN + GROUP BY.
6. `usun_klienta(conn, klient_id)` — transakcja: zamówienia i klient razem.

## Podpowiedzi

- **cw1**: `conn.execute("PRAGMA foreign_keys = ON")`, potem `conn.executescript("""CREATE TABLE ...; CREATE TABLE ...;""")`. Skopiuj schemat z teorii.
- **cw2/cw3**: `kursor = conn.execute("INSERT ... VALUES (?, ?)", (a, b))`, `conn.commit()`, `return kursor.lastrowid`.
- **cw4**: `[wiersz[0] for wiersz in conn.execute("SELECT imie FROM klienci WHERE miasto = ? ORDER BY imie", (miasto,))]`.
- **cw5**: zapytanie z sekcji „Agregacje” bez `HAVING`. Wynik: `conn.execute(...).fetchall()` daje listę krotek.
- **cw6**: `with conn:` — w środku najpierw sprawdź, czy klient istnieje (`fetchone()` zwraca `None`, gdy nie), potem `DELETE FROM zamowienia ...`, `DELETE FROM klienci ...`. Liczbę usuniętych wierszy daje `kursor.rowcount`.
