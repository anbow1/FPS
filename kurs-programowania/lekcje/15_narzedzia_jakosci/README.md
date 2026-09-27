# Lekcja 15 — Narzędzia jakości: testy, lint, typy, uv i CI

Cel: pracujesz jak w dzisiejszych zespołach — projekt w `uv`, testy w
`pytest` z pomiarem pokrycia, `ruff` do lintu i formatowania, sprawdzanie typów,
`pre-commit` przed każdym commitem i CI na GitHubie. Do tego wiesz, jak
sprawdzić, czy **testy naprawdę coś sprawdzają**.

## Teoria

### Po co to wszystko?

Każde narzędzie łapie inny rodzaj błędów, **zanim** zobaczy je użytkownik:

| Narzędzie | Łapie | Kiedy |
|---|---|---|
| testy (pytest) | złe zachowanie | przy każdej zmianie |
| linter (ruff) | literówki w nazwach, nieużywane importy, typowe pułapki | w edytorze, przy commicie |
| formatter (ruff format) | kłótnie o styl | automatycznie |
| typy (mypy, pyright) | `None` tam, gdzie oczekiwano `str`, zły argument | w edytorze, w CI |
| CI (GitHub Actions) | „u mnie działa” | przy każdym pushu i PR |

To też najlepsza siatka bezpieczeństwa przy pracy z asystentami AI (np.
Claude Code): testy i typy to umowa, którą wygenerowany kod musi spełnić —
a Ty widzisz od razu, czy spełnia.

### uv — projekt i zależności

