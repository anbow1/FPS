# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 08   (albo: python kurs.py obserwuj 08)
"""Lekcja 08 — HTTP i REST API (bez prawdziwej sieci: wysyłanie podajemy jako funkcję)."""

import json
import urllib.parse
from collections.abc import Callable
from typing import Any

STATUSY_DO_PONOWIENIA = {429, 500, 502, 503, 504}
# Bezpiecznik: API z błędem mogłoby w kółko zwracać tę samą "następną" stronę.
MAKS_STRON = 1000


class BladKlienta(Exception):
    """Błąd 4xx — problem z naszym zapytaniem."""

    def __init__(self, status: int, komunikat: str) -> None:
        super().__init__(f"HTTP {status}: {komunikat}")
        self.status = status


class BladSerwera(Exception):
    """Błąd 5xx — problem po stronie serwera."""

    def __init__(self, status: int, komunikat: str) -> None:
        super().__init__(f"HTTP {status}: {komunikat}")
        self.status = status


# Ćwiczenie 1
def zbuduj_url(baza: str, sciezka: str, parametry: dict[str, Any] | None = None) -> str:
    """Skleja adres z parametrami zapytania. Parametry o wartości None pomija.

    >>> zbuduj_url("https://api.example.com/v1/", "/szukaj", {"q": "zażółć", "strona": 2, "x": None})
    'https://api.example.com/v1/szukaj?q=za%C5%BC%C3%B3%C5%82%C4%87&strona=2'
    """
    # Podpowiedź: urllib.parse.urlencode
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def naglowki(token: str | None) -> dict[str, str]:
    """Nagłówki zapytania JSON:

    - "Accept": "application/json"
    - "User-Agent": "kurs-programowania/1.0"
    - "Authorization": "Bearer <token>" — tylko gdy token podano (niepusty).
    """
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def obsluz_odpowiedz(status: int, tekst: str) -> Any:
    """Zamienia odpowiedź na wynik albo wyjątek.

    - 204 → None
    - 2xx → sparsowany JSON
    - 4xx → BladKlienta(status, komunikat)
    - 5xx → BladSerwera(status, komunikat)
    - inne (1xx, 3xx) → ValueError
    Komunikat: pole "error" z body JSON, jeśli istnieje; inaczej surowy tekst.
    """
    # Podpowiedź: najpierw 204, potem zakresy statusów
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def czy_ponowic(status: int) -> bool:
    """Czy warto ponowić zapytanie po takim statusie? (STATUSY_DO_PONOWIENIA)"""
    raise NotImplementedError("Do zrobienia")


def opoznienie(proba: int, baza_sekundy: float = 0.5, maks_sekundy: float = 8.0) -> float:
    """Opóźnienie przed ponowieniem po próbie numer `proba` (od 0): baza * 2**proba, najwyżej maks.

    >>> [opoznienie(p) for p in range(6)]
    [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]
    """
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def pobierz_z_ponowieniami(
    wyslij: Callable[[], tuple[int, str]],
    max_prob: int,
    spij: Callable[[float], None],
) -> Any:
    """Wysyła zapytanie najwyżej `max_prob` razy.

    - wyslij() zwraca (status, tekst) albo rzuca ConnectionError,
    - po statusie do ponowienia lub ConnectionError: spij(opoznienie(proba)) i kolejna próba,
    - po ostatniej próbie NIE śpimy: zwracamy obsluz_odpowiedz(...) (czyli np. BladSerwera)
      albo rzucamy ostatni ConnectionError,
    - status nie do ponowienia → od razu obsluz_odpowiedz(...).
    max_prob < 1 → ValueError.
    """
    # Podpowiedź: for proba in range(max_prob): ...
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def pobierz_wszystkie_strony(pobierz_strone: Callable[[str | None], dict[str, Any]]) -> list[Any]:
    """Zbiera dane ze wszystkich stron.

    pobierz_strone(kursor) zwraca {"dane": [...], "nastepna": kursor albo None}.
    Pierwsze wywołanie z kursorem None. Więcej niż MAKS_STRON stron → RuntimeError.
    """
    # Podpowiedź: while True + licznik stron
    raise NotImplementedError("Do zrobienia")
