# Lekcja 14 — Docker

Cel: rozumiesz obraz, kontener, warstwy i wolumeny; piszesz dobry
Dockerfile, uruchamiasz aplikację w kontenerze i składasz kilka usług
w Docker Compose.

> Potrzebujesz Dockera: na Windows **Docker Desktop** (z WSL 2), na Linuksie
> pakiet Docker Engine. Sprawdzenie: `docker run --rm hello-world`.
> Ćwiczenia w Pythonie działają bez Dockera.

## Teoria

### Po co?

„U mnie działa” — bo u Ciebie jest Python 3.12, właściwe biblioteki systemowe
i zmienne środowiskowe. Kontener pakuje aplikację **razem ze środowiskiem**:
system plików (lekki Linux), Python, zależności, konfigurację. Ten sam obraz
działa na laptopie, w CI i na serwerze.

**venv a Docker**: venv izoluje *pakiety Pythona* w obrębie Twojego systemu
(lekcja 02). Docker izoluje *cały system* — łącznie z wersją Pythona i
bibliotekami C. Często używa się obu: venv przy codziennej pracy, Docker do
wdrożenia.

### Obraz i kontener

- **Obraz** (image) — przepis zamrożony w plik: warstwy systemu plików +
  metadane. Niezmienny. Jak klasa.
- **Kontener** — uruchomiony obraz z własnym procesem i cienką warstwą
  zapisu. Jak obiekt. Z jednego obrazu — wiele kontenerów.
- **Rejestr** — magazyn obrazów (Docker Hub, GitHub Container Registry).

### Dockerfile — przepis na obraz

Zobacz `przyklad/Dockerfile`:

| Instrukcja | Co robi |
|---|---|
| `FROM python:3.12-slim` | obraz bazowy (przypnij wersję!) |
| `WORKDIR /app` | katalog roboczy |
| `COPY src dst` | kopiuje pliki z kontekstu budowania |
| `RUN polecenie` | wykonuje polecenie **podczas budowania** (nowa warstwa) |
| `ENV KLUCZ=wartość` | zmienna środowiskowa |
| `EXPOSE 8000` | dokumentuje port (nie otwiera go!) |
| `USER aplikacja` | dalej jako zwykły użytkownik, nie root |
| `CMD ["python", "app.py"]` | co uruchomić **przy starcie kontenera** |

### Warstwy i cache

Każda instrukcja to warstwa. Docker przebudowuje od pierwszej zmienionej
warstwy w dół. Dlatego:

```dockerfile
COPY requirements.txt .                  # zmienia się rzadko
RUN pip install -r requirements.txt      # → ta ciężka warstwa zwykle z cache
COPY . .                                 # kod zmienia się często — na końcu
```

Odwrotna kolejność (`COPY . .` przed `pip install`) = instalacja wszystkich
zależności przy każdej zmianie przecinka w kodzie.

`.dockerignore` (jak `.gitignore`) wyklucza z kontekstu `.venv`, `.git`,
`__pycache__`, **`.env`**.

### Polecenia

```bash
docker build -t moja-app:1.0 .                 # zbuduj obraz z Dockerfile w bieżącym katalogu
docker images                                  # lista obrazów
docker run --rm -p 8000:8000 moja-app:1.0      # uruchom (host:kontener), usuń po zatrzymaniu
docker run -d --name app -p 8000:8000 moja-app:1.0   # w tle (detached)
docker ps                                      # działające kontenery (-a: także zatrzymane)
docker logs -f app                             # logi (stdout/stderr procesu)
docker exec -it app bash                       # powłoka wewnątrz działającego kontenera
docker stop app && docker rm app
docker system df                               # ile miejsca zajmują obrazy/kontenery
```

Wewnątrz kontenera serwer musi słuchać na `0.0.0.0`, nie `127.0.0.1` —
inaczej przekierowany port nie dotrze do aplikacji.

### Dane: wolumeny i montowanie

System plików kontenera znika razem z kontenerem. Trwałe dane:

```bash
docker volume create dane
docker run -v dane:/dane moja-app:1.0                  # nazwany wolumen (zarządza Docker)
docker run -v "${PWD}/dane:/dane" moja-app:1.0         # katalog z hosta (PowerShell)
docker run -v "$(pwd)/dane:/dane" moja-app:1.0         # to samo w bash
```

### Konfiguracja i sekrety

```bash
docker run -e POWITANIE="Hej" --env-file .env moja-app:1.0
```

Nigdy `ENV API_KEY=...` w Dockerfile — obraz z sekretem wycieka razem z nim
(`docker history` pokaże wszystko). Sekrety podawaj przy uruchomieniu.

### Docker Compose

Kilka usług (aplikacja + baza + cache) opisanych w jednym pliku — zobacz
`przyklad/compose.yaml`:

```bash
docker compose up --build      # zbuduj i uruchom wszystko
docker compose up -d           # w tle
docker compose logs -f app
docker compose down            # zatrzymaj i usuń kontenery (wolumeny zostają; -v usuwa też je)
```

Compose podstawia zmienne: `${POWITANIE}` z otoczenia albo pliku `.env`,
`${POWITANIE:-domyślna}` z wartością domyślną.

## Zadanie praktyczne

```bash
cd lekcje/14_docker/przyklad
docker build -t licznik:1.0 .
docker run --rm -p 8000:8000 licznik:1.0      # otwórz http://localhost:8000, odśwież kilka razy
# Ctrl+C, uruchom ponownie — licznik od 1. Teraz z wolumenem:
docker run --rm -p 8000:8000 -v licznik-dane:/dane licznik:1.0
docker compose up --build
```

Bonus: cały ten kurs też ma `Dockerfile` (w katalogu głównym kursu) —
zobacz instrukcję w głównym README.

## Ćwiczenia

1. `wygeneruj_dockerfile(wersja_pythona, plik_startowy, port)` — dobre praktyki w szablonie.
2. `instrukcje_dockerfile(tekst)` — parsowanie z kontynuacją linii `\`.
3. `sprawdz_dockerfile(tekst)` — własny „linter” wykrywający typowe błędy.
4. `zbuduj_komende_run(...)` — lista argumentów dla `docker run`.
5. `parsuj_docker_ps(tekst)` — wynik `docker ps --format "{{json .}}"`.
6. `podstaw_zmienne(tekst, zmienne)` — podstawianie `${X}` i `${X:-domyślna}` jak Compose.

## Podpowiedzi

- **cw1**: zbuduj listę linii i połącz `"\n".join(linie) + "\n"`. Wersję sprawdź `re.fullmatch(r"\d+\.\d+", ...)`.
- **cw2**: skleja linie kończące się `\` z następną (bez `\`, ze spacją). Pomiń puste i komentarze. Instrukcja to pierwsze słowo (`upper()`), argumenty — reszta po `strip()`.
- **cw3**: przejdź po wyniku ćw. 2. Zapamiętaj numer linii pierwszego `COPY . .` i pierwszego `RUN` z `pip install`. `USER` sprawdzasz na końcu. Sekrety: `re.search(r"KEY|TOKEN|PASSWORD|SECRET", nazwa.upper())`.
- **cw4**: zaczynasz od `["docker", "run"]`, potem flagi w podanej kolejności, pętle po `sorted(slownik.items())`, obraz na końcu.
- **cw5**: każda linia to osobny JSON (`json.loads`). Działa, jeśli `Status` zaczyna się od `"Up"`.
- **cw6**: `re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}", funkcja, tekst)` — funkcja dostaje dopasowanie; `dopasowanie.group(1)` to nazwa, `group(2)` wartość domyślna albo `None`.
