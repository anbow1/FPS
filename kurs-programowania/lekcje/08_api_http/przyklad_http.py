"""Prawdziwe zapytanie HTTP samą biblioteką standardową (potrzebny internet).

    python przyklad_http.py python/cpython
"""

import json
import sys
import urllib.error
import urllib.request

# GitHub wymaga nagłówka User-Agent; bez klucza API limit to 60 zapytań/godzinę.
NAGLOWKI = {"Accept": "application/vnd.github+json", "User-Agent": "kurs-programowania"}
TIMEOUT_SEKUNDY = 10


def main() -> int:
    repo = sys.argv[1] if len(sys.argv) > 1 else "python/cpython"
    url = f"https://api.github.com/repos/{repo}"
    zapytanie = urllib.request.Request(url, headers=NAGLOWKI)
    try:
        with urllib.request.urlopen(zapytanie, timeout=TIMEOUT_SEKUNDY) as odpowiedz:
            dane = json.load(odpowiedz)
    except urllib.error.HTTPError as blad:
        print(f"Serwer odpowiedział {blad.code}: {blad.reason}", file=sys.stderr)
        return 1
    except urllib.error.URLError as blad:
        print(f"Brak połączenia: {blad.reason}", file=sys.stderr)
        return 1
    print(f"{dane['full_name']}: ★ {dane['stargazers_count']}, język: {dane['language']}")
    print(f"Opis: {dane['description']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
