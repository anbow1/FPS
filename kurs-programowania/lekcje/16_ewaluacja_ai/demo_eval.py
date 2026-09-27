"""Demo evala na zestaw.jsonl (używa Twoich funkcji z cwiczenia.py).

    python demo_eval.py            # dwie wersje "asystenta" na sztywno — porównanie i regresje
    python demo_eval.py --claude   # prawdziwy Claude z regulaminem z lekcji 12 (pip install anthropic, ANTHROPIC_API_KEY)
"""

import argparse
import sys
from pathlib import Path
from typing import Any

import cwiczenia as ev

MODEL = "claude-opus-5"
KATALOG_DOKUMENTOW = Path(__file__).parent.parent / "12_rag" / "dokumenty"

# Dwie wersje asystenta udają zmianę promptu: v2 naprawia dwa błędy, ale psuje jedną odpowiedź.
ODPOWIEDZI_V1 = {
    "Ile kosztuje dostawa kurierem?": "Kurier kosztuje 15 zł.",
    "Ile kosztuje paczkomat?": "Paczkomat to 12 zł.",
    "Od jakiej kwoty dostawa jest darmowa?": "Darmowa dostawa jest od 150 zł.",
    "Czy wysyłacie do Niemiec?": "Tak, wysyłamy do całej Europy.",
    "Ile dni mam na zwrot towaru?": "Masz 30 dni od dostarczenia.",
    "W ile dni oddajecie pieniądze za zwrot?": "Pieniądze oddajemy w ciągu 14 dni.",
    "Czy mogę zwrócić kawę mieloną na zamówienie?": "Nie, kawa mielona na zamówienie nie podlega zwrotowi.",
    "Ile punktów dostaję za 10 zł?": "Za każde 10 zł dostajesz 1 punkt.",
    "Przez ile miesięcy ważne są punkty?": "Punkty są ważne 12 miesięcy.",
    "Jaka jest stolica Australii?": "Canberra.",
}
ODPOWIEDZI_V2 = {
    **ODPOWIEDZI_V1,
    "Od jakiej kwoty dostawa jest darmowa?": "Powyżej 200 zł dostawa jest darmowa.",
    "Czy wysyłacie do Niemiec?": "Nie, dostarczamy wyłącznie na terenie Polski.",
    "Jaka jest stolica Australii?": "Nie wiem.",
    "Przez ile miesięcy ważne są punkty?": "Punkty nie wygasają.",
}


def ocen(odpowiedz: str, przypadek: dict[str, Any]) -> bool:
    typ, oczekiwane = przypadek["typ"], przypadek["oczekiwane"]
    if typ == "liczba":
        return ev.ocena_liczbowa(odpowiedz, oczekiwane)
    if typ == "zawiera":
        return ev.ocena_zawiera(odpowiedz, oczekiwane["wymagane"], oczekiwane["zakazane"])
    if typ == "dokladna":
        return ev.ocena_dokladna(odpowiedz, oczekiwane)
    raise ValueError(f"nieznany typ oceny '{typ}' w przypadku {przypadek['id']}")


def model_claude() -> Any:
    import anthropic  # opcjonalna zależność

    klient = anthropic.Anthropic()
    regulamin = "\n\n".join(p.read_text(encoding="utf-8") for p in sorted(KATALOG_DOKUMENTOW.glob("*.md")))
    system = (
        "Jesteś asystentem sklepu. Odpowiadaj jednym krótkim zdaniem, wyłącznie na podstawie regulaminu. "
        'Jeśli regulamin nie zawiera odpowiedzi, odpowiedz dokładnie: "Nie wiem."\n\n' + regulamin
    )

    def zapytaj(pytanie: str) -> str:
        odpowiedz = klient.messages.create(
            model=MODEL, max_tokens=16000, system=system, messages=[{"role": "user", "content": pytanie}]
        )
        if odpowiedz.stop_reason == "refusal":
            raise RuntimeError("model odmówił odpowiedzi")
        return "".join(blok.text for blok in odpowiedz.content if blok.type == "text")

    return zapytaj


def wydrukuj(nazwa: str, raport: dict[str, Any]) -> None:
    zaliczone = sum(1 for wynik in raport["wyniki"] if wynik["zaliczony"])
    wszystkie = len(raport["wyniki"])
    dolny, gorny = ev.przedzial_wilsona(zaliczone, wszystkie)
    print(f"\n== {nazwa}: {zaliczone}/{wszystkie} = {raport['wynik']:.0%}  (95% przedział: {dolny:.0%}–{gorny:.0%})")
    for tag, wynik in sorted(raport["wg_tagow"].items()):
        print(f"   {tag:<14} {wynik:.0%}")
    for wynik in raport["wyniki"]:
        if not wynik["zaliczony"]:
            print(f"   ✘ {wynik['id']}: {wynik['odpowiedz']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Demo evala.")
    parser.add_argument("--claude", action="store_true", help="oceń prawdziwego Claude'a")
    opcje = parser.parse_args()
    przypadki = ev.wczytaj_zestaw((Path(__file__).parent / "zestaw.jsonl").read_text(encoding="utf-8"))

    if opcje.claude:
        wydrukuj(f"Claude ({MODEL})", ev.uruchom_eval(model_claude(), przypadki, ocen))
        return 0

    przed = ev.uruchom_eval(ODPOWIEDZI_V1.__getitem__, przypadki, ocen)
    po = ev.uruchom_eval(ODPOWIEDZI_V2.__getitem__, przypadki, ocen)
    wydrukuj("wersja 1", przed)
    wydrukuj("wersja 2", po)
    zmiany = ev.porownaj(przed, po)
    print(f"\nPoprawy:  {', '.join(zmiany['poprawy']) or '—'}")
    print(f"Regresje: {', '.join(zmiany['regresje']) or '—'}")
    print("\nWersja 2 ma lepszy wynik, ale zanim ją wdrożysz, zbadaj regresje. A przy 10 przypadkach")
    print("przedziały ufności mocno się nakładają — zestaw jest za mały, żeby wynik był pewny.")
    print("\nI przeczytaj porażki: punkty-kurs oblewa w obu wersjach, choć odpowiedź jest dobra —")
    print("oceniacz liczbowy bierze pierwszą liczbę w tekście (10 zł), a nie 1 punkt. To błąd oceniacza,")
    print("nie modelu. Popraw zestaw (np. typ \"zawiera\" z frazą \"1 punkt\") i uruchom ponownie.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
