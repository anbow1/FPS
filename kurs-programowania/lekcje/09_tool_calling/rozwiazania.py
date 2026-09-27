# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
"""Lekcja 09 — Tool calling.

Wiadomości mają dokładnie taki kształt jak w Messages API Claude'a, tylko
jako zwykłe słowniki. "Model" to funkcja: model(wiadomosci, narzedzia) -> odpowiedź,
gdzie odpowiedź to {"stop_reason": ..., "content": [bloki]}.
"""

import inspect
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

TYPY_JSON = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array", dict: "object"}

Model = Callable[[list[dict[str, Any]], list[dict[str, Any]]], dict[str, Any]]


@dataclass(frozen=True)
class Narzedzie:
    """Funkcja w Pythonie + jej definicja dla modelu."""

    funkcja: Callable[..., Any]
    definicja: dict[str, Any]


# Ćwiczenie 1
def definicja_pogody() -> dict[str, Any]:
    """Definicja narzędzia "pobierz_pogode":

    - description: niepusty opis (co robi i kiedy go użyć),
    - input_schema: obiekt z polami
        miasto (string, wymagane, z opisem),
        jednostka (string, enum ["C", "F"], opcjonalne).
    """
    # ROZWIĄZANIE-START: przepisz przykład z README
    return {
        "name": "pobierz_pogode",
        "description": "Zwraca bieżącą pogodę dla miasta. Używaj, gdy użytkownik pyta o pogodę.",
        "input_schema": {
            "type": "object",
            "properties": {
                "miasto": {"type": "string", "description": "Nazwa miasta, np. Kraków"},
                "jednostka": {"type": "string", "enum": ["C", "F"]},
            },
            "required": ["miasto"],
        },
    }
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def definicja_z_funkcji(funkcja: Callable[..., Any]) -> dict[str, Any]:
    """Buduje definicję narzędzia z funkcji Pythona:

    - name: nazwa funkcji,
    - description: docstring (inspect.getdoc); brak docstringu → ValueError,
    - input_schema: {"type": "object", "properties": {...}, "required": [...]},
      typ każdego parametru z adnotacji wg TYPY_JSON (brak/nieznany typ → ValueError),
      wymagane = parametry bez wartości domyślnej, w kolejności z sygnatury.
    """
    # ROZWIĄZANIE-START: inspect.signature(funkcja).parameters
    opis = inspect.getdoc(funkcja)
    if not opis:
        raise ValueError(f"funkcja {funkcja.__name__} nie ma docstringu — model nie będzie wiedział, do czego służy")
    wlasciwosci = {}
    wymagane = []
    for nazwa, parametr in inspect.signature(funkcja).parameters.items():
        if parametr.annotation not in TYPY_JSON:
            raise ValueError(f"parametr '{nazwa}' funkcji {funkcja.__name__} ma nieobsługiwany typ {parametr.annotation}")
        wlasciwosci[nazwa] = {"type": TYPY_JSON[parametr.annotation]}
        if parametr.default is inspect.Parameter.empty:
            wymagane.append(nazwa)
    return {
        "name": funkcja.__name__,
        "description": opis,
        "input_schema": {"type": "object", "properties": wlasciwosci, "required": wymagane},
    }
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def waliduj_wejscie(schemat: dict[str, Any], wejscie: Any) -> list[str]:
    """Sprawdza argumenty od modelu względem input_schema. Zwraca listę błędów:

    - wejście nie jest słownikiem → ["wejście musi być obiektem"]
    - "brak wymaganego pola 'x'"                   (kolejność: jak w "required")
    - "pole 'x': oczekiwano integer"               (kolejność: jak w wejściu)
    - "pole 'x': wartość 'K' spoza [C, F]"          (gdy jest "enum")
    - "nieznane pole 'x'"                           (pole spoza "properties")
    "number" akceptuje int i float; bool NIE jest ani integer, ani number.
    """
    # ROZWIĄZANIE-START: najpierw required, potem każde pole z wejścia
    if not isinstance(wejscie, dict):
        return ["wejście musi być obiektem"]
    wlasciwosci = schemat.get("properties", {})
    bledy = [f"brak wymaganego pola '{pole}'" for pole in schemat.get("required", []) if pole not in wejscie]
    for pole, wartosc in wejscie.items():
        if pole not in wlasciwosci:
            bledy.append(f"nieznane pole '{pole}'")
            continue
        opis_pola = wlasciwosci[pole]
        if not _pasuje_typ(wartosc, opis_pola.get("type")):
            bledy.append(f"pole '{pole}': oczekiwano {opis_pola['type']}")
        elif "enum" in opis_pola and wartosc not in opis_pola["enum"]:
            dozwolone = ", ".join(str(opcja) for opcja in opis_pola["enum"])
            bledy.append(f"pole '{pole}': wartość '{wartosc}' spoza [{dozwolone}]")
    return bledy


