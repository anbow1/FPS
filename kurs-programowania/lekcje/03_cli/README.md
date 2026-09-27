# Lekcja 03 — Terminal i narzędzia wiersza poleceń (CLI)

Cel: swobodnie poruszasz się w terminalu (PowerShell i bash) i piszesz własne
narzędzie CLI w Pythonie: argumenty, wejście/wyjście, kody wyjścia.

## Teoria

### Terminal w 5 minut

| Zadanie | PowerShell | bash |
|---|---|---|
| gdzie jestem | `Get-Location` (`pwd`) | `pwd` |
| lista plików | `Get-ChildItem` (`ls`, `dir`) | `ls -la` |
| zmiana katalogu | `cd lekcje` / `cd ..` | `cd lekcje` / `cd ..` |
| nowy katalog | `mkdir nowy` | `mkdir -p nowy` |
| pusty plik | `New-Item plik.txt` | `touch plik.txt` |
| pokaż plik | `Get-Content plik.txt` (`cat`) | `cat plik.txt` |
| kopiuj / przenieś | `Copy-Item a b` / `Move-Item a b` | `cp a b` / `mv a b` |
| usuń | `Remove-Item plik` | `rm plik` |
| szukaj tekstu | `Select-String "def" *.py` | `grep -n "def" *.py` |
| zmienna środowiskowa | `$env:API_KEY = "..."` | `export API_KEY=...` |
| odczyt zmiennej | `$env:API_KEY` | `echo $API_KEY` |
| kod wyjścia ostatniej komendy | `$LASTEXITCODE` | `echo $?` |

Skróty: **Tab** dopełnia nazwy, **↑** przywraca poprzednie polecenia,
**Ctrl+C** przerywa program, **Ctrl+R** (bash, PS 7) szuka w historii.

### Strumienie i potoki

Każdy program ma trzy strumienie: **stdin** (wejście), **stdout** (wynik),
**stderr** (błędy i diagnostyka). Dzięki temu można je łączyć:

```bash
cat dane.txt | python licznik.py -l     # potok: stdout jednego → stdin drugiego
python licznik.py *.md > wynik.txt      # przekierowanie stdout do pliku (>> dopisuje)
python licznik.py brak.txt 2> bledy.txt # przekierowanie stderr
```

W PowerShellu działa tak samo (`Get-Content dane.txt | python licznik.py -l`).
Zasada: **wynik na stdout, komunikaty o błędach na stderr** — wtedy przekierowany
wynik nie jest zaśmiecony.

### Kod wyjścia

Program kończy się liczbą: `0` = sukces, cokolwiek innego = błąd (umownie `1`
błąd ogólny, `2` złe argumenty). Skrypty i CI (np. GitHub Actions) patrzą
właśnie na ten kod. W Pythonie: `sys.exit(kod)`.

### Argumenty w Pythonie: sys.argv i argparse

```python
import sys
print(sys.argv)   # python skrypt.py a -v  →  ['skrypt.py', 'a', '-v']
```

Ręczne parsowanie szybko robi się bolesne. `argparse` (biblioteka standardowa)
robi to za nas, łącznie z `--help` i komunikatami błędów:

```python
import argparse

parser = argparse.ArgumentParser(prog="powitaj", description="Wita ludzi.")
parser.add_argument("imiona", nargs="+", help="kogo przywitać")        # pozycyjny, 1 lub więcej
parser.add_argument("-g", "--glosno", action="store_true", help="WIELKIMI LITERAMI")
parser.add_argument("--razy", type=int, default=1)
opcje = parser.parse_args(["Ala", "Olek", "-g"])
opcje.imiona, opcje.glosno, opcje.razy    # (['Ala', 'Olek'], True, 1)
```

`nargs`: `"?"` (0 lub 1), `"*"` (0 lub więcej), `"+"` (1 lub więcej).

### Szkielet porządnego narzędzia

```python
def main(argumenty: list[str], wejscie: TextIO, wyjscie: TextIO, bledy: TextIO) -> int:
    ...
    return 0

if __name__ == "__main__":          # tylko przy uruchomieniu, nie przy imporcie
    sys.exit(main(sys.argv[1:], sys.stdin, sys.stdout, sys.stderr))
```

Strumienie jako parametry = łatwe testy (podstawiamy `io.StringIO`).

### Uruchamianie innych programów: subprocess

```python
import subprocess
wynik = subprocess.run(["git", "--version"], capture_output=True, text=True)
wynik.returncode, wynik.stdout
```

Podawaj komendę jako **listę** — bez `shell=True`. Wtedy spacje i znaki
specjalne w argumentach nie zamienią się w lukę bezpieczeństwa.

### Plik .env

Sekrety (klucze API) trzymamy w zmiennych środowiskowych albo w pliku `.env`
(zawsze w `.gitignore`!):

```text
# .env
ANTHROPIC_API_KEY=sk-ant-...
export BAZA_URL="sqlite:///dane.db"
```

## Ćwiczenia

1. `policz(tekst)` — jak uniksowe `wc`: linie, słowa, znaki.
2. `zbuduj_parser()` — argparse dla narzędzia `licznik`.
3. `main(...)` — całe narzędzie: pliki albo stdin, kody wyjścia, stderr.
   Wypróbuj: `python cwiczenia.py README.md -l` (w katalogu lekcji).
4. `parsuj_env(tekst)` — wczytanie pliku `.env`.
5. `uruchom(komenda)` — subprocess, kod wyjścia i stdout.

## Podpowiedzi

- **cw1**: `len(tekst.splitlines())`, `len(tekst.split())`, `len(tekst)`.
- **cw2**: `add_argument("pliki", nargs="*")` i trzy flagi `action="store_true"`: `-l/--linie`, `-w/--slowa`, `-c/--znaki`.
- **cw3**: `opcje = zbuduj_parser().parse_args(argumenty)`. Jeśli żadna flaga nie jest ustawiona — pokaż wszystkie trzy liczby. Plik czytaj przez `Path(nazwa).read_text(encoding="utf-8")`, łap `FileNotFoundError`, pisz komunikat do `bledy` i zapamiętaj, że kod wyjścia to 1. Do strumienia piszesz `print(..., file=wyjscie)`.
- **cw4**: `linia.partition("=")` dzieli na (klucz, "=", wartość). `removeprefix("export ")`. Cudzysłowy: jeśli wartość zaczyna się i kończy tym samym `"` lub `'`, obetnij je.
- **cw5**: `subprocess.run(komenda, capture_output=True, text=True)` i zwróć `(wynik.returncode, wynik.stdout)`.
