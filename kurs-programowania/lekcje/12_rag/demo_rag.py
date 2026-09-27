"""Demo RAG na plikach z katalogu dokumenty/ (używa Twoich funkcji z cwiczenia.py).

    python demo_rag.py "Ile kosztuje dostawa?"            # pokazuje trafienia i prompt
    python demo_rag.py "Ile kosztuje dostawa?" --claude   # + odpowiedź Claude'a (pip install anthropic, ANTHROPIC_API_KEY)
"""

import argparse
import sys
from pathlib import Path

import cwiczenia as rag

KATALOG_DOKUMENTOW = Path(__file__).parent / "dokumenty"
MODEL = "claude-opus-5"


def odpowiedz_claude(prompt: str) -> str:
    import anthropic  # opcjonalna zależność — importujemy tylko, gdy potrzebna

    odpowiedz = anthropic.Anthropic().messages.create(
        model=MODEL, max_tokens=16000, messages=[{"role": "user", "content": prompt}]
    )
    if odpowiedz.stop_reason == "refusal":
        return "(model odmówił odpowiedzi)"
    return "".join(blok.text for blok in odpowiedz.content if blok.type == "text")


def main() -> int:
    parser = argparse.ArgumentParser(description="Demo RAG.")
    parser.add_argument("pytanie")
    parser.add_argument("--claude", action="store_true", help="wyślij prompt do Claude'a")
    opcje = parser.parse_args()

    dokumenty = {sciezka.stem: sciezka.read_text(encoding="utf-8") for sciezka in sorted(KATALOG_DOKUMENTOW.glob("*.md"))}
    indeks = rag.zbuduj_indeks(dokumenty)
    print(f"Indeks: {len(indeks)} fragmentów z {len(dokumenty)} dokumentów\n")

    trafienia = rag.wyszukaj(indeks, opcje.pytanie)
    for fragment, podobienstwo in trafienia:
        print(f"  {podobienstwo:.3f}  {fragment.zrodlo}: {fragment.tekst[:70]}…")
    if not trafienia:
        print(rag.BRAK_ODPOWIEDZI)
        return 0

    if opcje.claude:
        print("\n" + rag.odpowiedz_rag(opcje.pytanie, indeks, odpowiedz_claude))
    else:
        print("\n--- prompt, który trafiłby do modelu ---\n" + rag.zbuduj_prompt(opcje.pytanie, trafienia))
    return 0


if __name__ == "__main__":
    sys.exit(main())
