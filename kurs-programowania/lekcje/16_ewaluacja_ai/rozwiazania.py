# ROZWIĄZANIA: to plik z rozwiązaniami wzorcowymi. Zajrzyj dopiero po własnej próbie!
"""Lekcja 16 — ewaluacja aplikacji AI."""

import json
import math
import re
from collections.abc import Callable
from typing import Any

Przypadek = dict[str, Any]
Raport = dict[str, Any]
WYMAGANE_POLA = ("id", "wejscie", "oczekiwane")


# Ćwiczenie 1
def wczytaj_zestaw(tekst: str) -> list[Przypadek]:
    """Zestaw w formacie JSON Lines → lista przypadków.

    - puste linie pomijamy,
    - każdy przypadek musi mieć pola "id", "wejscie", "oczekiwane"; brak →
      ValueError z numerem linii (np. "linia 3: brak pola 'wejscie'"),
    - powtórzone id → ValueError,
    - brak "tagi" → [] (pozostałe pola zostają bez zmian).
    """
    # ROZWIĄZANIE-START: enumerate(..., start=1), json.loads, zbiór widzianych id
    przypadki = []
    widziane: set[str] = set()
    for numer, linia in enumerate(tekst.splitlines(), start=1):
        if not linia.strip():
            continue
        przypadek = json.loads(linia)
        for pole in WYMAGANE_POLA:
            if pole not in przypadek:
                raise ValueError(f"linia {numer}: brak pola '{pole}'")
        if przypadek["id"] in widziane:
            raise ValueError(f"linia {numer}: powtórzone id '{przypadek['id']}'")
        widziane.add(przypadek["id"])
        przypadki.append({"tagi": [], **przypadek})
    return przypadki
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 2
def normalizuj(tekst: str) -> str:
    """Małe litery, interpunkcja zamieniona na spacje, pojedyncze spacje, bez spacji na brzegach.

    >>> normalizuj("  Nie wiem!  ")
    'nie wiem'
    """
    # ROZWIĄZANIE-START: lower(), re.sub(r"[^\w\s]", " ", ...), " ".join(split())
    return " ".join(re.sub(r"[^\w\s]", " ", tekst.lower()).split())
    # ROZWIĄZANIE-KONIEC


def ocena_dokladna(odpowiedz: str, oczekiwane: str) -> bool:
    """Czy odpowiedź po normalizacji jest równa oczekiwanej po normalizacji."""
    # ROZWIĄZANIE-START
    return normalizuj(odpowiedz) == normalizuj(oczekiwane)
    # ROZWIĄZANIE-KONIEC


def ocena_liczbowa(odpowiedz: str, oczekiwana: float, tolerancja: float = 0.01) -> bool:
    """Pierwsza liczba w odpowiedzi jest równa oczekiwanej z tolerancją.

    Rozumie zapis polski i angielski: "15 zł", "1 234,56", "1234.56", "-3".
    Brak liczby → False.
    """
    # ROZWIĄZANIE-START: re.search, usuń spacje (także  ), "," → "."
    dopasowanie = re.search(r"-?\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?", odpowiedz)
    if dopasowanie is None:
        return False
    liczba = float(dopasowanie.group(0).replace(" ", "").replace(" ", "").replace(",", "."))
    return abs(liczba - oczekiwana) <= tolerancja
    # ROZWIĄZANIE-KONIEC


def ocena_zawiera(odpowiedz: str, wymagane: list[str], zakazane: list[str]) -> bool:
    """Po normalizacji: każda wymagana fraza występuje jako całe słowa, żadna zakazana nie występuje.

    "nie" pasuje do "Nie, nie wysyłamy", ale nie do "niestety".
    """
    # ROZWIĄZANIE-START: f" {fraza} " in f" {tekst} " daje granice słów
    tekst = f" {normalizuj(odpowiedz)} "

    def wystepuje(fraza: str) -> bool:
        return f" {normalizuj(fraza)} " in tekst

    return all(wystepuje(fraza) for fraza in wymagane) and not any(wystepuje(fraza) for fraza in zakazane)
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 3
def prompt_sedziego(pytanie: str, odpowiedz: str, kryteria: list[str]) -> str:
    """Prompt dla modelu-sędziego, dokładnie w tym układzie (linie łączone "\\n"):

        Oceń odpowiedź asystenta według kryteriów.
        (pusta linia)
        Pytanie: <pytanie>
        Odpowiedź: <odpowiedz>
        (pusta linia)
        Kryteria:
        - <kryterium 1>
        - <kryterium 2>
        (pusta linia)
        Zwróć wyłącznie JSON: {"ocena": <liczba 1-5>, "uzasadnienie": "<jedno zdanie>"}

    Brak kryteriów → ValueError (sędzia bez kryteriów ocenia „na oko”).
    """
    # ROZWIĄZANIE-START: lista linii + "\n".join
    if not kryteria:
        raise ValueError("podaj co najmniej jedno kryterium oceny")
    linie = ["Oceń odpowiedź asystenta według kryteriów.", "", f"Pytanie: {pytanie}", f"Odpowiedź: {odpowiedz}", "",
             "Kryteria:"]
    linie += [f"- {kryterium}" for kryterium in kryteria]
    linie += ["", 'Zwróć wyłącznie JSON: {"ocena": <liczba 1-5>, "uzasadnienie": "<jedno zdanie>"}']
    return "\n".join(linie)
    # ROZWIĄZANIE-KONIEC


