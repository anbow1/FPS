# Lekcja 08 — HTTP i REST API

Cel: rozumiesz zapytanie i odpowiedź HTTP, rozmawiasz z API z terminala i
z Pythona, obsługujesz błędy, limity (429), ponowienia i paginację.

## Teoria

### Zapytanie i odpowiedź

```
POST /v1/zamowienia?dry_run=1 HTTP/1.1          ← metoda, ścieżka, parametry
Host: api.sklep.example                          ← nagłówki
Authorization: Bearer sk-...
Content-Type: application/json

{"produkt": "Kawa", "sztuki": 2}                 ← ciało (body)
```

```
HTTP/1.1 201 Created                             ← kod statusu
Content-Type: application/json

{"id": 42, "status": "przyjete"}
```

### Metody (REST)

| Metoda | Znaczenie | Przykład |
|---|---|---|
| GET | pobierz (bez skutków ubocznych) | `GET /klienci/7` |
| POST | utwórz | `POST /klienci` |
| PUT / PATCH | zastąp / zmień część | `PATCH /klienci/7` |
| DELETE | usuń | `DELETE /klienci/7` |

**Idempotentne** (bezpieczne do powtórzenia): GET, PUT, DELETE. POST nie —
ponowienie może utworzyć duplikat.

### Kody statusu

| Kod | Znaczenie | Co robić |
|---|---|---|
| 200 OK, 201 Created | sukces | czytaj body |
| 204 No Content | sukces bez body | nic nie parsuj |
| 400 Bad Request | złe dane | popraw zapytanie, **nie ponawiaj** |
| 401 / 403 | brak / zły klucz, brak uprawnień | sprawdź klucz |
| 404 Not Found | brak zasobu | |
| 429 Too Many Requests | limit zapytań | poczekaj (nagłówek `Retry-After`) i ponów |
| 500, 502, 503, 504 | błąd serwera | ponów z rosnącym opóźnieniem |

### Z terminala: curl

```bash
curl -s "https://api.github.com/repos/python/cpython" | python -m json.tool
curl -s -X POST https://httpbin.org/post -H "Content-Type: application/json" -d '{"a": 1}'
```

W PowerShellu `curl` bywa aliasem — pisz `curl.exe` albo użyj natywnego:

```powershell
Invoke-RestMethod https://api.github.com/repos/python/cpython | Select-Object stargazers_count
```

### Z Pythona

Biblioteka standardowa (`urllib`) — zobacz `przyklad_http.py`:

```python
import json, urllib.request

zapytanie = urllib.request.Request(url, headers={"Accept": "application/json"})
with urllib.request.urlopen(zapytanie, timeout=10) as odpowiedz:   # ZAWSZE timeout
    dane = json.load(odpowiedz)
```

W prawdziwych projektach wygodniej: `requests` albo `httpx`:

```python
import requests
r = requests.get(url, params={"q": "kawa"}, headers=naglowki, timeout=10)
r.raise_for_status()
dane = r.json()
```

### Klucze API

Nigdy w kodzie ani w gicie. Czytaj ze zmiennej środowiskowej:

```python
import os
klucz = os.environ["MOJE_API_KEY"]   # KeyError, jeśli brak — głośno i od razu
```

### Ponowienia z wykładniczym opóźnieniem (exponential backoff)

Błędy 429 i 5xx bywają chwilowe. Ponawiamy, czekając coraz dłużej:
0.5 s, 1 s, 2 s, 4 s… z górnym limitem. Nie ponawiamy 4xx (poza 429) — to
nasz błąd, powtórka nic nie da. Liczba prób musi być **skończona**.

### Paginacja

Duże listy przychodzą stronami: odpowiedź zawiera dane i wskaźnik następnej
strony (numer, kursor albo URL). Pobieramy, dopóki wskaźnik nie jest pusty.

### Testowanie kodu sieciowego

Testy nie mogą zależeć od internetu. Funkcję „wyślij” przekazujemy jako
parametr — w teście podstawiamy atrapę, która zwraca zaplanowane odpowiedzi.
Tak też są zbudowane ćwiczenia.

## Ćwiczenia

1. `zbuduj_url(baza, sciezka, parametry)`.
2. `naglowki(token)`.
3. `obsluz_odpowiedz(status, tekst)` — JSON albo właściwy wyjątek.
4. `czy_ponowic(status)` i `opoznienie(proba)`.
5. `pobierz_z_ponowieniami(wyslij, max_prob, spij)`.
6. `pobierz_wszystkie_strony(pobierz_strone)`.

Bonus: `python przyklad_http.py` — prawdziwe zapytanie do API GitHuba (potrzebny internet).

## Podpowiedzi

- **cw1**: `urllib.parse.urlencode(...)` na słowniku bez wartości `None`; sklej `baza.rstrip("/") + "/" + sciezka.lstrip("/")`.
- **cw3**: kolejność: `204` → `None`; `200–299` → `json.loads`; `400–499` → `BladKlienta`; `>= 500` → `BladSerwera`. Komunikat z pola `"error"`, gdy body to JSON z takim polem — w przeciwnym razie surowy tekst.
- **cw4**: `min(maks, baza * 2 ** proba)`.
- **cw5**: `for proba in range(max_prob):` — jeśli status nadaje się do ponowienia i to nie ostatnia próba: `spij(opoznienie(proba))` i `continue`. Na końcu `return obsluz_odpowiedz(status, tekst)`. `ConnectionError` z `wyslij()` traktuj jak status do ponowienia; po ostatniej próbie rzuć go dalej.
- **cw6**: `kursor = None`, pętla `while True`, `strona = pobierz_strone(kursor)`, `wyniki.extend(strona["dane"])`, `kursor = strona["nastepna"]`, `if kursor is None: break`. Licz strony i przerwij po `MAKS_STRON`.
