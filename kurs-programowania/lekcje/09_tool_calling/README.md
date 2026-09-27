# Lekcja 09 — Tool calling (wywoływanie narzędzi przez model AI)

Cel: rozumiesz, jak model językowy „używa narzędzi”, znasz dokładny kształt
wiadomości w API Claude'a i piszesz własną pętlę agenta, która wykonuje
narzędzia bezpiecznie.

## Teoria

### Model niczego nie wykonuje

Model tylko **produkuje tekst**. Tool calling to umowa: opisujesz modelowi
narzędzia (nazwa, opis, schemat argumentów w JSON Schema), a on — zamiast
odpowiedzi — może zwrócić **prośbę o wywołanie** z argumentami w JSON.
Wykonanie należy do **Twojego kodu**. Wynik odsyłasz modelowi, a on pisze dalej.

```
Ty ──(pytanie + lista narzędzi)──────────────▶ model
Ty ◀──(stop_reason="tool_use", blok tool_use)── model   "wywołaj pogoda(miasto='Kraków')"
Ty: wykonujesz funkcję pogoda("Kraków") → "12°C, deszcz"
Ty ──(historia + blok tool_result)───────────▶ model
Ty ◀──(stop_reason="end_turn", tekst)────────── model   "W Krakowie 12°C i pada."
```

### Definicja narzędzia

```json
{
  "name": "pobierz_pogode",
  "description": "Zwraca bieżącą pogodę dla miasta. Używaj, gdy użytkownik pyta o pogodę.",
  "input_schema": {
    "type": "object",
    "properties": {
      "miasto":    {"type": "string", "description": "Nazwa miasta, np. Kraków"},
      "jednostka": {"type": "string", "enum": ["C", "F"]}
    },
    "required": ["miasto"]
  }
}
```

`description` to instrukcja dla modelu — pisz, **co** robi narzędzie i **kiedy**
go użyć. Od jakości opisów zależy, czy model wybierze właściwe narzędzie.

### Kształt wiadomości (Messages API)

Odpowiedź modelu z prośbą o narzędzie:

```json
{
  "stop_reason": "tool_use",
  "content": [
    {"type": "text", "text": "Sprawdzę pogodę."},
    {"type": "tool_use", "id": "toolu_01A", "name": "pobierz_pogode", "input": {"miasto": "Kraków"}}
  ]
}
```

Twoja kolejna wiadomość (rola `user`) z wynikiem:

```json
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_use_id": "toolu_01A", "content": "12°C, deszcz"}
  ]
}
```

Zasady:

- Całą odpowiedź modelu (`content`) dopisujesz do historii jako wiadomość
  `assistant` — bez wybierania kawałków.
- `tool_use_id` musi pasować do `id` z bloku `tool_use`.
- Model może poprosić o **kilka** narzędzi naraz — wszystkie wyniki odsyłasz
  w **jednej** wiadomości `user`.
- Narzędzie się wysypało? Nie przerywaj — odeślij `tool_result` z
  `"is_error": true` i opisem błędu. Model zwykle sam się poprawi.

### stop_reason — dlaczego model skończył

| Wartość | Znaczenie | Twoja reakcja |
|---|---|---|
| `end_turn` | skończył odpowiedź | pokaż tekst, koniec pętli |
| `tool_use` | chce narzędzi | wykonaj, odeślij wyniki, kolejny obrót pętli |
| `max_tokens` | zabrakło limitu tokenów | odpowiedź ucięta — zwiększ `max_tokens` |
| `refusal` | odmówił ze względów bezpieczeństwa | nie czytaj `content` jak zwykłej odpowiedzi |

### Pętla agenta

„Agent” to po prostu pętla:

```python
while True:
    odpowiedz = model(wiadomosci, narzedzia)
    wiadomosci.append({"role": "assistant", "content": odpowiedz["content"]})
    if odpowiedz["stop_reason"] != "tool_use":
        break
    wyniki = [wykonaj(blok) for blok in odpowiedz["content"] if blok["type"] == "tool_use"]
    wiadomosci.append({"role": "user", "content": wyniki})
```

Plus bezpiecznik: **maksymalna liczba kroków**, żeby błąd nie zamienił się w
nieskończoną (i drogą) pętlę.

### Bezpieczeństwo

- Argumenty od modelu to **niezaufane dane** — waliduj je jak wejście od
  użytkownika (ćwiczenie 3).
- Dawaj narzędzia o minimalnych uprawnieniach (tylko odczyt, gdzie się da).
- Akcje nieodwracalne (usuwanie, płatności, wysyłka maili) — potwierdzenie
  człowieka przed wykonaniem.
- Wyniki narzędzi (np. treść strony WWW) mogą zawierać wstrzyknięte
  „instrukcje” (prompt injection). To dane, nie polecenia.

### Z prawdziwym API

`przyklad_claude.py` robi to samo z oficjalnym SDK (`pip install anthropic`,
klucz w zmiennej `ANTHROPIC_API_KEY`). Rdzeń:

```python
import anthropic

client = anthropic.Anthropic()          # klucz czyta ze zmiennej środowiskowej
odpowiedz = client.messages.create(
    model="claude-opus-5",
    max_tokens=16000,
    tools=NARZEDZIA,
    messages=wiadomosci,
)
odpowiedz.stop_reason                   # "tool_use", "end_turn", ...
for blok in odpowiedz.content:
    if blok.type == "tool_use":
        blok.id, blok.name, blok.input
```

SDK ma też gotowy „tool runner” (`client.beta.messages.tool_runner` +
dekorator `@beta_tool`), który prowadzi pętlę za Ciebie. Warto najpierw
napisać pętlę samemu — wtedy wiesz, co robi runner.

## Ćwiczenia

Ćwiczenia działają **bez klucza API**: model udaje funkcja zwracająca
zaplanowane odpowiedzi w dokładnie takim kształcie jak API.

1. `definicja_pogody()` — ręcznie napisana definicja narzędzia.
2. `definicja_z_funkcji(funkcja)` — definicja z sygnatury i docstringu (jak robią SDK).
3. `waliduj_wejscie(schemat, wejscie)` — sprawdź argumenty od modelu.
4. `wykonaj_wywolanie(blok, rejestr)` — `tool_use` → `tool_result` (z `is_error`).
5. `petla_agenta(model, pytanie, rejestr, max_krokow)` — pełna pętla.

## Podpowiedzi

- **cw2**: `inspect.signature(funkcja).parameters` daje parametry; `parametr.annotation` typ, `parametr.default is inspect.Parameter.empty` znaczy „wymagany”. Opis: `inspect.getdoc(funkcja)`. Typy: `str→"string"`, `int→"integer"`, `float→"number"`, `bool→"boolean"`, `list→"array"`, `dict→"object"`.
- **cw3**: `bool` to podklasa `int` — sprawdź go osobno (jak w lekcji 05). Dla `"number"` akceptuj `int` i `float`.
- **cw4**: wynik funkcji: `str` zostaw, resztę zamień `json.dumps(..., ensure_ascii=False)`. Wyjątek z funkcji → `is_error: True` z treścią `f"{type(blad).__name__}: {blad}"`.
- **cw5**: `narzedzia = [n.definicja for n in rejestr.values()]`. W każdym kroku: wywołaj model, dopisz `{"role": "assistant", "content": odpowiedz["content"]}`, sprawdź `stop_reason`. Tekst końcowy to sklejone `blok["text"]` bloków typu `"text"`.