`uv` zastępuje naraz `pip`, `venv` i kilka innych narzędzi — i jest bardzo szybki
(instalacja: [docs.astral.sh/uv](https://docs.astral.sh/uv/)).

```bash
uv init sklep                  # nowy projekt z pyproject.toml
uv add requests                # zależność aplikacji
uv add --dev pytest ruff mypy  # zależności tylko do pracy
uv run pytest                  # uruchom w venv projektu (tworzy go sam)
uv lock / uv sync              # plik uv.lock z dokładnymi wersjami / odtwórz środowisko
uvx ruff check .               # jednorazowe narzędzie bez instalowania
```

Wszystko opisuje `pyproject.toml` — zobacz `przyklad/pyproject.toml`: jest tam
projekt, grupa `dev` i konfiguracja pytest, ruff i mypy w jednym pliku.

### pytest

```python
# tests/test_ceny.py — pliki test_*.py, funkcje test_*
import pytest
from sklep.ceny import cena_z_rabatem

def test_rabat_10_procent_od_1000_gr_daje_900():
    assert cena_z_rabatem(1000, 10) == 900          # zwykły assert, pytest pokaże różnicę

@pytest.mark.parametrize("rabat, oczekiwana", [(0, 500), (100, 0), (50, 250)])
def test_rabat_na_granicach(rabat, oczekiwana):     # jeden test, trzy przypadki
    assert cena_z_rabatem(500, rabat) == oczekiwana

def test_zly_rabat_to_blad():
    with pytest.raises(ValueError):
        cena_z_rabatem(100, 101)

def test_zapis_do_pliku(tmp_path):                  # fixture: świeży katalog tymczasowy
    (tmp_path / "a.txt").write_text("x")
```

Przydatne: `pytest -x` (stop po pierwszym błędzie), `-k rabat` (tylko pasujące
nazwy), `--lf` (tylko ostatnio nieudane), `monkeypatch` (podmiana zmiennych
środowiskowych i funkcji). Ten kurs używa `unittest` z biblioteki
standardowej, ale pytest uruchamia też testy unittest.

Dobre testy: nazwa jak zdanie, jeden powód do porażki, zawsze przypadek
brzegowy (0, pusto, granica zakresu) i jedna wartość znana z zewnątrz.

### Pokrycie — i jego pułapka

```bash
uv run pytest --cov=sklep --cov-report=term-missing
# Name              Stmts   Miss  Cover   Missing
# src/sklep/ceny.py    20      3    85%   14-16
```

`Missing` mówi, których linii **żaden** test nie wykonał. Ale 100% pokrycia nie
znaczy, że testy są dobre: test, który wywołuje funkcję i niczego nie sprawdza,
też „pokrywa” linie.

**Testowanie mutacyjne** odpowiada na lepsze pytanie: *czy testy wykryją
błąd?* Narzędzie (np. `mutmut`) psuje kod — zamienia `<` na `<=`, `//` na `/`,
`+` na `-` — i uruchamia testy. Jeśli nadal przechodzą, mutant „przeżył” i
znalazłeś dziurę w testach. To robisz w ćwiczeniu 1.

### ruff — lint i format

```bash
uv run ruff check .          # błędy i podejrzany kod
uv run ruff check --fix .    # popraw, co da się bezpiecznie ([*] w wyniku)
uv run ruff format .         # sformatuj (jak black)
```

Format „concise” (`--output-format concise`) to jedna uwaga na linię:
`src/a.py:3:8: F401 [*] 'os' imported but unused` — łatwy do przetworzenia
programem (ćwiczenie 2).

### Typy

```python
def znajdz(email: str) -> Uzytkownik | None: ...

u = znajdz("a@b.pl")
print(u.imie)        # mypy: Item "None" of "Uzytkownik | None" has no attribute "imie"
```

`uv run mypy src` (albo `pyright`, wbudowany w VS Code jako Pylance). Tryb
`strict = true` wymaga typów wszędzie — dobry dla nowego kodu.

### pre-commit

`przyklad/.pre-commit-config.yaml` uruchamia ruff przed każdym commitem:

```bash
uv tool install pre-commit
pre-commit install           # raz w repozytorium
pre-commit run --all-files   # ręcznie na całości
```

### CI — GitHub Actions

Plik `.github/workflows/testy.yml`:

```yaml
name: testy
on: [push, pull_request]
jobs:
  testy:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        python: ["3.10", "3.13"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v7
      - run: uv run --python ${{ matrix.python }} ruff check .
      - run: uv run --python ${{ matrix.python }} pytest
```

Ten kurs ma własne CI: `.github/workflows/kurs.yml` w repozytorium.

### Debugowanie i pomiar

- `breakpoint()` w kodzie zatrzymuje program w debuggerze (`n` — następna
  linia, `p zmienna`, `c` — dalej). W VS Code: czerwona kropka i F5.
- `logging` zamiast `print` w aplikacjach: poziomy, czas, wyłączanie bez
  usuwania kodu.
- Wydajność: **najpierw zmierz**. `python -m timeit`, `python -m cProfile -s
  cumtime skrypt.py`. Mierz kilka razy i bierz medianę — pojedynczy pomiar
  zakłóca wszystko, co akurat robi komputer.

## Zadanie praktyczne

```bash
cd lekcje/15_narzedzia_jakosci/przyklad
uv run --group dev pytest --cov=sklep --cov-report=term-missing
uv run --group dev ruff check .
uv run --group dev mypy src tests
```

Potem zepsuj coś w `src/sklep/ceny.py` (np. `//` → `/`) i zobacz, które
narzędzie to złapie.

## Ćwiczenia

1. `sprawdz_cene_z_rabatem(funkcja)` — napisz testy, które zabiją 6 mutantów.
2. `parsuj_ruff(tekst)` — wynik ruff w formacie concise, także ścieżki z Windows.
3. `podsumuj(uwagi)` — najczęstsze kody.
4. `parsuj_pytest(linia)` — linia podsumowania pytest → liczby.
5. `zakresy(linie)` i `procent_pokrycia(...)` — jak raport pokrycia.
6. `zmierz(funkcja, powtorzenia, zegar)` — mediana czasu.

## Podpowiedzi

- **cw1**: spisz umowę z docstringu i sprawdź każde zdanie osobno: zwykły przypadek, zaokrąglenie (`999` i `15%` → `849`), rabat `0` i `100`, rabat `101` i `-1`, cena ujemna. Do błędów użyj gotowej `oczekuj_bledu(ValueError, funkcja, 100, 101)`.
- **cw2**: `re.match(r"^(.+?):(\d+):(\d+): ([A-Z]+[0-9]+) (\[\*\] )?(.*)$", linia)` — leniwe `.+?` przepuszcza `C:` na początku ścieżki z Windows.
- **cw3**: `collections.Counter(u["kod"] for u in uwagi)`, potem `sorted(..., key=lambda para: (-para[1], para[0]))`.
- **cw4**: `re.findall(r"(\d+) (passed|failed|skipped|errors?|warnings?)", linia)`; czas: `re.search(r"in ([\d.]+)s", linia)`. `error` i `errors` to ten sam klucz.
- **cw5**: posortuj, idź po liczbach i zamykaj zakres, gdy następna liczba nie jest o 1 większa.
- **cw6**: `start = zegar()`, `funkcja()`, `czasy.append(zegar() - start)`; mediana: `statistics.median`.
