"""Zapis postępu ucznia w pliku JSON (.postep.json, poza gitem)."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from silnik.lekcje import KATALOG_KURSU

PLIK_POSTEPU = KATALOG_KURSU / ".postep.json"


def wczytaj(plik: Path = PLIK_POSTEPU) -> dict[str, Any]:
    if not plik.exists():
        return {"lekcje": {}, "quizy": {}}
    try:
        dane = json.loads(plik.read_text(encoding="utf-8"))
    except json.JSONDecodeError as blad:
        raise ValueError(f"plik postępu {plik} jest uszkodzony ({blad}); usuń go, by zacząć od nowa") from blad
    dane.setdefault("lekcje", {})
    dane.setdefault("quizy", {})
    return dane


def zapisz_lekcje(kod: str, ok: int, wszystkie: int, plik: Path = PLIK_POSTEPU) -> None:
    dane = wczytaj(plik)
    dane["lekcje"][kod] = {
        "ok": ok,
        "wszystkie": wszystkie,
        "zaliczona": wszystkie > 0 and ok == wszystkie,
        "kiedy": datetime.now().isoformat(timespec="seconds"),
    }
    _zapisz(dane, plik)


def zapisz_quiz(kod: str, dobre: int, pytania: int, plik: Path = PLIK_POSTEPU) -> None:
    dane = wczytaj(plik)
    poprzedni = dane["quizy"].get(kod, {}).get("najlepszy", 0)
    dane["quizy"][kod] = {"najlepszy": max(poprzedni, dobre), "pytania": pytania}
    _zapisz(dane, plik)


def _zapisz(dane: dict[str, Any], plik: Path) -> None:
    # ensure_ascii=False, żeby polskie znaki były czytelne w pliku.
    plik.write_text(json.dumps(dane, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
