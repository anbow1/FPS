# Interaktywny kurs programowania

Od podstaw Pythona do agentów AI: terminal, git, JSON, SQL, pandas, API,
tool calling, pętle i grafy, embeddingi, RAG, MCP, Docker i venv.
Każda lekcja to krótka teoria, ćwiczenia sprawdzane automatycznie testami,
podpowiedzi i quiz. Całość działa na Windows, macOS i Linuksie, a poza jedną
lekcją (pandas) — na samej bibliotece standardowej Pythona.

## Start (5 minut)

Potrzebujesz Pythona 3.10+ ([python.org](https://www.python.org/downloads/);
na Windows zaznacz „Add python.exe to PATH”) i dowolnego edytora (polecam VS Code).

PowerShell (Windows):

```powershell
cd kurs-programowania
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python kurs.py
```

bash (Linux, macOS):

```bash
cd kurs-programowania
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python kurs.py
```

Co tu się dzieje, wyjaśnia lekcja 02. Jeśli PowerShell nie pozwala uruchomić
`Activate.ps1`: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Jak się uczyć

```
python kurs.py dalej            # co teraz? — pierwsza niezaliczona lekcja
python kurs.py czytaj 1         # teoria (albo otwórz lekcje/01_.../README.md w edytorze)
python kurs.py obserwuj 1       # zostaw w drugim oknie: sprawdza po każdym zapisie pliku
python kurs.py podpowiedz 1     # utknąłeś?
python kurs.py quiz 1           # 4 pytania na koniec
python kurs.py lista            # Twój postęp
```

Cykl pracy nad lekcją:

1. Przeczytaj teorię.
2. Otwórz `lekcje/NN_.../cwiczenia.py`. Każda funkcja ma opis i przykłady,
   a w środku `raise NotImplementedError` — zamień to na swój kod.
3. Po zapisie pliku `obserwuj` pokaże wynik: ✔ zaliczony, ✘ błąd (z komunikatem
   i linią), … jeszcze nie napisany.
4. Wszystko zielone → quiz → następna lekcja.

Rozwiązania wzorcowe są w `rozwiazania.py` każdej lekcji
(`python kurs.py rozwiazanie N` zapyta, czy na pewno). Zajrzyj po własnej
próbie — porównanie z inną wersją to świetna nauka.

## Program

| # | Lekcja | Czego się nauczysz |
|---|---|---|
| 01 | [Podstawy Pythona](lekcje/01_python_podstawy/README.md) | typy, kolekcje, pętle, funkcje, wyjątki, klasy, czytanie tracebacków |
| 02 | [venv i pip](lekcje/02_venv_i_pip/README.md) | środowiska wirtualne, requirements.txt, wersje i specyfikatory |
| 03 | [Terminal i CLI](lekcje/03_cli/README.md) | PowerShell i bash, stdin/stdout/stderr, kody wyjścia, argparse, subprocess, .env |
| 04 | [Git](lekcje/04_git/README.md) | commit, poczekalnia, gałęzie, konflikty, cofanie, Conventional Commits |
| 05 | [JSON](lekcje/05_json/README.md) | składnia, mapowanie typów, walidacja, zagnieżdżone dane, JSON Lines |
| 06 | [SQL](lekcje/06_sql/README.md) | tabele, JOIN, GROUP BY, transakcje, SQL injection (SQLite) |
| 07 | [pandas](lekcje/07_pandas/README.md) | DataFrame, filtrowanie, braki danych, groupby, tabele przestawne, daty |
| 08 | [HTTP i REST API](lekcje/08_api_http/README.md) | metody i statusy, curl, klucze API, ponowienia z backoffem, paginacja |
| 09 | [Tool calling](lekcje/09_tool_calling/README.md) | jak model AI wywołuje narzędzia, format wiadomości API Claude'a, pętla agenta |
| 10 | [Pętle i grafy](lekcje/10_petle_i_grafy/README.md) | generatory, zbieżność, BFS, sortowanie topologiczne, graf stanów agenta |
| 11 | [Embeddingi](lekcje/11_embeddingi/README.md) | wektory znaczeń, cosinus, worek słów, TF-IDF, hashing trick, top-k |
| 12 | [RAG](lekcje/12_rag/README.md) | chunking, indeks, wyszukiwanie, prompt z cytowaniami, recall@k |
| 13 | [MCP](lekcje/13_mcp/README.md) | JSON-RPC, cykl życia sesji, własny serwer MCP, podłączenie do Claude Code |
| 14 | [Docker](lekcje/14_docker/README.md) | obraz i kontener, Dockerfile, warstwy, wolumeny, Compose, własny linter |

Lekcje 09–13 budują jedna na drugiej: narzędzia → pętla agenta → graf stanów,
embeddingi → RAG, narzędzia → MCP. Klucz API **nie jest potrzebny** — model
w ćwiczeniach udaje atrapa zwracająca odpowiedzi w dokładnie takim kształcie
jak prawdziwe API. Przykłady z prawdziwym Claude'em (`przyklad_claude.py`,
`demo_rag.py --claude`) są opcjonalne: `python -m pip install -r requirements-extra.txt`
i zmienna `ANTHROPIC_API_KEY`.

## Kurs w Dockerze

Bez instalowania Pythona (potrzebny Docker, lekcja 14):

```powershell
docker build -t kurs-programowania .
docker run -it --rm -v "${PWD}:/kurs" kurs-programowania          # PowerShell
```

```bash
docker run -it --rm -v "$(pwd):/kurs" --user "$(id -u):$(id -g)" kurs-programowania   # Linux
```

Montowanie katalogu (`-v`) sprawia, że edytujesz pliki na swoim komputerze,
a postęp zapisuje się w `.postep.json` obok nich. Na Linuksie `--user` pozwala
kontenerowi zapisywać pliki z Twoimi uprawnieniami.

## Budowa repozytorium

```
kurs.py                 # punkt startowy: menu i komendy
silnik/                 # wyszukiwanie lekcji, uruchamianie testów, postęp, quizy, generator ćwiczeń
lekcje/NN_nazwa/
    README.md           # teoria, ćwiczenia, podpowiedzi
    cwiczenia.py        # tu piszesz
    rozwiazania.py      # rozwiązania wzorcowe
    test_cwiczenia.py   # testy (unittest)
    quiz.json           # pytania quizu
testy_kursu/            # testy samego silnika
```

### Dla autorów

`cwiczenia.py` powstaje automatycznie z `rozwiazania.py`: kod między
`# ROZWIĄZANIE-START` a `# ROZWIĄZANIE-KONIEC` zamienia się w
`raise NotImplementedError`.

```bash
python -m silnik.generator                         # przegeneruj cwiczenia.py (nadpisuje!)
python -m silnik.generator --sprawdz               # czy są aktualne
python kurs.py sprawdz --wszystkie --rozwiazania   # czy rozwiązania przechodzą testy
python -m unittest discover -s testy_kursu -t .    # testy silnika
```

CI (`.github/workflows/kurs.yml`) uruchamia to wszystko na Windows i Linuksie.
