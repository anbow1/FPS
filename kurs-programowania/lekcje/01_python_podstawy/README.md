# Lekcja 01 — Podstawy Pythona

Cel: po tej lekcji piszesz małe funkcje na typach wbudowanych, pętlach,
warunkach i jednej prostej klasie — i rozumiesz komunikaty błędów.

## Jak pracować z kursem

1. Czytasz teorię (ten plik).
2. Otwierasz `cwiczenia.py` w edytorze (polecam VS Code).
3. W drugim oknie terminala uruchamiasz `python kurs.py obserwuj 01` —
   po każdym zapisie pliku zobaczysz, które testy przechodzą.
4. Zablokowany? `python kurs.py podpowiedz 01`. Na końcu `python kurs.py quiz 01`.

## Teoria

### Wartości i typy

```python
wiek = 30                 # int — liczba całkowita
cena = 19.99              # float — zmiennoprzecinkowa (uwaga: 0.1 + 0.2 != 0.3)
imie = "Ala"              # str — tekst, niezmienny
aktywny = True            # bool — True / False
nic = None                # "brak wartości"

type(wiek)                # <class 'int'>
int("42"), str(42), float("2.5")   # konwersje
```

### f-stringi

```python
imie, punkty = "Ola", 7
print(f"{imie} ma {punkty} pkt, średnio {punkty / 3:.2f}")   # Ola ma 7 pkt, średnio 2.33
```

### Kolekcje

| Typ | Przykład | Zmienny? | Do czego |
|---|---|---|---|
| `list` | `[1, 2, 3]` | tak | uporządkowana sekwencja |
| `tuple` | `(1, 2)` | nie | stała para/krotka, np. współrzędne |
| `dict` | `{"pl": "Polska"}` | tak | klucz → wartość |
| `set` | `{1, 2, 3}` | tak | unikalne elementy, szybkie `in` |

```python
liczby = [3, 1, 2]
liczby.append(5)          # [3, 1, 2, 5]
liczby[0]                 # 3 — indeksy od zera
liczby[-1]                # 5 — od końca
liczby[1:3]               # [1, 2] — wycinek (koniec nie wchodzi)
sorted(liczby)            # nowa, posortowana lista

stolice = {"PL": "Warszawa"}
stolice["DE"] = "Berlin"
stolice.get("FR", "?")    # "?" — bez KeyError
for kod, miasto in stolice.items():
    print(kod, miasto)
```

### Warunki i pętle

```python
if punkty >= 5:
    ocena = "zal"
elif punkty > 0:
    ocena = "prawie"
else:
    ocena = "brak"

for i in range(1, 4):     # 1, 2, 3
    print(i)

while punkty > 0:
    punkty -= 1
```

### Wyrażenia listowe (comprehensions)

```python
kwadraty = [x * x for x in range(5)]                 # [0, 1, 4, 9, 16]
parzyste = [x for x in liczby if x % 2 == 0]
dlugosci = {slowo: len(slowo) for slowo in ["ab", "abc"]}
```

### Funkcje

```python
def pole_prostokata(szerokosc: float, wysokosc: float = 1.0) -> float:
    """Docstring: co robi funkcja. Podpowiedzi typów (: float, -> float) pomagają edytorowi."""
    if szerokosc < 0 or wysokosc < 0:
        raise ValueError(f"wymiary muszą być nieujemne, dostałem {szerokosc}x{wysokosc}")
    return szerokosc * wysokosc
```

`raise` zgłasza błąd (wyjątek). Wywołujący może go złapać:

```python
try:
    pole_prostokata(-1, 2)
except ValueError as blad:
    print("Nie da się:", blad)
```

### Klasy

```python
class Licznik:
    def __init__(self, start: int = 0) -> None:
        self.wartosc = start          # atrybut obiektu

    def zwieksz(self, o: int = 1) -> int:
        self.wartosc += o
        return self.wartosc

licznik = Licznik()
licznik.zwieksz()   # 1
```

### Czytanie błędów

Czytaj traceback **od dołu**: ostatnia linia mówi *co* (np. `KeyError: 'x'`),
linie wyżej — *gdzie*. Najczęstsze: `NameError` (literówka w nazwie),
`TypeError` (zły typ, np. `"a" + 1`), `IndexError`/`KeyError` (brak elementu),
`IndentationError` (wcięcia — zawsze 4 spacje).

## Ćwiczenia

W `cwiczenia.py`:

1. `powitanie(imie)` — f-string.
2. `suma_parzystych(liczby)` — pętla lub comprehension.
3. `policz_litery(tekst)` — słownik liczników, bez rozróżniania wielkości liter.
4. `fizzbuzz(n)` — klasyk: warunki i pętla.
5. `statystyki(liczby)` — min/max/średnia, pusty wejście → `ValueError`.
6. `odwroc_slowa(zdanie)` — `split` i `join`.
7. Klasa `Konto` — wpłaty, wypłaty i walidacja.

## Podpowiedzi

- **cw1**: `return f"Cześć, {imie}!"` — uważaj na przecinek i wykrzyknik.
- **cw2**: `x % 2 == 0` sprawdza parzystość. `sum()` przyjmuje też wyrażenie generatora: `sum(x for x in ...)`.
- **cw3**: `tekst.lower()`, `znak.isalpha()`, a do liczenia `wynik[znak] = wynik.get(znak, 0) + 1`.
- **cw4**: sprawdzaj najpierw podzielność przez 15 (albo przez 3 **i** 5), potem przez 3 i 5.
- **cw5**: `min()`, `max()`, `sum() / len()`. Pusta lista: `if not liczby: raise ValueError(...)`.
- **cw6**: `zdanie.split()` dzieli po białych znakach, `" ".join(reversed(slowa))` skleja.
- **cw7**: w `wyplac` najpierw walidacja (kwota > 0, wystarczające saldo), dopiero potem zmiana `self.saldo`.
