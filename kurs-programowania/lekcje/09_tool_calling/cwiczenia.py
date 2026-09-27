# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 09   (albo: python kurs.py obserwuj 09)
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
    # Podpowiedź: przepisz przykład z README
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def definicja_z_funkcji(funkcja: Callable[..., Any]) -> dict[str, Any]:
    """Buduje definicję narzędzia z funkcji Pythona:

    - name: nazwa funkcji,
    - description: docstring (inspect.getdoc); brak docstringu → ValueError,
    - input_schema: {"type": "object", "properties": {...}, "required": [...]},
      typ każdego parametru z adnotacji wg TYPY_JSON (brak/nieznany typ → ValueError),
      wymagane = parametry bez wartości domyślnej, w kolejności z sygnatury.
    """
    # Podpowiedź: inspect.signature(funkcja).parameters
    raise NotImplementedError("Do zrobienia")


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
    # Podpowiedź: najpierw required, potem każde pole z wejścia
    raise NotImplementedError("Do zrobienia")


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
    # Podpowiedź: rejestr[blok["name"]].funkcja(**blok["input"])
    raise NotImplementedError("Do zrobienia")


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
    # Podpowiedź: for krok in range(max_krokow): ...
    raise NotImplementedError("Do zrobienia")
