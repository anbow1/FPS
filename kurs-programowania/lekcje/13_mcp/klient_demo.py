"""Klient demonstracyjny: uruchamia Twój serwer (cwiczenia.py) i pokazuje całą rozmowę MCP.

    python klient_demo.py              # Twój serwer
    python klient_demo.py rozwiazania  # serwer wzorcowy
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

WIADOMOSCI: list[dict[str, Any]] = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "klient-demo", "version": "1.0"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "dodaj", "arguments": {"a": 2, "b": 40}}},
    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "licz_slowa", "arguments": {"tekst": "Ala ma kota"}}},
    {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "dodaj", "arguments": {"a": 2}}},
    {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "usun_wszystko", "arguments": {}}},
    {"jsonrpc": "2.0", "id": 7, "method": "resources/list"},
]
TIMEOUT_SEKUNDY = 10


def main() -> int:
    modul = sys.argv[1] if len(sys.argv) > 1 else "cwiczenia"
    serwer = Path(__file__).parent / f"{modul}.py"
    wejscie = "".join(json.dumps(wiadomosc, ensure_ascii=False) + "\n" for wiadomosc in WIADOMOSCI)
    wynik = subprocess.run(
        [sys.executable, str(serwer)], input=wejscie, capture_output=True, text=True,
        encoding="utf-8", timeout=TIMEOUT_SEKUNDY, check=False,
    )
    odpowiedzi = {}
    for linia in wynik.stdout.splitlines():
        try:
            odpowiedz = json.loads(linia)
        except json.JSONDecodeError:
            print(f"!! serwer wypisał na stdout coś, co nie jest JSON-em: {linia!r}")
            continue
        odpowiedzi[odpowiedz.get("id")] = odpowiedz

    for wiadomosc in WIADOMOSCI:
        print(f"\n→ {json.dumps(wiadomosc, ensure_ascii=False)}")
        if "id" not in wiadomosc:
            print("  (powiadomienie — bez odpowiedzi)")
            continue
        odpowiedz = odpowiedzi.get(wiadomosc["id"])
        print(f"← {json.dumps(odpowiedz, ensure_ascii=False)}" if odpowiedz else "← (brak odpowiedzi!)")
    if wynik.stderr.strip():
        print(f"\n[stderr serwera]\n{wynik.stderr.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
