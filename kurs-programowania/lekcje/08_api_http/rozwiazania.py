# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: urllib.parse.urlencode
    url = baza.rstrip("/") + "/" + sciezka.lstrip("/")
    niepuste = {klucz: wartosc for klucz, wartosc in (parametry or {}).items() if wartosc is not None}
    if niepuste:
        url += "?" + urllib.parse.urlencode(niepuste)
    return url
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def naglowki(token: str | None) -> dict[str, str]:
    """Nagłówki zapytania JSON:

    - "Accept": "application/json"
    - "User-Agent": "kurs-programowania/1.0"
    - "Authorization": "Bearer <token>" — tylko gdy token podano (niepusty).
    """
    # ROZWIĄZANIE-START
    wynik = {"Accept": "application/json", "User-Agent": "kurs-programowania/1.0"}
    if token:
        wynik["Authorization"] = f"Bearer {token}"
    return wynik
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: najpierw 204, potem zakresy statusów
    if status == 204:
        return None
    if 200 <= status < 300:
        return json.loads(tekst)
    if 400 <= status < 500:
        raise BladKlienta(status, _komunikat_bledu(tekst))
    if 500 <= status < 600:
        raise BladSerwera(status, _komunikat_bledu(tekst))
    raise ValueError(f"nieobsługiwany status HTTP {status}")


def _komunikat_bledu(tekst: str) -> str:
    try:
        dane = json.loads(tekst)
    except json.JSONDecodeError:
        return tekst
    if isinstance(dane, dict) and "error" in dane:
        return str(dane["error"])
    return tekst
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def czy_ponowic(status: int) -> bool:
    """Czy warto ponowić zapytanie po takim statusie? (STATUSY_DO_PONOWIENIA)"""
    # ROZWIĄZANIE-START
    return status in STATUSY_DO_PONOWIENIA
    # ROZWIĄZANIE-KONIEC


def opoznienie(proba: int, baza_sekundy: float = 0.5, maks_sekundy: float = 8.0) -> float:
    """Opóźnienie przed ponowieniem po próbie numer `proba` (od 0): baza * 2**proba, najwyżej maks.

    >>> [opoznienie(p) for p in range(6)]
    [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]
    """
    # ROZWIĄZANIE-START
    return min(maks_sekundy, baza_sekundy * 2**proba)
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: for proba in range(max_prob): ...
    if max_prob < 1:
        raise ValueError(f"max_prob musi być >= 1, dostałem {max_prob}")
    for proba in range(max_prob):
        ostatnia = proba == max_prob - 1
        try:
            status, tekst = wyslij()
        except ConnectionError:
            if ostatnia:
                raise
            spij(opoznienie(proba))
            continue
        if czy_ponowic(status) and not ostatnia:
            spij(opoznienie(proba))
            continue
        return obsluz_odpowiedz(status, tekst)
    raise AssertionError("pętla zawsze kończy się return albo raise")
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def pobierz_wszystkie_strony(pobierz_strone: Callable[[str | None], dict[str, Any]]) -> list[Any]:
    """Zbiera dane ze wszystkich stron.

    pobierz_strone(kursor) zwraca {"dane": [...], "nastepna": kursor albo None}.
    Pierwsze wywołanie z kursorem None. Więcej niż MAKS_STRON stron → RuntimeError.
    """
    # ROZWIĄZANIE-START: while True + licznik stron
    wyniki: list[Any] = []
    kursor: str | None = None
    for _ in range(MAKS_STRON):
        strona = pobierz_strone(kursor)
        wyniki.extend(strona["dane"])
        kursor = strona["nastepna"]
        if kursor is None:
            return wyniki
    raise RuntimeError(f"przekroczono {MAKS_STRON} stron — czy API nie zapętla kursora?")
    # ROZWIĄZANIE-KONIEC
