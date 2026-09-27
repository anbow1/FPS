# Lekcja 04 — Git

Cel: rozumiesz, *co* git przechowuje, robisz codzienny cykl
zmiana → commit → push, pracujesz na gałęziach i nie boisz się konfliktów.

## Teoria

### Model w głowie

- **Repozytorium** — katalog `.git` z całą historią projektu.
- **Commit** — migawka *wszystkich* śledzonych plików + autor, data, opis
  i wskaźnik na commit-rodzica. Identyfikuje go hash, np. `3f2a9c1`.
- Trzy miejsca, w których żyje plik:

```
katalog roboczy  --git add-->  poczekalnia (index/stage)  --git commit-->  historia
   (edytujesz)                  (co wejdzie do commita)                 (.git)
```

- **Gałąź (branch)** — ruchoma etykieta wskazująca na commit. `main` to
  zwykła gałąź. **HEAD** — „gdzie teraz jestem”.
- **Remote** (zwykle `origin`) — kopia repo na serwerze (GitHub, GitLab).

### Pierwsza konfiguracja (raz na komputer)

```bash
git config --global user.name "Imię Nazwisko"
git config --global user.email "ty@example.com"
git config --global init.defaultBranch main
```

### Codzienny cykl

```bash
git status                  # co się zmieniło? (czytaj często!)
git diff                    # zmiany jeszcze nie dodane
git add plik.py             # do poczekalni (git add . = wszystko)
git diff --staged           # co wejdzie do commita
git commit -m "feat: dodaj licznik słów"
git log --oneline --graph   # historia
git push                    # wyślij na serwer
git pull                    # pobierz i scal zmiany innych
```

`git status --porcelain` wypisuje stan w stałym formacie dla programów:
dwie litery `XY` i ścieżka. `X` = poczekalnia, `Y` = katalog roboczy:

```
M  kurs.py        # zmieniony i dodany (X=M)
 M README.md      # zmieniony, NIE dodany (Y=M)
A  nowy.py        # nowy plik dodany
 D stary.py       # usunięty, nie dodany
R  a.py -> b.py   # zmiana nazwy
?? notatki.txt    # nieśledzony
```

### Gałęzie i scalanie

```bash
git switch -c feature/logowanie    # nowa gałąź i przejście na nią
# ...commity...
git switch main
git merge feature/logowanie        # scal do main
git branch -d feature/logowanie    # usuń scaloną gałąź
```

W zespole zamiast lokalnego `merge` robi się **Pull Request**: pushujesz
gałąź (`git push -u origin feature/logowanie`), a na GitHubie ktoś przegląda
zmiany i je scala.

### Konflikty

Gdy dwie gałęzie zmieniły te same linie, git wstawia znaczniki:

```text
<<<<<<< HEAD
kolor = "niebieski"
=======
kolor = "zielony"
>>>>>>> feature/kolory
```

Górna część to *nasza* wersja (HEAD), dolna — *ich* (scalana gałąź).
Edytujesz plik do postaci docelowej, usuwasz znaczniki, potem
`git add plik` i `git commit`. Spokojnie — `git merge --abort` cofa
całe scalanie.

### Cofanie

| Chcę… | Polecenie |
|---|---|
| wyrzucić niezapisane zmiany w pliku | `git restore plik.py` |
| wyjąć plik z poczekalni | `git restore --staged plik.py` |
| poprawić opis ostatniego (niewypchniętego) commita | `git commit --amend` |
| cofnąć commit, który już jest na serwerze | `git revert <hash>` (nowy commit-odwrotność) |
| schować zmiany na chwilę | `git stash` / `git stash pop` |

Nie przepisuj historii, którą już wypchnąłeś (`reset --hard` + `push --force`)
— inni mają ją u siebie.

### .gitignore

```text
.venv/
__pycache__/
.env          # sekrety NIGDY do gita
*.db
```

### Dobre wiadomości commitów

Konwencja **Conventional Commits**: `typ(zakres): opis` w trybie rozkazującym,
pierwsza linia do ~72 znaków, pusta linia, potem *dlaczego*.

```text
fix(api): ponawiaj zapytanie po błędzie 429

Serwer ogranicza liczbę zapytań; bez ponowień import przerywał się w połowie.
```

Typy: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `build`,
`ci`, `perf`. `!` po typie (`feat!:`) oznacza zmianę łamiącą zgodność.

## Zadanie praktyczne (w terminalu)

```bash
mkdir proba-gita && cd proba-gita
git init
echo "kolor = niebieski" > ustawienia.txt
git add ustawienia.txt && git commit -m "feat: ustawienia"
git switch -c zielony
echo "kolor = zielony" > ustawienia.txt && git commit -am "feat: zielony"
git switch main
echo "kolor = czerwony" > ustawienia.txt && git commit -am "feat: czerwony"
git merge zielony          # konflikt! otwórz plik, rozwiąż, git add, git commit
git log --oneline --graph --all
```

(W PowerShellu `&&` działa od wersji 7; w starszej rozdziel polecenia na linie.)

## Ćwiczenia

1. `parsuj_status(porcelain)` — co jest w poczekalni, co zmienione, co nowe.
2. `czy_poprawny_commit(wiadomosc)` — walidator Conventional Commits.
3. `parsuj_log(tekst)` — wynik `git log --oneline` jako lista par.
4. `nazwa_galezi(opis, typ)` — „Dodaj logowanie przez Google!” → `feature/dodaj-logowanie-przez-google`.
5. `rozwiaz_konflikt(tekst, strona)` — rozwiązanie konfliktu programem.
6. `utworz_repo(katalog)` — prawdziwy `git init` + commit przez subprocess.

## Podpowiedzi

- **cw1**: `linia[0]` to X, `linia[1]` to Y, ścieżka od `linia[3:]`. Przy `R` weź część po `" -> "`. Najpierw obsłuż `??`.
- **cw2**: wyrażenie regularne `^(feat|fix|...)(\([a-z0-9-]+\))?!?: \S.*$` dla pierwszej linii; potem sprawdź długość i pustą drugą linię.
- **cw3**: `linia.split(" ", 1)` → hash i opis.
- **cw4**: zamień polskie znaki (`str.maketrans("ąćęłńóśźż", "acelnoszz")` — pamiętaj też o wielkich literach, albo najpierw `lower()`), potem `re.sub(r"[^a-z0-9]+", "-", ...)` i `strip("-")`.
- **cw5**: idź linia po linii ze stanem: `poza`, `nasza`, `ich`. Znaczniki zaczynają się od `<<<<<<<`, `=======`, `>>>>>>>`.
- **cw6**: każdą komendę uruchamiaj jako listę z `cwd=katalog`. Do commita dodaj `-c user.name=Kurs -c user.email=kurs@example.com`, żeby działało bez globalnej konfiguracji. Hash: `git rev-parse HEAD`.
