# Lekcja 05 — JSON

Cel: czytasz i piszesz JSON bez zgadywania, wiesz, jak mapuje się na typy
Pythona, i bezpiecznie wyciągasz dane z głęboko zagnieżdżonych odpowiedzi API.

## Teoria

### Składnia

JSON (JavaScript Object Notation) to tekstowy format wymiany danych — język
API, plików konfiguracyjnych i… wywołań narzędzi przez modele AI (lekcja 09).

```json
{
  "imie": "Ala",
  "wiek": 30,
  "aktywna": true,
  "telefon": null,
  "tagi": ["python", "sql"],
  "adres": {"miasto": "Kraków", "kod": "30-001"}
}
```

Pułapki: klucze i napisy **tylko w podwójnych cudzysłowach**, brak komentarzy,
brak przecinka po ostatnim elemencie, `true/false/null` małymi literami.

### JSON ↔ Python

| JSON | Python |
|---|---|
| object `{}` | `dict` |
| array `[]` | `list` |
| string | `str` |
| number | `int` / `float` |
| `true` / `false` | `True` / `False` |
| `null` | `None` |

Czego JSON **nie ma**: dat, zbiorów, krotek (zamieniają się w listy), bajtów,
`Decimal`. Trzeba je zamienić samemu — np. datę na napis ISO `"2026-09-27"`.

### Moduł json

```python
import json

dane = json.loads('{"a": [1, 2]}')          # tekst → Python (s = string)
tekst = json.dumps(dane)                     # Python → tekst
tekst = json.dumps(dane, indent=2, ensure_ascii=False, sort_keys=True)

from pathlib import Path
Path("dane.json").write_text(json.dumps(dane, ensure_ascii=False), encoding="utf-8")
dane = json.loads(Path("dane.json").read_text(encoding="utf-8"))
```

- `ensure_ascii=False` — `"Kraków"` zamiast `"Kraków"`.
- `indent=2` — czytelnie dla człowieka; bez niego — zwięźle dla maszyny.
- `default=funkcja` — co zrobić z typem, którego json nie zna:

```python
from datetime import date

def na_json(obiekt):
    if isinstance(obiekt, date):
        return obiekt.isoformat()
    raise TypeError(f"{type(obiekt).__name__} nie da się zapisać w JSON")

json.dumps({"dzis": date(2026, 9, 27)}, default=na_json)   # '{"dzis": "2026-09-27"}'
```

### Błędy

`json.JSONDecodeError` (podklasa `ValueError`) ma pola `lineno`, `colno` i
`msg` — pokaż je użytkownikowi, zamiast „coś nie tak z plikiem”.

### Zagnieżdżone dane

Odpowiedzi API bywają głębokie: `dane["wyniki"][0]["adres"]["miasto"]`. Każdy
krok może rzucić `KeyError`/`IndexError`. Pomaga funkcja „ścieżkowa” (ćw. 3)
albo `dict.get()` na każdym poziomie.

### Walidacja

Dane z zewnątrz (plik, API, odpowiedź modelu) są **niezaufane** — sprawdź
wymagane pola i typy, zanim ich użyjesz. Pułapka: `isinstance(True, int)` to
`True`, bo `bool` dziedziczy po `int`! Standardem opisu kształtu JSON-a jest
**JSON Schema** — zobaczysz go w lekcji o tool calling.

### JSON Lines (.jsonl)

Jeden obiekt JSON w każdej linii. Wygodne dla logów i dużych zbiorów danych:
można dopisywać i czytać strumieniowo, linia po linii.

```text
{"id": 1, "tekst": "pierwszy"}
{"id": 2, "tekst": "drugi"}
```

## Ćwiczenia

1. `wczytaj_json(tekst)` — z czytelnym błędem (linia, kolumna).
2. `do_json(obiekt)` — ładnie, z polskimi znakami, datami i zbiorami.
3. `pobierz(dane, sciezka, domyslna)` — `"uzytkownicy.0.adres.miasto"`.
4. `waliduj(obiekt, schemat)` — lista błędów (z pułapką bool/int).
5. `zapisz_jsonl` / `wczytaj_jsonl` — pliki JSON Lines.
6. `splaszcz(dane)` — `{"a": {"b": 1}}` → `{"a.b": 1}`.

## Podpowiedzi

- **cw1**: `except json.JSONDecodeError as blad:` → `raise ValueError(f"... linia {blad.lineno}, kolumna {blad.colno}: {blad.msg}") from blad`.
- **cw2**: `json.dumps(obiekt, indent=2, ensure_ascii=False, sort_keys=True, default=_na_json)`, gdzie `_na_json` obsługuje `date`/`datetime` (`isoformat()`) i `set` (`sorted(...)`).
- **cw3**: `for klucz in sciezka.split("."):` — jeśli bieżąca wartość to lista, a klucz to cyfry, użyj `int(klucz)`. Łap `KeyError`, `IndexError`, `TypeError` i zwróć `domyslna`.
- **cw4**: dla `bool` sprawdzaj `type(wartosc) is typ` albo najpierw wyklucz `isinstance(wartosc, bool)` gdy typ to `int`.
- **cw5**: `"\n".join(json.dumps(r, ensure_ascii=False) for r in rekordy) + "\n"`; przy czytaniu pomijaj puste linie.
- **cw6**: rekurencja z prefiksem: `splaszcz(wartosc, f"{prefiks}{klucz}.")`. Lista też jest „słownikiem” z kluczami 0, 1, 2…