def parsuj_werdykt(tekst: str) -> dict[str, Any]:
    """Wyciąga werdykt sędziego: {"ocena": int 1-5, "uzasadnienie": str}.

    JSON może być otoczony tekstem albo blokiem ```json … ```. Brak JSON-a,
    zły JSON, brak pól, ocena spoza 1–5 albo nie-int (także bool) → ValueError.
    """
    # ROZWIĄZANIE-START: tekst[tekst.find("{") : tekst.rfind("}") + 1]
    poczatek, koniec = tekst.find("{"), tekst.rfind("}")
    if poczatek == -1 or koniec < poczatek:
        raise ValueError(f"w odpowiedzi sędziego nie ma JSON-a: {tekst[:80]!r}")
    try:
        werdykt = json.loads(tekst[poczatek : koniec + 1])
    except json.JSONDecodeError as blad:
        raise ValueError(f"sędzia zwrócił niepoprawny JSON: {blad.msg}") from blad
    ocena = werdykt.get("ocena")
    if isinstance(ocena, bool) or not isinstance(ocena, int) or not 1 <= ocena <= 5:
        raise ValueError(f"ocena musi być liczbą całkowitą 1–5, jest {ocena!r}")
    if not isinstance(werdykt.get("uzasadnienie"), str):
        raise ValueError("brak uzasadnienia w werdykcie")
    return {"ocena": ocena, "uzasadnienie": werdykt["uzasadnienie"]}
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 4
def uruchom_eval(
    model: Callable[[str], str],
    przypadki: list[Przypadek],
    oceniacz: Callable[[str, Przypadek], bool],
) -> Raport:
    """Uruchamia model na każdym przypadku i ocenia odpowiedzi.

    Zwraca:
      {"wyniki": [{"id": ..., "zaliczony": bool, "odpowiedz": str}, ...],   (kolejność przypadków)
       "wynik": ułamek zaliczonych (0.0 dla pustego zestawu),
       "wg_tagow": {tag: ułamek zaliczonych wśród przypadków z tym tagiem}}
    Wyjątek modelu → przypadek niezaliczony, odpowiedz = "BŁĄD: <treść>"; eval idzie dalej.
    """
    # ROZWIĄZANIE-START: pętla z try/except wokół model(...)
    wyniki = []
    tagi: dict[str, list[bool]] = {}
    for przypadek in przypadki:
        try:
            odpowiedz = model(przypadek["wejscie"])
        except Exception as blad:  # jeden zepsuty przypadek nie może przerwać całego evala
            odpowiedz, zaliczony = f"BŁĄD: {blad}", False
        else:
            zaliczony = oceniacz(odpowiedz, przypadek)
        wyniki.append({"id": przypadek["id"], "zaliczony": zaliczony, "odpowiedz": odpowiedz})
        for tag in przypadek.get("tagi", []):
            tagi.setdefault(tag, []).append(zaliczony)
    zaliczone = sum(1 for wynik in wyniki if wynik["zaliczony"])
    return {
        "wyniki": wyniki,
        "wynik": zaliczone / len(wyniki) if wyniki else 0.0,
        "wg_tagow": {tag: sum(oceny) / len(oceny) for tag, oceny in tagi.items()},
    }
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 5
def porownaj(przed: Raport, po: Raport) -> dict[str, list[str]]:
    """{"regresje": id zaliczone przed, a niezaliczone po; "poprawy": odwrotnie} — posortowane.

    Raporty z różnymi zbiorami id → ValueError.
    """
    # ROZWIĄZANIE-START: słowniki id → zaliczony
    stan_przed = {wynik["id"]: wynik["zaliczony"] for wynik in przed["wyniki"]}
    stan_po = {wynik["id"]: wynik["zaliczony"] for wynik in po["wyniki"]}
    if stan_przed.keys() != stan_po.keys():
        rozne = sorted(stan_przed.keys() ^ stan_po.keys())
        raise ValueError(f"raporty dotyczą różnych przypadków: {rozne}")
    return {
        "regresje": sorted(i for i in stan_przed if stan_przed[i] and not stan_po[i]),
        "poprawy": sorted(i for i in stan_przed if not stan_przed[i] and stan_po[i]),
    }
    # ROZWIĄZANIE-KONIEC


# Ćwiczenie 6
def przedzial_wilsona(sukcesy: int, proby: int, z: float = 1.96) -> tuple[float, float]:
    """95% przedział ufności Wilsona dla odsetka sukcesów: (dolny, górny).

    proby < 1 albo sukcesy spoza 0..proby → ValueError.
    """
    # ROZWIĄZANIE-START: wzór z README
    if proby < 1 or not 0 <= sukcesy <= proby:
        raise ValueError(f"potrzeba 0 <= sukcesy <= proby i proby >= 1; dostałem {sukcesy}/{proby}")
    p = sukcesy / proby
    mianownik = 1 + z * z / proby
    srodek = (p + z * z / (2 * proby)) / mianownik
    promien = z * math.sqrt(p * (1 - p) / proby + z * z / (4 * proby * proby)) / mianownik
    # Przycięcie tylko usuwa błąd zaokrąglenia na brzegach (np. -2.8e-17 dla 0 sukcesów).
    return max(0.0, srodek - promien), min(1.0, srodek + promien)
    # ROZWIĄZANIE-KONIEC
