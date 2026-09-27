"""Pętla agenta z prawdziwym API Claude'a (opcjonalne — ćwiczenia tego nie wymagają).

Przygotowanie (w aktywnym venv):
    python -m pip install anthropic
    $env:ANTHROPIC_API_KEY = "sk-ant-..."      # PowerShell
    export ANTHROPIC_API_KEY=sk-ant-...        # bash

Uruchomienie:
    python przyklad_claude.py "Ile złotych to 250 euro i 40 dolarów?"
"""

import json
import sys
from typing import Any

import anthropic

MODEL = "claude-opus-5"
MAKS_KROKOW = 10

# Kursy na sztywno, żeby przykład był powtarzalny — prawdziwe narzędzie pytałoby API banku.
KURSY_PLN = {"EUR": 4.30, "USD": 3.90, "GBP": 5.00}

NARZEDZIA: list[dict[str, Any]] = [
    {
        "name": "kurs_walut",
        "description": "Zwraca kurs waluty w złotych (PLN). Użyj przed przeliczaniem kwot.",
        "input_schema": {
            "type": "object",
            "properties": {"waluta": {"type": "string", "enum": sorted(KURSY_PLN)}},
            "required": ["waluta"],
        },
    },
    {
        "name": "przelicz",
        "description": "Mnoży kwotę przez kurs i zaokrągla do groszy.",
        "input_schema": {
            "type": "object",
            "properties": {"kwota": {"type": "number"}, "kurs": {"type": "number"}},
            "required": ["kwota", "kurs"],
        },
    },
]


def wykonaj(nazwa: str, wejscie: dict[str, Any]) -> tuple[str, bool]:
    """Zwraca (treść wyniku, czy_błąd)."""
    if nazwa == "kurs_walut":
        waluta = wejscie.get("waluta")
        if waluta not in KURSY_PLN:
            return f"nieznana waluta {waluta!r}; znane: {', '.join(KURSY_PLN)}", True
        return json.dumps(KURSY_PLN[waluta]), False
    if nazwa == "przelicz":
        return json.dumps(round(float(wejscie["kwota"]) * float(wejscie["kurs"]), 2)), False
    return f"nieznane narzędzie {nazwa!r}", True


def main() -> int:
    pytanie = sys.argv[1] if len(sys.argv) > 1 else "Ile złotych to 250 euro i 40 dolarów?"
    client = anthropic.Anthropic()  # klucz ze zmiennej ANTHROPIC_API_KEY
    wiadomosci: list[dict[str, Any]] = [{"role": "user", "content": pytanie}]

    for _ in range(MAKS_KROKOW):
        try:
            odpowiedz = client.messages.create(
                model=MODEL, max_tokens=16000, tools=NARZEDZIA, messages=wiadomosci
            )
        except anthropic.AuthenticationError:
            print("Serwer odrzucił klucz: sprawdź zmienną ANTHROPIC_API_KEY.", file=sys.stderr)
            return 1
        except TypeError as blad:
            # SDK zgłasza TypeError, gdy nie znalazł żadnych danych logowania.
            print(f"Brak klucza API — ustaw zmienną ANTHROPIC_API_KEY. ({blad})", file=sys.stderr)
            return 1
        except anthropic.APIConnectionError as blad:
            print(f"Brak połączenia z API: {blad}", file=sys.stderr)
            return 1

        if odpowiedz.stop_reason == "refusal":
            print("Model odmówił odpowiedzi.", file=sys.stderr)
            return 1
        # Całą treść (także bloki myślenia) odsyłamy z powrotem bez zmian.
        wiadomosci.append({"role": "assistant", "content": odpowiedz.content})

        if odpowiedz.stop_reason != "tool_use":
            print("".join(blok.text for blok in odpowiedz.content if blok.type == "text"))
            return 0

        wyniki = []
        for blok in odpowiedz.content:
            if blok.type != "tool_use":
                continue
            tresc, czy_blad = wykonaj(blok.name, blok.input)
            print(f"  → {blok.name}({json.dumps(blok.input, ensure_ascii=False)}) = {tresc}")
            wynik: dict[str, Any] = {"type": "tool_result", "tool_use_id": blok.id, "content": tresc}
            if czy_blad:
                wynik["is_error"] = True
            wyniki.append(wynik)
        wiadomosci.append({"role": "user", "content": wyniki})

    print(f"Agent nie skończył w {MAKS_KROKOW} krokach.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