def _pasuje_typ(wartosc: Any, typ_json: str | None) -> bool:
    if typ_json is None:
        return True
    if isinstance(wartosc, bool):
        return typ_json == "boolean"
    if typ_json == "number":
        return isinstance(wartosc, (int, float))
    typy_pythona = {nazwa: typ for typ, nazwa in TYPY_JSON.items()}
    return isinstance(wartosc, typy_pythona[typ_json])
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def wykonaj_wywolanie(blok: dict[str, Any], rejestr: dict[str, Narzedzie]) -> dict[str, Any]:
    """Wykonuje blok tool_use i zwraca blok tool_result:

        {"type": "tool_result", "tool_use_id": blok["id"], "content": "..."}

    - content: wynik funkcji; str bez zmian, inne typy przez json.dumps (ensure_ascii=False),
    - nieznane narzędzie → is_error: True, content "nieznane narzędzie '<nazwa>'",
    - błędy walidacji → is_error: True, content = błędy połączone "; ",
    - wyjątek w funkcji → is_error: True, content "<TypWyjątku>: <treść>".
    Klucz "is_error" dodaj tylko przy błędzie.
    """
    # ROZWIĄZANIE-START: rejestr[blok["name"]].funkcja(**blok["input"])
    wynik: dict[str, Any] = {"type": "tool_result", "tool_use_id": blok["id"]}
    narzedzie = rejestr.get(blok["name"])
    if narzedzie is None:
        return {**wynik, "content": f"nieznane narzędzie '{blok['name']}'", "is_error": True}
    bledy = waliduj_wejscie(narzedzie.definicja["input_schema"], blok["input"])
    if bledy:
        return {**wynik, "content": "; ".join(bledy), "is_error": True}
    try:
        rezultat = narzedzie.funkcja(**blok["input"])
    except Exception as blad:  # model musi dostać każdy błąd narzędzia, żeby mógł zareagować
        return {**wynik, "content": f"{type(blad).__name__}: {blad}", "is_error": True}
    tresc = rezultat if isinstance(rezultat, str) else json.dumps(rezultat, ensure_ascii=False)
    return {**wynik, "content": tresc}
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def petla_agenta(
    model: Model, pytanie: str, rejestr: dict[str, Narzedzie], max_krokow: int = 10
) -> tuple[str, list[dict[str, Any]]]:
    """Pętla agenta. Zwraca (tekst_końcowy, pełna_historia_wiadomości).

    - start: [{"role": "user", "content": pytanie}],
    - każdy krok: odpowiedz = model(wiadomosci, lista_definicji_narzędzi),
      dopisz {"role": "assistant", "content": odpowiedz["content"]},
    - stop_reason "tool_use": wykonaj WSZYSTKIE bloki tool_use, dopisz JEDNĄ wiadomość user z wynikami,
    - "end_turn": zwróć teksty bloków "text" sklejone bez separatora,
    - inny stop_reason (max_tokens, refusal…) → RuntimeError z jego nazwą,
    - po max_krokow wywołaniach modelu bez końca → RuntimeError.
    """
    # ROZWIĄZANIE-START: for krok in range(max_krokow): ...
    wiadomosci: list[dict[str, Any]] = [{"role": "user", "content": pytanie}]
    narzedzia = [narzedzie.definicja for narzedzie in rejestr.values()]
    for _ in range(max_krokow):
        odpowiedz = model(wiadomosci, narzedzia)
        wiadomosci.append({"role": "assistant", "content": odpowiedz["content"]})
        powod = odpowiedz["stop_reason"]
        if powod == "end_turn":
            tekst = "".join(blok["text"] for blok in odpowiedz["content"] if blok["type"] == "text")
            return tekst, wiadomosci
        if powod != "tool_use":
            raise RuntimeError(f"model zakończył z powodu '{powod}'")
        wyniki = [wykonaj_wywolanie(blok, rejestr) for blok in odpowiedz["content"] if blok["type"] == "tool_use"]
        wiadomosci.append({"role": "user", "content": wyniki})
    raise RuntimeError(f"agent nie skończył w {max_krokow} krokach")
    # ROZWIĄZANIE-KONIEC
