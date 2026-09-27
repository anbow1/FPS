"""Narzędzie autora kursu: robi cwiczenia.py z rozwiazania.py.

W rozwiązaniach kod, który pisze uczeń, stoi między znacznikami:

    # ROZWIĄZANIE-START: opcjonalna podpowiedź
    ...kod...
    # ROZWIĄZANIE-KONIEC

W ćwiczeniach ten blok zamienia się w `raise NotImplementedError`, a
podpowiedź w komentarz. Linie zaczynające się od "# ROZWIĄZANIA:" to nagłówek
tylko dla pliku z rozwiązaniami i znikają.

Użycie (z katalogu kursu):
    python -m silnik.generator            # nadpisuje cwiczenia.py we wszystkich lekcjach
    python -m silnik.generator --sprawdz  # tylko sprawdza, czy są aktualne (CI)

Uwaga: nadpisanie kasuje to, co uczeń wpisał w cwiczenia.py. To narzędzie dla autorów.
"""

import argparse
import sys

from silnik.lekcje import Lekcja, wszystkie_lekcje

ZNACZNIK_START = "# ROZWIĄZANIE-START"
ZNACZNIK_KONIEC = "# ROZWIĄZANIE-KONIEC"
ZNACZNIK_NAGLOWKA = "# ROZWIĄZANIA:"


def wygeneruj_cwiczenia(tekst_rozwiazan: str, kod_lekcji: str) -> str:
    wynik = [
        "# Ćwiczenia — uzupełnij miejsca z `raise NotImplementedError`.\n",
        f"# Sprawdzanie: python kurs.py sprawdz {kod_lekcji}   (albo: python kurs.py obserwuj {kod_lekcji})\n",
    ]
    w_bloku = False
    for numer, linia in enumerate(tekst_rozwiazan.splitlines(keepends=True), start=1):
        bez_wciecia = linia.strip()
        if bez_wciecia.startswith(ZNACZNIK_NAGLOWKA):
            continue
        if bez_wciecia.startswith(ZNACZNIK_START):
            if w_bloku:
                raise ValueError(f"linia {numer}: {ZNACZNIK_START} wewnątrz niezamkniętego bloku")
            wciecie = linia[: len(linia) - len(linia.lstrip())]
            podpowiedz = bez_wciecia[len(ZNACZNIK_START) :].lstrip(":").strip()
            if podpowiedz:
                wynik.append(f"{wciecie}# Podpowiedź: {podpowiedz}\n")
            wynik.append(f'{wciecie}raise NotImplementedError("Do zrobienia")\n')
            w_bloku = True
        elif bez_wciecia == ZNACZNIK_KONIEC:
            if not w_bloku:
                raise ValueError(f"linia {numer}: {ZNACZNIK_KONIEC} bez {ZNACZNIK_START}")
            w_bloku = False
        elif not w_bloku:
            wynik.append(linia)
    if w_bloku:
        raise ValueError(f"brak {ZNACZNIK_KONIEC} na końcu pliku")
    return "".join(wynik)


def oczekiwane_cwiczenia(lekcja: Lekcja) -> str:
    return wygeneruj_cwiczenia(lekcja.rozwiazania.read_text(encoding="utf-8"), lekcja.kod)


def main(argumenty: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generuje cwiczenia.py z rozwiazania.py.")
    parser.add_argument("--sprawdz", action="store_true", help="nic nie zapisuj, tylko porównaj")
    opcje = parser.parse_args(argumenty)
    nieaktualne = []
    for lekcja in wszystkie_lekcje():
        oczekiwane = oczekiwane_cwiczenia(lekcja)
        obecne = lekcja.cwiczenia.read_text(encoding="utf-8") if lekcja.cwiczenia.exists() else ""
        if obecne == oczekiwane:
            continue
        if opcje.sprawdz:
            nieaktualne.append(lekcja.katalog.name)
        else:
            lekcja.cwiczenia.write_text(oczekiwane, encoding="utf-8")
            print(f"zapisano {lekcja.katalog.name}/cwiczenia.py")
    if nieaktualne:
        print("Nieaktualne cwiczenia.py (uruchom: python -m silnik.generator):", ", ".join(nieaktualne))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
