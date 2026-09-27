"""Interaktywny kurs programowania — punkt startowy.

    python kurs.py                 # menu
    python kurs.py lista           # lekcje i Twój postęp
    python kurs.py czytaj 1        # teoria lekcji 1
    python kurs.py sprawdz 1       # sprawdź swoje ćwiczenia
    python kurs.py obserwuj 1      # sprawdzaj automatycznie po każdym zapisie pliku
    python kurs.py podpowiedz 1    # podpowiedzi do ćwiczeń
    python kurs.py quiz 1          # szybki quiz
    python kurs.py rozwiazanie 1   # pokaż rozwiązanie (dopiero po próbie!)
    python kurs.py dalej           # pierwsza niezaliczona lekcja
"""

import argparse
import os
import sys
import time

from silnik import postep, quiz
from silnik.lekcje import Lekcja, sekcja_readme, wszystkie_lekcje, znajdz_lekcje
from silnik.sprawdzanie import BLAD, DO_ZROBIENIA, OK, POMINIETY, WynikLekcji, sprawdz_lekcje

IKONY = {OK: "✔", BLAD: "✘", DO_ZROBIENIA: "…", POMINIETY: "○"}
# Dłuższe komunikaty przycinamy: początek mówi, co się stało, koniec — gdzie.
MAKS_LINII_KOMUNIKATU = 8
ODSTEP_OBSERWOWANIA_SEKUNDY = 1.0


def main(argumenty: list[str] | None = None) -> int:
    _wlacz_utf8()
    parser = _zbuduj_parser()
    opcje = parser.parse_args(argumenty)
    if opcje.komenda is None:
        return menu()
    try:
        return opcje.funkcja(opcje)
    except LookupError as blad:
        print(f"Błąd: {blad}")
        return 2


def _zbuduj_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Interaktywny kurs programowania.")
    komendy = parser.add_subparsers(dest="komenda")

    komendy.add_parser("lista", help="lekcje i postęp").set_defaults(funkcja=komenda_lista)
    komendy.add_parser("dalej", help="pierwsza niezaliczona lekcja").set_defaults(funkcja=komenda_dalej)
    for nazwa, funkcja, pomoc in [
        ("czytaj", komenda_czytaj, "wyświetl teorię lekcji"),
        ("obserwuj", komenda_obserwuj, "sprawdzaj po każdym zapisie cwiczenia.py"),
        ("podpowiedz", komenda_podpowiedz, "podpowiedzi do ćwiczeń"),
        ("quiz", komenda_quiz, "quiz z lekcji"),
        ("rozwiazanie", komenda_rozwiazanie, "pokaż plik z rozwiązaniami"),
    ]:
        podparser = komendy.add_parser(nazwa, help=pomoc)
        podparser.add_argument("lekcja", help="numer (np. 3) albo fragment nazwy (np. sql)")
        podparser.set_defaults(funkcja=funkcja)

    sprawdz = komendy.add_parser("sprawdz", help="uruchom testy ćwiczeń")
    sprawdz.add_argument("lekcja", nargs="?", help="numer albo fragment nazwy")
    sprawdz.add_argument("--wszystkie", action="store_true", help="wszystkie lekcje")
    sprawdz.add_argument(
        "--rozwiazania", action="store_true", help="testuj rozwiązania wzorcowe (dla autorów kursu)"
    )
    sprawdz.set_defaults(funkcja=komenda_sprawdz)
    return parser


# --- komendy -----------------------------------------------------------------


def komenda_lista(_opcje: argparse.Namespace) -> int:
    dane = postep.wczytaj()
    print("\nLekcje (✔ zaliczona, ◐ zaczęta, · nie ruszana)\n")
    for lekcja in wszystkie_lekcje():
        stan = dane["lekcje"].get(lekcja.kod)
        if stan is None:
            znak, liczby = "·", ""
        else:
            znak = "✔" if stan["zaliczona"] else "◐"
            liczby = f"  {stan['ok']}/{stan['wszystkie']} testów"
        wynik_quizu = dane["quizy"].get(lekcja.kod)
        tekst_quizu = f"  quiz {wynik_quizu['najlepszy']}/{wynik_quizu['pytania']}" if wynik_quizu else ""
        print(f"  {znak} {lekcja.tytul}{liczby}{tekst_quizu}")
    zaliczone = sum(1 for stan in dane["lekcje"].values() if stan["zaliczona"])
    print(f"\nZaliczone: {zaliczone}/{len(wszystkie_lekcje())}")
    return 0


