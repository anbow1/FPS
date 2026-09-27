"""Mini-aplikacja WWW do lekcji o Dockerze: liczy odwiedziny w pliku na wolumenie."""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

KATALOG_DANYCH = Path(os.environ.get("KATALOG_DANYCH", "dane"))
PORT = int(os.environ.get("PORT", "8000"))


class Obsluga(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        KATALOG_DANYCH.mkdir(parents=True, exist_ok=True)
        licznik = KATALOG_DANYCH / "licznik.txt"
        odwiedziny = int(licznik.read_text(encoding="utf-8")) + 1 if licznik.exists() else 1
        licznik.write_text(str(odwiedziny), encoding="utf-8")
        tresc = json.dumps(
            {"wiadomosc": os.environ.get("POWITANIE", "Cześć z kontenera!"), "odwiedziny": odwiedziny},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(tresc)))
        self.end_headers()
        self.wfile.write(tresc)


if __name__ == "__main__":
    # 0.0.0.0, a nie localhost: w kontenerze localhost jest widoczny tylko od środka.
    print(f"Słucham na porcie {PORT}", flush=True)
    HTTPServer(("0.0.0.0", PORT), Obsluga).serve_forever()
