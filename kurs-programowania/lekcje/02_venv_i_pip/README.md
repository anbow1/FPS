# Lekcja 02 — Środowiska wirtualne (venv) i pip

Cel: każdy projekt ma własne, odtwarzalne zależności — i wiesz, który Python
właśnie uruchamiasz.

## Teoria

### Problem

Projekt A potrzebuje `pandas 1.5`, projekt B `pandas 2.2`. Instalując
globalnie, jeden z nich się zepsuje. **Środowisko wirtualne** (venv) to
osobny katalog z własnym `python` i własnymi pakietami — jeden na projekt.

### Tworzenie i aktywacja

PowerShell (Windows):

```powershell
python -m venv .venv                 # utwórz (raz)
.venv\Scripts\Activate.ps1           # aktywuj — prompt pokaże (.venv)
python -m pip install -r requirements.txt
deactivate                           # wyjdź
```

> Błąd „running scripts is disabled on this system”? Jednorazowo:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

bash / zsh (Linux, macOS, Git Bash):

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
deactivate
```

Aktywacja tylko zmienia `PATH`, by `python` wskazywał na `.venv`. Można też
bez aktywacji: `.venv\Scripts\python.exe kurs.py` (Windows) albo
`.venv/bin/python kurs.py`.

### Który Python działa?

```powershell
Get-Command python          # PowerShell
python -c "import sys; print(sys.executable)"
```

```bash
which python
```

W Pythonie: w venv `sys.prefix` (katalog venv) różni się od
`sys.base_prefix` (katalog „prawdziwej” instalacji).

### pip i plik requirements.txt

```text
# requirements.txt — komentarze po #
pandas>=2.0,<3          # zakres wersji
requests[socks]==2.32.3 # dokładna wersja + dodatek (extra)
tomli; python_version < "3.11"   # znacznik środowiska
-r requirements-dev.txt          # dołącz inny plik
```

| Polecenie | Co robi |
|---|---|
| `python -m pip install pandas` | instaluje najnowszą wersję |
| `python -m pip install "pandas>=2,<3"` | instaluje w zakresie |
| `python -m pip install -r requirements.txt` | instaluje wszystko z pliku |
| `python -m pip freeze > requirements.lock` | zapisuje *dokładne* wersje wszystkiego |
| `python -m pip list --outdated` | co można zaktualizować |
| `python -m pip uninstall pandas` | usuwa |

`python -m pip` zamiast gołego `pip` — gwarantuje pip *tego* Pythona, którego
widzisz.

### Wersje i specyfikatory

Wersje porównujemy **liczbowo po segmentach**: `1.10.0 > 1.9.2`, bo 10 > 9
(jako tekst byłoby odwrotnie!). `==`, `!=`, `>=`, `<=`, `>`, `<` łączymy
przecinkiem: `>=2.0,<3` znaczy „dowolna 2.x”. Konwencja SemVer:
`MAJOR.MINOR.PATCH` — zmiana MAJOR może psuć zgodność.

### Nazwy pakietów

`Scikit_Learn`, `scikit-learn` i `scikit.learn` to ten sam pakiet: pip
porównuje nazwy małymi literami, a ciągi `-`, `_`, `.` zamienia na jeden `-`
(standard PEP 503).

### Dobre praktyki

- `.venv/` zawsze w `.gitignore` — venv się odtwarza, nie commituje.
- Jeden venv na projekt, w katalogu projektu.
- Aplikacja: przypinaj dokładne wersje (plik lock). Biblioteka: podawaj zakresy.
- Nowocześniej: `pyproject.toml` + narzędzia jak `uv` (`uv venv`, `uv pip install`)
  — te same idee, dużo szybciej.

## Zadanie praktyczne (w terminalu)

W katalogu kursu utwórz venv, aktywuj go i zainstaluj `requirements.txt`.
Potem sprawdź: `python -c "import sys; print(sys.prefix != sys.base_prefix)"`
powinno wypisać `True`.

## Ćwiczenia

1. `czy_w_venv(prefix, base_prefix)`.
2. `sciezka_pythona(katalog_venv, system)` — `Scripts\python.exe` vs `bin/python`.
3. `komenda_aktywacji(powloka)` — PowerShell, cmd, bash.
4. `normalizuj_nazwe(nazwa)` — PEP 503.
5. `parsuj_requirements(tekst)` — nazwa → specyfikator.
6. `porownaj_wersje(a, b)` — -1 / 0 / 1.
7. `spelnia_warunek(wersja, warunek)` — np. `">=2.0,<3"`.

## Podpowiedzi

- **cw2**: `pathlib.PureWindowsPath` i `PurePosixPath` budują ścieżki dla danego systemu niezależnie od tego, na czym działasz.
- **cw4**: `re.sub(r"[-_.]+", "-", nazwa).lower()`.
- **cw5**: kolejno: utnij komentarz (`linia.split("#")[0]`), utnij znacznik (`split(";")[0]`), `strip()`, pomiń puste i zaczynające się od `-`. Nazwa kończy się na pierwszym znaku spoza `[A-Za-z0-9._-]`; extra `[...]` wyrzuć.
- **cw6**: zamień wersje na listy intów, dopełnij krótszą zerami (`1.0` == `1.0.0`) i porównaj listy — Python porównuje listy element po elemencie.
- **cw7**: rozdziel po przecinku; dla każdego fragmentu sprawdź najpierw dwuznakowe operatory (`>=`, `<=`, `==`, `!=`), potem jednoznakowe.