def komenda_czytaj(opcje: argparse.Namespace) -> int:
    lekcja = znajdz_lekcje(opcje.lekcja)
    print(lekcja.readme.read_text(encoding="utf-8"))
    print(f"\n→ Ćwiczenia: {lekcja.cwiczenia}")
    print(f"→ Sprawdź:   python kurs.py sprawdz {lekcja.kod}")
    return 0


def komenda_sprawdz(opcje: argparse.Namespace) -> int:
    modul = "rozwiazania" if opcje.rozwiazania else "cwiczenia"
    if opcje.wszystkie:
        lekcje = wszystkie_lekcje()
    elif opcje.lekcja:
        lekcje = [znajdz_lekcje(opcje.lekcja)]
    else:
        print("Podaj lekcję (np. python kurs.py sprawdz 1) albo --wszystkie.")
        return 2
    wszystkie_zaliczone = True
    for lekcja in lekcje:
        wynik = sprawdz_lekcje(lekcja, modul)
        wydrukuj_wynik(wynik, zwiezle=opcje.wszystkie)
        if modul == "cwiczenia":
            postep.zapisz_lekcje(lekcja.kod, wynik.ile(OK), len(wynik.testy))
        wszystkie_zaliczone = wszystkie_zaliczone and wynik.zaliczona
    return 0 if wszystkie_zaliczone else 1


def komenda_obserwuj(opcje: argparse.Namespace) -> int:
    lekcja = znajdz_lekcje(opcje.lekcja)
    ostatni_czas_zmiany = -1.0
    print(f"Obserwuję {lekcja.cwiczenia.name} — zapisz plik, a sprawdzę go od nowa. Ctrl+C kończy.")
    try:
        while True:
            czas_zmiany = lekcja.cwiczenia.stat().st_mtime
            if czas_zmiany != ostatni_czas_zmiany:
                ostatni_czas_zmiany = czas_zmiany
                _wyczysc_ekran()
                wynik = sprawdz_lekcje(lekcja)
                wydrukuj_wynik(wynik)
                postep.zapisz_lekcje(lekcja.kod, wynik.ile(OK), len(wynik.testy))
                if wynik.zaliczona:
                    print("Lekcja zaliczona! Następna: python kurs.py dalej")
                print(f"\n[{time.strftime('%H:%M:%S')}] czekam na zmiany w {lekcja.cwiczenia.name}… (Ctrl+C)")
            time.sleep(ODSTEP_OBSERWOWANIA_SEKUNDY)
    except KeyboardInterrupt:
        print("\nKoniec obserwowania.")
        return 0


def komenda_podpowiedz(opcje: argparse.Namespace) -> int:
    lekcja = znajdz_lekcje(opcje.lekcja)
    tresc = sekcja_readme(lekcja, "Podpowiedzi")
    print(tresc if tresc else "Ta lekcja nie ma podpowiedzi — spróbuj przeczytać komunikat błędu jeszcze raz.")
    return 0


def komenda_quiz(opcje: argparse.Namespace) -> int:
    lekcja = znajdz_lekcje(opcje.lekcja)
    pytania = quiz.wczytaj_pytania(lekcja.quiz)
    print(f"Quiz: {lekcja.tytul}")
    try:
        dobre = quiz.przeprowadz(pytania)
    except (KeyboardInterrupt, EOFError):
        print("\nQuiz przerwany.")
        return 1
    print(f"\nWynik: {dobre}/{len(pytania)}")
    postep.zapisz_quiz(lekcja.kod, dobre, len(pytania))
    return 0


def komenda_rozwiazanie(opcje: argparse.Namespace) -> int:
    lekcja = znajdz_lekcje(opcje.lekcja)
    odpowiedz = input("Na pewno? Najwięcej uczysz się, walcząc z zadaniem samodzielnie. [t/N] ")
    if odpowiedz.strip().lower() not in ("t", "tak", "y", "yes"):
        print("Dobra decyzja. Spróbuj: python kurs.py podpowiedz " + lekcja.kod)
        return 0
    print(lekcja.rozwiazania.read_text(encoding="utf-8"))
    return 0


def komenda_dalej(_opcje: argparse.Namespace) -> int:
    dane = postep.wczytaj()
    for lekcja in wszystkie_lekcje():
        stan = dane["lekcje"].get(lekcja.kod)
        if not stan or not stan["zaliczona"]:
            _pokaz_start_lekcji(lekcja)
            return 0
    print("Wszystkie lekcje zaliczone. Gratulacje! 🎉")
    return 0


