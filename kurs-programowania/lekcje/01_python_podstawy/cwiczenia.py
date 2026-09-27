# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 01   (albo: python kurs.py obserwuj 01)
"""Lekcja 01 — Podstawy Pythona."""


# Ćwiczenie 1
def powitanie(imie: str) -> str:
    """Zwraca powitanie w formie "Cześć, <imie>!".

    >>> powitanie("Ala")
    'Cześć, Ala!'
    """
    # Podpowiedź: użyj f-stringa
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def suma_parzystych(liczby: list[int]) -> int:
    """Zwraca sumę liczb parzystych z listy. Pusta lista → 0.

    >>> suma_parzystych([1, 2, 3, 4])
    6
    """
    # Podpowiedź: liczba jest parzysta, gdy liczba % 2 == 0
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def policz_litery(tekst: str) -> dict[str, int]:
    """Liczy wystąpienia liter (tylko litery, wielkość liter bez znaczenia).

    >>> policz_litery("Ala ma!")
    {'a': 3, 'l': 1, 'm': 1}
    """
    # Podpowiedź: tekst.lower(), znak.isalpha(), slownik.get(klucz, 0)
    raise NotImplementedError("Do zrobienia")


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
    # Podpowiedź: range(1, n + 1); najpierw sprawdź podzielność przez 15
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def statystyki(liczby: list[float]) -> tuple[float, float, float]:
    """Zwraca krotkę (minimum, maksimum, średnia).

    Pusta lista to błąd: zgłoś ValueError z czytelnym komunikatem.

    >>> statystyki([2, 4, 9])
    (2, 9, 5.0)
    """
    # Podpowiedź: min(), max(), sum() / len(); pusta lista → raise ValueError
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def odwroc_slowa(zdanie: str) -> str:
    """Odwraca kolejność słów; wiele spacji traktuje jak jedną.

    >>> odwroc_slowa("ala  ma kota")
    'kota ma ala'
    """
    # Podpowiedź: zdanie.split() i " ".join(...)
    raise NotImplementedError("Do zrobienia")


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
        # Podpowiedź: zapisz self.wlasciciel, self.saldo_gr = 0, self.historia = []
        raise NotImplementedError("Do zrobienia")

    def wplac(self, kwota_gr: int) -> int:
        raise NotImplementedError("Do zrobienia")

    def wyplac(self, kwota_gr: int) -> int:
        # Podpowiedź: najpierw walidacja, dopiero potem zmiana salda
        raise NotImplementedError("Do zrobienia")
