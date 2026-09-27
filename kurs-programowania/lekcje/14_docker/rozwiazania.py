# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
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
    # ROZWIĄZANIE-START: lista linii, "\n".join(...) + "\n"
    if not re.fullmatch(r"\d+\.\d+", wersja_pythona):
        raise ValueError(f"wersja Pythona ma mieć postać X.Y, np. 3.12; dostałem '{wersja_pythona}'")
    linie = [
        f"FROM python:{wersja_pythona}-slim",
        "WORKDIR /app",
        "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1",
        "COPY requirements.txt .",
        "RUN pip install --no-cache-dir -r requirements.txt",
        "COPY . .",
        "RUN useradd --create-home aplikacja",
        "USER aplikacja",
    ]
    if port is not None:
        linie.append(f"EXPOSE {port}")
    linie.append(f'CMD ["python", {json.dumps(plik_startowy)}]')
    return "\n".join(linie) + "\n"
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: bufor na sklejaną instrukcję + numer jej pierwszej linii
    wynik: list[Instrukcja] = []
    bufor: list[str] = []
    poczatek = 0
    for numer, linia in enumerate(tekst.splitlines(), start=1):
        tresc = linia.strip()
        if not bufor and (not tresc or tresc.startswith("#")):
            continue
        if not bufor:
            poczatek = numer
        kontynuacja = tresc.endswith("\\")
        bufor.append(tresc.removesuffix("\\").strip())
        if not kontynuacja:
            wynik.append(_zamknij(poczatek, bufor))
            bufor = []
    if bufor:
        wynik.append(_zamknij(poczatek, bufor))
    return wynik


def _zamknij(poczatek: int, bufor: list[str]) -> Instrukcja:
    calosc = " ".join(fragment for fragment in bufor if fragment)
    instrukcja, _, argumenty = calosc.partition(" ")
    return poczatek, instrukcja.upper(), argumenty.strip()
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: pętla po instrukcje_dockerfile(tekst)
    instrukcje = instrukcje_dockerfile(tekst)
    uwagi: list[tuple[int, str]] = []
    etapy: set[str] = set()
    linia_copy_wszystko: int | None = None
    zgloszono_cache = False
    ma_user = False
    for numer, instrukcja, argumenty in instrukcje:
        slowa = argumenty.split()
        bez_flag = [slowo for slowo in slowa if not slowo.startswith("--")]
        if instrukcja == "FROM" and bez_flag:
            obraz = bez_flag[0]
            if len(bez_flag) >= 3 and bez_flag[1].upper() == "AS":
                etapy.add(bez_flag[2].lower())
            nazwa = obraz.split("/")[-1]
            bez_tagu = ":" not in nazwa or nazwa.endswith(":latest")
            if bez_tagu and "@" not in obraz and obraz.lower() not in etapy:
                uwagi.append((numer, "latest"))
        elif instrukcja == "ADD":
            uwagi.append((numer, "add"))
        elif instrukcja == "RUN":
            if "apt-get install" in argumenty and "/var/lib/apt/lists" not in argumenty:
                uwagi.append((numer, "apt"))
            if "pip install" in argumenty and linia_copy_wszystko is not None and not zgloszono_cache:
                uwagi.append((linia_copy_wszystko, "cache"))
                zgloszono_cache = True
        elif instrukcja in ("ENV", "ARG") and slowa:
            nazwy = [slowo.split("=")[0] for slowo in slowa if "=" in slowo] or [slowa[0]]
            if any(re.search(r"KEY|TOKEN|PASSWORD|SECRET", nazwa.upper()) for nazwa in nazwy):
                uwagi.append((numer, "sekret"))
        elif instrukcja == "COPY" and bez_flag == [".", "."] and linia_copy_wszystko is None:
            linia_copy_wszystko = numer
        elif instrukcja == "USER":
            ma_user = True
    if not ma_user:
        uwagi.append((0, "root"))
    return sorted(uwagi)
    # ROZWIĄZANIE-KONIEC


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
    # ROZWIĄZANIE-START: zaczynasz od ["docker", "run"] i dopisujesz
    komenda = ["docker", "run"]
    if usun_po_zakonczeniu:
        komenda.append("--rm")
    if w_tle:
        komenda.append("-d")
    if interaktywnie:
        komenda.append("-it")
    if nazwa:
        komenda += ["--name", nazwa]
    for port_hosta, port_kontenera in sorted((porty or {}).items()):
        komenda += ["-p", f"{port_hosta}:{port_kontenera}"]
    for zrodlo, cel in sorted((wolumeny or {}).items()):
        komenda += ["-v", f"{zrodlo}:{cel}"]
    for klucz, wartosc in sorted((zmienne or {}).items()):
        komenda += ["-e", f"{klucz}={wartosc}"]
    komenda.append(obraz)
    return komenda
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def parsuj_docker_ps(tekst: str) -> list[dict[str, Any]]:
    """Wynik `docker ps -a --format "{{json .}}"` (jeden JSON na linię) →
    [{"nazwa": Names, "obraz": Image, "dziala": Status zaczyna się od "Up", "porty": Ports}, ...].
    Puste linie pomijamy."""
    # ROZWIĄZANIE-START: json.loads każdej linii
    kontenery = []
    for linia in tekst.splitlines():
        if not linia.strip():
            continue
        dane = json.loads(linia)
        kontenery.append({
            "nazwa": dane["Names"],
            "obraz": dane["Image"],
            "dziala": dane["Status"].startswith("Up"),
            "porty": dane.get("Ports", ""),
        })
    return kontenery
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def podstaw_zmienne(tekst: str, zmienne: dict[str, str]) -> str:
    """Podstawia zmienne jak Docker Compose:

    - ${NAZWA}           → wartość; brak zmiennej → KeyError z nazwą,
    - ${NAZWA:-domyślna} → wartość, a gdy zmiennej brak LUB jest pusta — domyślna.
    Tekst bez ${...} zostaje bez zmian.
    """
    # ROZWIĄZANIE-START: re.sub z funkcją zamieniającą dopasowanie
    def zamien(dopasowanie: re.Match[str]) -> str:
        nazwa, domyslna = dopasowanie.group(1), dopasowanie.group(2)
        wartosc = zmienne.get(nazwa)
        if domyslna is not None:
            return wartosc if wartosc else domyslna
        if wartosc is None:
            raise KeyError(f"brak zmiennej {nazwa} (ustaw ją albo podaj wartość domyślną ${{{nazwa}:-...}})")
        return wartosc

    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}", zamien, tekst)
    # ROZWIĄZANIE-KONIEC
