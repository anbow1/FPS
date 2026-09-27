"""Testy lekcji 14. Uruchamiaj przez: python kurs.py sprawdz 14 (Docker nie jest potrzebny)."""

import importlib
import os
import unittest
from pathlib import Path

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))

ZLY_DOCKERFILE = """\
# obraz bez wersji
FROM python
ENV API_KEY=sk-123 DEBUG=1
ADD . /app
COPY . .
RUN apt-get update && \\
    apt-get install -y curl
RUN pip install -r requirements.txt
"""


class TestGenerowanie(unittest.TestCase):
    def test_cw1_dockerfile_z_portem(self) -> None:
        """cw1: pełny Dockerfile z EXPOSE"""
        oczekiwany = (
            "FROM python:3.12-slim\n"
            "WORKDIR /app\n"
            "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1\n"
            "COPY requirements.txt .\n"
            "RUN pip install --no-cache-dir -r requirements.txt\n"
            "COPY . .\n"
            "RUN useradd --create-home aplikacja\n"
            "USER aplikacja\n"
            "EXPOSE 8000\n"
            'CMD ["python", "app.py"]\n'
        )
        self.assertEqual(cw.wygeneruj_dockerfile("3.12", "app.py", 8000), oczekiwany)

    def test_cw1_bez_portu_i_zla_wersja(self) -> None:
        """cw1: bez portu brak EXPOSE; wersja "3" → ValueError"""
        self.assertNotIn("EXPOSE", cw.wygeneruj_dockerfile("3.11", "main.py"))
        with self.assertRaises(ValueError):
            cw.wygeneruj_dockerfile("3", "app.py")

    def test_cw1_wygenerowany_przechodzi_linter(self) -> None:
        """cw1+cw3: wygenerowany Dockerfile nie ma żadnych uwag lintera"""
        self.assertEqual(cw.sprawdz_dockerfile(cw.wygeneruj_dockerfile("3.12", "app.py", 8000)), [])


class TestParsowanie(unittest.TestCase):
    def test_cw2_instrukcje_z_kontynuacja(self) -> None:
        """cw2: komentarze pominięte, kontynuacja "\\" sklejona, numer pierwszej linii"""
        self.assertEqual(cw.instrukcje_dockerfile(ZLY_DOCKERFILE), [
            (2, "FROM", "python"),
            (3, "ENV", "API_KEY=sk-123 DEBUG=1"),
            (4, "ADD", ". /app"),
            (5, "COPY", ". ."),
            (6, "RUN", "apt-get update && apt-get install -y curl"),
            (8, "RUN", "pip install -r requirements.txt"),
        ])

    def test_cw2_male_litery_i_puste_linie(self) -> None:
        """cw2: instrukcje wielkimi literami, puste linie pomijane"""
        self.assertEqual(cw.instrukcje_dockerfile("\n\nfrom  python:3.12  \n\ncmd [\"x\"]"),
                         [(3, "FROM", "python:3.12"), (5, "CMD", '["x"]')])


