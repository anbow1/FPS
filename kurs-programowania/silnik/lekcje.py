"""Wyszukiwanie lekcji na dysku i czytanie ich plików."""

import re
from dataclasses import dataclass
from pathlib import Path

KATALOG_KURSU = Path(__file__).resolve().parent.parent
KATALOG_LEKCJI = KATALOG_KURSU / "lekcje"

# Katalog lekcji to "NN_nazwa", np. "01_python_podstawy".
_WZOR_KATALOGU = re.compile(r"^(\d{2})_([a-z0-9_]+)$")


@dataclass(frozen=True)
class Lekcja:
    numer: int
    slug: str
    katalog: Path

    @property
    def kod(self) -> str:
        """Dwucyfrowy numer, np. "01" — klucz w pliku postępu."""
        return f"{self.numer:02d}"

    @property
    def readme(self) -> Path:
        return self.katalog / "README.md"

    @property
    def cwiczenia(self) -> Path:
        return self.katalog / "cwiczenia.py"

    @property
    def rozwiazania(self) -> Path:
        return self.katalog / "rozwiazania.py"

    @property
    def quiz(self) -> Path:
        return self.katalog / "quiz.json"

    @property
    def tytul(self) -> str:
        """Pierwszy nagłówek README bez "# ", np. "Lekcja 01 — Podstawy Pythona"."""
        with self.readme.open(encoding="utf-8") as plik:
            pierwsza_linia = plik.readline().strip()
        return pierwsza_linia.lstrip("#").strip() or self.katalog.name


def wszystkie_lekcje(katalog: Path = KATALOG_LEKCJI) -> list[Lekcja]:
    lekcje = []
    for sciezka in sorted(katalog.iterdir()):
        dopasowanie = _WZOR_KATALOGU.match(sciezka.name)
        if sciezka.is_dir() and dopasowanie:
            lekcje.append(Lekcja(int(dopasowanie.group(1)), dopasowanie.group(2), sciezka))
    return lekcje


def znajdz_lekcje(identyfikator: str, katalog: Path = KATALOG_LEKCJI) -> Lekcja:
    """Znajduje lekcję po numerze ("3", "03") albo fragmencie nazwy ("sql")."""
    lekcje = wszystkie_lekcje(katalog)
    tekst = identyfikator.strip().lower()
    if tekst.isdigit():
        for lekcja in lekcje:
            if lekcja.numer == int(tekst):
                return lekcja
    else:
        pasujace = [lekcja for lekcja in lekcje if tekst in lekcja.slug]
        if len(pasujace) == 1:
            return pasujace[0]
    dostepne = ", ".join(f"{lekcja.kod} ({lekcja.slug})" for lekcja in lekcje)
    raise LookupError(f"nie znam lekcji '{identyfikator}'; dostępne: {dostepne}")


def sekcja_readme(lekcja: Lekcja, naglowek: str) -> str | None:
    """Zwraca treść sekcji "## <naglowek>" z README (bez samego nagłówka)."""
    linie = lekcja.readme.read_text(encoding="utf-8").splitlines()
    zebrane: list[str] = []
    w_sekcji = False
    for linia in linie:
        if linia.startswith("## "):
            if w_sekcji:
                break
            w_sekcji = linia[3:].strip().lower() == naglowek.lower()
            continue
        if w_sekcji:
            zebrane.append(linia)
    if not w_sekcji:
        return None
    return "\n".join(zebrane).strip()
