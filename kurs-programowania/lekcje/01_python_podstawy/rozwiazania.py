# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
"""Lekcja 01 — Podstawy Pythona."""


# Ćwiczenie 1
def powitanie(imie: str) -> str:
    """Zwraca powitanie w formie "Cześć, <imie>!".

    >>> powitanie("Ala")
    'Cześć, Ala!'
    """
    # ROZWIĄZANIE-START: użyj f-stringa
    return f"Cześć, {imie}!"
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def suma_parzystych(liczby: list[int]) -> int:
    """Zwraca sumę liczb parzystych z listy. Pusta lista → 0.

    >>> suma_parzystych([1, 2, 3, 4])
    6
    """
    # ROZWIĄZANIE-START: liczba jest parzysta, gdy liczba % 2 == 0
    return sum(liczba for liczba in liczby if liczba % 2 == 0)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def policz_litery(tekst: str) -> dict[str, int]:
    """Liczy wystąpienia liter (tylko litery, wielkość liter bez znaczenia).

    >>> policz_litery("Ala ma!")
    {'a': 3, 'l': 1, 'm': 1}
    """
    # ROZWIĄZANIE-START: tekst.lower(), znak.isalpha(), slownik.get(klucz, 0)
    wynik: dict[str, int] = {}
    for znak in tekst.lower():
        if znak.isalpha():
            wynik[znak] = wynik.get(znak, 0) + 1
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def fizzbuzz(n: int) -> list[str]:
    """Zwraca listę napisów dla liczb 1..n:

    - podzielna przez 3 i 5 → "FizzBuzz"
    - tylko przez 3 → "Fizz"
    - tylko przez 5 → "Buzz"
    - w pozostałych przypadkach sama liczba jako tekst, np. "7"

    >>> fizzbuzz(5)
    ['1', '2', 'Fizz', '4', 'Buzz']
    """
    # ROZWIĄZANIE-START: range(1, n + 1); najpierw sprawdź podzielność przez 15
    wynik = []
    for liczba in range(1, n + 1):
        if liczba % 15 == 0:
            wynik.append("FizzBuzz")
        elif liczba % 3 == 0:
            wynik.append("Fizz")
        elif liczba % 5 == 0:
            wynik.append("Buzz")
        else:
            wynik.append(str(liczba))
    return wynik
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def statystyki(liczby: list[float]) -> tuple[float, float, float]:
    """Zwraca krotkę (minimum, maksimum, średnia).

    Pusta lista to błąd: zgłoś ValueError z czytelnym komunikatem.

    >>> statystyki([2, 4, 9])
    (2, 9, 5.0)
    """
    # ROZWIĄZANIE-START: min(), max(), sum() / len(); pusta lista → raise ValueError
    if not liczby:
        raise ValueError("statystyki wymagają co najmniej jednej liczby, dostałem pustą listę")
    return min(liczby), max(liczby), sum(liczby) / len(liczby)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def odwroc_slowa(zdanie: str) -> str:
    """Odwraca kolejność słów; wiele spacji traktuje jak jedną.

    >>> odwroc_slowa("ala  ma kota")
    'kota ma ala'
    """
    # ROZWIĄZANIE-START: zdanie.split() i " ".join(...)
    return " ".join(reversed(zdanie.split()))
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 7
class Konto:
    """Konto bankowe z saldem w groszach (int — bez błędów zaokrągleń floatów).

    - Konto(wlasciciel) tworzy konto z saldem 0.
    - wplac(kwota_gr): kwota musi być > 0, inaczej ValueError. Zwraca nowe saldo.
    - wyplac(kwota_gr): kwota > 0 i nie większa niż saldo, inaczej ValueError.
      Po błędzie saldo się NIE zmienia. Zwraca nowe saldo.
    - historia: lista operacji, np. [("wplata", 500), ("wyplata", 200)].
    """

    def __init__(self, wlasciciel: str) -> None:
        # ROZWIĄZANIE-START: zapisz self.wlasciciel, self.saldo_gr = 0, self.historia = []
        self.wlasciciel = wlasciciel
        self.saldo_gr = 0
        self.historia: list[tuple[str, int]] = []
        # ROZWIĄZANIE-KONIEC

    def wplac(self, kwota_gr: int) -> int:
        # ROZWIĄZANIE-START
        if kwota_gr <= 0:
            raise ValueError(f"kwota wpłaty musi być dodatnia, dostałem {kwota_gr}")
        self.saldo_gr += kwota_gr
        self.historia.append(("wplata", kwota_gr))
        return self.saldo_gr
        # ROZWIĄZANIE-KONIEC

    def wyplac(self, kwota_gr: int) -> int:
        # ROZWIĄZANIE-START: najpierw walidacja, dopiero potem zmiana salda
        if kwota_gr <= 0:
            raise ValueError(f"kwota wypłaty musi być dodatnia, dostałem {kwota_gr}")
        if kwota_gr > self.saldo_gr:
            raise ValueError(f"brak środków: saldo {self.saldo_gr} gr, wypłata {kwota_gr} gr")
        self.saldo_gr -= kwota_gr
        self.historia.append(("wyplata", kwota_gr))
        return self.saldo_gr
        # ROZWIĄZANIE-KONIEC