# --- menu interaktywne -------------------------------------------------------


def menu() -> int:
    print("Witaj w kursie programowania! (Ctrl+C kończy w każdej chwili)")
    try:
        while True:
            komenda_lista(argparse.Namespace())
            wybor = input("\nNumer lekcji, [d]alej albo [k]oniec: ").strip().lower()
            if wybor in ("k", "q", "koniec"):
                return 0
            if wybor in ("d", "dalej"):
                komenda_dalej(argparse.Namespace())
                continue
            try:
                menu_lekcji(znajdz_lekcje(wybor))
            except LookupError as blad:
                print(f"Błąd: {blad}")
    except (KeyboardInterrupt, EOFError):
        print("\nDo zobaczenia!")
        return 0


def menu_lekcji(lekcja: Lekcja) -> None:
    opcje = argparse.Namespace(lekcja=str(lekcja.numer), wszystkie=False, rozwiazania=False)
    akcje = {
        "c": ("czytaj teorię", komenda_czytaj),
        "s": ("sprawdź ćwiczenia", komenda_sprawdz),
        "o": ("obserwuj plik i sprawdzaj na bieżąco", komenda_obserwuj),
        "p": ("podpowiedzi", komenda_podpowiedz),
        "q": ("quiz", komenda_quiz),
        "r": ("rozwiązanie", komenda_rozwiazanie),
    }
    while True:
        print(f"\n== {lekcja.tytul} ==")
        for klawisz, (opis, _funkcja) in akcje.items():
            print(f"  [{klawisz}] {opis}")
        print("  [w] wróć do listy")
        wybor = input("> ").strip().lower()
        if wybor == "w":
            return
        if wybor in akcje:
            akcje[wybor][1](opcje)


# --- wyświetlanie ------------------------------------------------------------


def wydrukuj_wynik(wynik: WynikLekcji, zwiezle: bool = False) -> None:
    liczba_testow = len(wynik.testy)
    print(f"\n{wynik.lekcja.tytul}: {wynik.ile(OK)}/{liczba_testow} testów zaliczonych")
    if zwiezle and wynik.zaliczona:
        return
    pokazano_szczegoly = False
    pokazane_powody_pominiecia: set[str] = set()
    for test in wynik.testy:
        print(f"  {IKONY[test.status]} {test.opis}")
        # Szczegóły tylko pierwszego błędu — kolejne często wynikają z tego samego.
        if test.status == BLAD and not pokazano_szczegoly:
            for linia in _skroc(test.komunikat.splitlines()):
                print(f"      {linia}")
            pokazano_szczegoly = True
        elif test.status == POMINIETY and test.komunikat not in pokazane_powody_pominiecia:
            print(f"      pominięty: {test.komunikat}")
            pokazane_powody_pominiecia.add(test.komunikat)
    do_zrobienia = wynik.ile(DO_ZROBIENIA)
    if do_zrobienia:
        print(f"  (… = {do_zrobienia} testów czeka, aż napiszesz funkcję — usuń `raise NotImplementedError`)")


def _skroc(linie: list[str]) -> list[str]:
    """Początek (co się stało) i koniec (gdzie) długiego komunikatu."""
    if len(linie) <= MAKS_LINII_KOMUNIKATU:
        return linie
    polowa = MAKS_LINII_KOMUNIKATU // 2
    return [*linie[:polowa], "…", *linie[-polowa:]]


def _pokaz_start_lekcji(lekcja: Lekcja) -> None:
    print(f"\nNastępna lekcja: {lekcja.tytul}")
    print(f"  1. Przeczytaj teorię:     python kurs.py czytaj {lekcja.kod}")
    print(f"  2. Otwórz w edytorze:     {lekcja.cwiczenia}")
    print(f"  3. Sprawdzaj na bieżąco:  python kurs.py obserwuj {lekcja.kod}")
    print(f"  4. Na koniec quiz:        python kurs.py quiz {lekcja.kod}")


def _wyczysc_ekran() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def _wlacz_utf8() -> None:
    # Konsola Windows domyślnie nie używa UTF-8, a kurs pisze po polsku i używa ✔/✘.
    for strumien in (sys.stdout, sys.stderr):
        if hasattr(strumien, "reconfigure"):
            strumien.reconfigure(encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
