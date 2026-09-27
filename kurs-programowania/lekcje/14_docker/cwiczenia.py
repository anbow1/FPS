# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.
# Sprawdzanie: python kurs.py sprawdz 14   (albo: python kurs.py obserwuj 14)
"""Lekcja 14 — Docker: generowanie, parsowanie i sprawdzanie Dockerfile, komendy docker."""

import json
import re
from typing import Any

KOMUNIKATY = {
    "latest": "przypnij wersję obrazu bazowego (bez tagu albo :latest obraz zmieni się bez ostrzeżenia)",
    "add": "używaj COPY zamiast ADD (ADD potrafi rozpakowywać i pobierać — niespodzianki)",
    "apt": "po apt-get install usuń /var/lib/apt/lists w tym samym RUN, obraz będzie mniejszy",
    "sekret": "nie wpisuj sekretów do obrazu — podaj je przy uruchomieniu (-e, --env-file)",
    "cache": "COPY . . przed instalacją zależności psuje cache warstw — najpierw requirements.txt",
    "root": "brak USER — kontener działa jako root",
}

Instrukcja = tuple[int, str, str]


# Ćwiczenie 1
def wygeneruj_dockerfile(wersja_pythona: str, plik_startowy: str, port: int | None = None) -> str:
    """Dockerfile z dobrymi praktykami. Dokładnie te linie (EXPOSE tylko gdy port podano):

        FROM python:<wersja>-slim
        WORKDIR /app
        ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
        COPY requirements.txt .
        RUN pip install --no-cache-dir -r requirements.txt
        COPY . .
        RUN useradd --create-home aplikacja
        USER aplikacja
        EXPOSE <port>
        CMD ["python", "<plik_startowy>"]

    Tekst kończy się znakiem nowej linii. Wersja inna niż "X.Y" (np. "3.12") → ValueError.
    """
    # Podpowiedź: lista linii, "\n".join(...) + "\n"
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 2
def instrukcje_dockerfile(tekst: str) -> list[Instrukcja]:
    """Dzieli Dockerfile na instrukcje: [(numer_pierwszej_linii, "INSTRUKCJA", "argumenty"), ...].

    - numeracja linii od 1,
    - puste linie i komentarze (# na początku) pomijamy,
    - linia kończąca się "\\" łączy się z następną: "\\" usuwamy, sklejamy spacją,
    - instrukcja wielkimi literami, argumenty bez spacji na brzegach.

    >>> instrukcje_dockerfile("from python:3.12\\nRUN a \\\\\\n    && b\\n")
    [(1, 'FROM', 'python:3.12'), (2, 'RUN', 'a && b')]
    """
    # Podpowiedź: bufor na sklejaną instrukcję + numer jej pierwszej linii
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 3
def sprawdz_dockerfile(tekst: str) -> list[tuple[int, str]]:
    """Mini-linter. Zwraca posortowaną listę (numer_linii, kod) — kody i opisy w KOMUNIKATY:

    - "latest": FROM z obrazem bez tagu albo z :latest (pomiń flagi "--..." przed obrazem;
                obraz z @sha256 jest OK; FROM odwołujący się do wcześniejszego etapu "AS nazwa" też),
    - "add":    każda instrukcja ADD,
    - "apt":    RUN z "apt-get install" bez "/var/lib/apt/lists" w tym samym RUN,
    - "sekret": ENV lub ARG definiujące zmienną, której nazwa zawiera KEY, TOKEN, PASSWORD lub SECRET,
    - "cache":  pierwsze COPY . . (flagi "--..." pomijamy), jeśli PÓŹNIEJ jest RUN z "pip install",
    - "root":   brak jakiejkolwiek instrukcji USER → (0, "root").
    """
    # Podpowiedź: pętla po instrukcje_dockerfile(tekst)
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 4
def zbuduj_komende_run(
    obraz: str,
    nazwa: str | None = None,
    porty: dict[int, int] | None = None,
    wolumeny: dict[str, str] | None = None,
    zmienne: dict[str, str] | None = None,
    w_tle: bool = False,
    interaktywnie: bool = False,
    usun_po_zakonczeniu: bool = True,
) -> list[str]:
    """Lista argumentów dla subprocess, w tej kolejności:

    docker run [--rm] [-d] [-it] [--name NAZWA] [-p HOST:KONTENER]... [-v ZRODLO:CEL]... [-e KLUCZ=WARTOSC]... OBRAZ

    porty: {port_hosta: port_kontenera}, sortowane po porcie hosta;
    wolumeny: {źródło: cel}, sortowane po źródle; zmienne sortowane po kluczu.
    """
    # Podpowiedź: zaczynasz od ["docker", "run"] i dopisujesz
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 5
def parsuj_docker_ps(tekst: str) -> list[dict[str, Any]]:
    """Wynik `docker ps -a --format "{{json .}}"` (jeden JSON na linię) →
    [{"nazwa": Names, "obraz": Image, "dziala": Status zaczyna się od "Up", "porty": Ports}, ...].
    Puste linie pomijamy."""
    # Podpowiedź: json.loads każdej linii
    raise NotImplementedError("Do zrobienia")


# Ćwiczenie 6
def podstaw_zmienne(tekst: str, zmienne: dict[str, str]) -> str:
    """Podstawia zmienne jak Docker Compose:

    - ${NAZWA}           → wartość; brak zmiennej → KeyError z nazwą,
    - ${NAZWA:-domyślna} → wartość, a gdy zmiennej brak LUB jest pusta — domyślna.
    Tekst bez ${...} zostaje bez zmian.
    """
    # Podpowiedź: re.sub z funkcją zamieniającą dopasowanie
    raise NotImplementedError("Do zrobienia")