class TestLinter(unittest.TestCase):
    def test_cw3_wszystkie_bledy(self) -> None:
        """cw3: latest, sekret, add, cache, apt, root — z numerami linii"""
        self.assertEqual(cw.sprawdz_dockerfile(ZLY_DOCKERFILE),
                         [(0, "root"), (2, "latest"), (3, "sekret"), (4, "add"), (5, "cache"), (6, "apt")])

    def test_cw3_poprawne_przypadki(self) -> None:
        """cw3: tag, digest, etap multi-stage, sprzątanie apt i ARG bez sekretu są OK"""
        tekst = (
            "FROM python:3.12-slim AS budowanie\n"
            "ARG WERSJA=1.0\n"
            "RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*\n"
            "FROM budowanie\n"
            "FROM ghcr.io/org/obraz@sha256:abc123\n"
            "COPY --chown=app . .\n"
            "USER app\n"
        )
        self.assertEqual(cw.sprawdz_dockerfile(tekst), [])

    def test_cw3_latest_i_rejestr_z_portem(self) -> None:
        """cw3: :latest to błąd; port rejestru (localhost:5000/app) to nie tag"""
        self.assertEqual(cw.sprawdz_dockerfile("FROM python:latest\nUSER x\n"), [(1, "latest")])
        self.assertEqual(cw.sprawdz_dockerfile("FROM localhost:5000/app\nUSER x\n"), [(1, "latest")])
        self.assertEqual(cw.sprawdz_dockerfile("FROM --platform=linux/amd64 localhost:5000/app:2\nUSER x\n"), [])

    def test_cw3_linter_na_przykladzie_z_lekcji(self) -> None:
        """cw3: przyklad/Dockerfile z tej lekcji jest czysty"""
        tekst = (Path(__file__).parent / "przyklad" / "Dockerfile").read_text(encoding="utf-8")
        self.assertEqual(cw.sprawdz_dockerfile(tekst), [])


class TestKomendy(unittest.TestCase):
    def test_cw4_pelna_komenda(self) -> None:
        """cw4: flagi w ustalonej kolejności, słowniki posortowane"""
        self.assertEqual(
            cw.zbuduj_komende_run("licznik:1.0", nazwa="app", porty={8080: 8000, 443: 443},
                                  wolumeny={"dane": "/dane"}, zmienne={"B": "2", "A": "1"},
                                  w_tle=True),
            ["docker", "run", "--rm", "-d", "--name", "app", "-p", "443:443", "-p", "8080:8000",
             "-v", "dane:/dane", "-e", "A=1", "-e", "B=2", "licznik:1.0"],
        )

    def test_cw4_minimalna_komenda(self) -> None:
        """cw4: tylko obraz; -it bez --rm"""
        self.assertEqual(cw.zbuduj_komende_run("python:3.12"), ["docker", "run", "--rm", "python:3.12"])
        self.assertEqual(cw.zbuduj_komende_run("python:3.12", interaktywnie=True, usun_po_zakonczeniu=False),
                         ["docker", "run", "-it", "python:3.12"])

    def test_cw5_docker_ps(self) -> None:
        """cw5: JSON na linię → lista słowników, "dziala" z pola Status"""
        tekst = (
            '{"Names":"app","Image":"licznik:1.0","Status":"Up 5 minutes","Ports":"0.0.0.0:8000->8000/tcp"}\n'
            "\n"
            '{"Names":"stary","Image":"python:3.12","Status":"Exited (0) 2 hours ago","Ports":""}\n'
        )
        self.assertEqual(cw.parsuj_docker_ps(tekst), [
            {"nazwa": "app", "obraz": "licznik:1.0", "dziala": True, "porty": "0.0.0.0:8000->8000/tcp"},
            {"nazwa": "stary", "obraz": "python:3.12", "dziala": False, "porty": ""},
        ])

    def test_cw6_podstaw_zmienne(self) -> None:
        """cw6: ${X}, ${X:-domyślna} (także gdy X puste), tekst bez zmiennych"""
        szablon = "image: app:${WERSJA}\nPOWITANIE: ${POWITANIE:-Cześć}\nTRYB: ${TRYB:-dev}"
        self.assertEqual(cw.podstaw_zmienne(szablon, {"WERSJA": "1.2", "TRYB": ""}),
                         "image: app:1.2\nPOWITANIE: Cześć\nTRYB: dev")
        self.assertEqual(cw.podstaw_zmienne("bez zmiennych $HOME", {}), "bez zmiennych $HOME")

    def test_cw6_brak_zmiennej(self) -> None:
        """cw6: ${X} bez wartości i bez domyślnej → KeyError"""
        with self.assertRaises(KeyError):
            cw.podstaw_zmienne("tag: ${WERSJA}", {})


if __name__ == "__main__":
    unittest.main()
