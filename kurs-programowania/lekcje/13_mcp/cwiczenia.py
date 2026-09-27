# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 13   (albo: python kurs.py obserwuj 13)
"""Lekcja 13 — serwer MCP na czystym JSON-RPC (transport stdio).

Uruchomienie jako serwer (zwykle robi to klient, np. Claude Code):
    python cwiczenia.py
Rozmowa demonstracyjna:
    python klient_demo.py
"""

import json
import sys
from collections.abc import Callable
from typing import Any

NAZWA_SERWERA = "kurs-mcp"
WERSJA_SERWERA = "1.0.0"
# Od najnowszej. Serwer odsyła wersję klienta, jeśli ją zna, a inaczej pierwszą z listy.
OBSLUGIWANE_WERSJE = ("2025-11-25", "2025-06-18", "2025-03-26")

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class BladProtokolu(Exception):
    """Błąd, który zamieniamy na odpowiedź JSON-RPC z polem "error"."""

    def __init__(self, kod: int, komunikat: str) -> None:
        super().__init__(komunikat)
        self.kod = kod
        self.komunikat = komunikat


def dodaj(a: float, b: float) -> float:
    return a + b


def licz_slowa(tekst: str) -> dict[str, int]:
    return {"slowa": len(tekst.split()), "znaki": len(tekst)}


NARZEDZIA: dict[str, tuple[dict[str, Any], Callable[..., Any]]] = {
    "dodaj": (
        {
            "name": "dodaj",
            "description": "Dodaje dwie liczby.",
            "inputSchema": {
                "type": "object",
                "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                "required": ["a", "b"],
            },
        },
        dodaj,
    ),
    "licz_slowa": (
        {
            "name": "licz_slowa",
            "description": "Liczy słowa i znaki w tekście.",
            "inputSchema": {
                "type": "object",
                "properties": {"tekst": {"type": "string"}},
                "required": ["tekst"],
            },
        },
        licz_slowa,
    ),
}


# Ćwiczenie 1
def odpowiedz_ok(identyfikator: Any, wynik: dict[str, Any]) -> dict[str, Any]:
    """{"jsonrpc": "2.0", "id": identyfikator, "result": wynik}"""
    raise NotImplementedError("Do zrobienia")


def odpowiedz_blad(identyfikator: Any, kod: int, komunikat: str) -> dict[str, Any]:
    """{"jsonrpc": "2.0", "id": identyfikator, "error": {"code": kod, "message": komunikat}}"""
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def obsluz_initialize(params: dict[str, Any]) -> dict[str, Any]:
    """Wynik metody "initialize":

    {"protocolVersion": <wynegocjowana wersja>,
     "capabilities": {"tools": {}},
     "serverInfo": {"name": NAZWA_SERWERA, "version": WERSJA_SERWERA}}
    """
    # Podpowiedź: wersja klienta, jeśli jest w OBSLUGIWANE_WERSJE, inaczej OBSLUGIWANE_WERSJE[0]
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def obsluz_tools_list() -> dict[str, Any]:
    """{"tools": [definicje wszystkich narzędzi z NARZEDZIA, w kolejności słownika]}"""
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def obsluz_tools_call(params: dict[str, Any]) -> dict[str, Any]:
    """Wywołuje narzędzie params["name"] z argumentami params.get("arguments", {}).

    - sukces → {"content": [{"type": "text", "text": <wynik jako tekst>}], "isError": False}
      (str bez zmian, inne typy przez json.dumps(..., ensure_ascii=False)),
    - nieznane narzędzie → raise BladProtokolu(INVALID_PARAMS, "nieznane narzędzie: <nazwa>"),
    - wyjątek w funkcji (też TypeError od złych argumentów) →
      {"content": [{"type": "text", "text": "<TypWyjątku>: <treść>"}], "isError": True}.
    """
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def obsluz_wiadomosc(wiadomosc: Any) -> dict[str, Any] | None:
    """Obsługuje jedną wiadomość JSON-RPC (już sparsowaną). Zwraca odpowiedź albo None.

    - nie słownik, brak "jsonrpc": "2.0" albo "method" nie jest napisem
      → błąd INVALID_REQUEST (id z wiadomości, jeśli jest; inaczej None),
    - brak klucza "id" (powiadomienie) → None, nawet dla nieznanej metody,
    - metody: "initialize", "ping" (wynik {}), "tools/list", "tools/call";
      params = wiadomosc.get("params", {}),
    - nieznana metoda → METHOD_NOT_FOUND,
    - BladProtokolu → odpowiedź z jego kodem i komunikatem.
    """
    # Podpowiedź: słownik metoda → funkcja(params)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def obsluz_linie(linia: str) -> str | None:
    """Jedna linia ze stdin → jedna linia odpowiedzi (bez znaku nowej linii) albo None.

    Pusta linia → None. Niepoprawny JSON → błąd PARSE_ERROR z id None.
    """
    # Podpowiedź: json.loads w try, potem obsluz_wiadomosc i json.dumps
    raise NotImplementedError("Do zrobienia")


def main() -> None:
    """Pętla serwera: linia ze stdin → odpowiedź na stdout. Logi tylko na stderr!"""
    # Klienci MCP mówią UTF-8 i dzielą wiadomości znakiem "\n" — także na Windows.
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[union-attr]  # stdin to TextIOWrapper
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]  # j.w.
    print(f"{NAZWA_SERWERA} {WERSJA_SERWERA} gotowy (stdio)", file=sys.stderr)
    for linia in sys.stdin:
        odpowiedz = obsluz_linie(linia)
        if odpowiedz is not None:
            print(odpowiedz, flush=True)


if __name__ == "__main__":
    main()
