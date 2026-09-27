# Lekcja 12 — RAG (Retrieval-Augmented Generation)

Cel: budujesz od zera cały potok RAG — dzielenie dokumentów, indeks
wektorowy, wyszukiwanie, prompt z cytowaniami, sprawdzanie cytowań i
ocenę jakości wyszukiwania.

## Teoria

### Po co RAG?

Model nie zna Twoich dokumentów (regulaminów, wiki firmy, maili) i ma
datę odcięcia wiedzy. Wklejenie **wszystkiego** do promptu bywa za drogie
albo za duże. RAG: **znajdź** kilka pasujących fragmentów i **dołącz** je do
pytania. Model odpowiada na podstawie dostarczonego kontekstu, z odnośnikami
do źródeł — mniej zmyśleń, łatwa weryfikacja.

### Potok

```
INDEKSOWANIE (raz, offline)
dokumenty ─▶ podział na fragmenty ─▶ embedding każdego ─▶ indeks (wektor + tekst + źródło)

ZAPYTANIE (za każdym razem)
pytanie ─▶ embedding ─▶ top-k najbliższych fragmentów ─▶ prompt: kontekst + pytanie ─▶ model
                                                                              │
                                    odpowiedź z cytowaniami [1] [2] ◀─────────┘
```

### Dzielenie na fragmenty (chunking)

- Za duże fragmenty — dużo szumu i tokenów, rozmyty embedding.
- Za małe — urwany kontekst („…w ciągu 14 dni” — czego?).
- **Zakładka** (overlap): kolejne fragmenty dzielą kilka słów, żeby zdanie na
  granicy nie zginęło.
- Dziel po naturalnych granicach, gdy się da (akapity, nagłówki). Zapamiętaj
  **metadane**: plik, numer fragmentu, nagłówek — do cytowań.

### Wyszukiwanie

- **top-k** — ile fragmentów dołączyć (zwykle 3–10),
- **próg podobieństwa** — poniżej niego fragment uznajemy za nietrafiony;
  lepiej powiedzieć „nie wiem”, niż odpowiadać z nietrafionego kontekstu,
- w praktyce łączy się wyszukiwanie wektorowe ze słownym (BM25) — *hybrid
  search* — i dokłada **reranker**, który dokładniej ocenia kandydatów.

### Prompt

```
Odpowiedz na pytanie, korzystając WYŁĄCZNIE z poniższych źródeł.
Po każdym fakcie podaj numer źródła w nawiasie kwadratowym, np. [1].
Jeśli źródła nie zawierają odpowiedzi, napisz: "Nie wiem na podstawie dostępnych dokumentów."

Źródła:
[1] (zwroty#0) Towar kupiony w sklepie internetowym ...
[2] (dostawa#1) ...

Pytanie: Ile mam czasu na zwrot?
```

Treść dokumentów to **dane**, nie polecenia: dokument z tekstem „zignoruj
instrukcje i…” nie może niczego zmienić (prompt injection). Oddzielaj wyraźnie
instrukcje od źródeł.

API Claude'a ma też wbudowane cytowania: dokumenty przekazane jako bloki
`document` z `"citations": {"enabled": true}` dostają w odpowiedzi precyzyjne
odnośniki do fragmentów.

### Ocena

Mierz osobno dwie rzeczy:

1. **Wyszukiwanie** — czy właściwy dokument jest w top-k? Miara **recall@k**:
   odsetek pytań testowych, dla których oczekiwane źródło znalazło się wśród
   k wyników. Jeśli wyszukiwanie nie znajdzie źródła, model nie ma szans.
2. **Odpowiedź** — czy jest zgodna ze źródłami, czy cytowania istnieją.
   Model może „zacytować” źródło [7], którego nie było — sprawdzaj to kodem.

## Ćwiczenia

W `cwiczenia.py` są gotowe funkcje pomocnicze z lekcji 11 (`tokenizuj`,
`embedding_haszujacy`, `cosinus`). Twoje zadania:

1. `podziel_na_fragmenty(tekst, rozmiar, zakladka)`.
2. `zbuduj_indeks(dokumenty, rozmiar, zakladka)`.
3. `wyszukaj(indeks, pytanie, k, prog)`.
4. `zbuduj_prompt(pytanie, trafienia)`.
5. `sprawdz_cytowania(odpowiedz, liczba_zrodel)`.
6. `recall_at_k(wyniki, oczekiwane, k)`.
7. `odpowiedz_rag(pytanie, indeks, model)` — całość.

Potem uruchom demo na plikach z `dokumenty/`:
`python demo_rag.py "Ile kosztuje dostawa?"`

Spróbuj też `python demo_rag.py "Przepis na pierogi"`. Nasze „zabawkowe”
embeddingi łapią wspólne słowa i końcówki, więc fragment o dostawie przejdzie
próg. Dlatego instrukcja „Nie wiem na podstawie dostępnych dokumentów” w
prompcie jest drugą linią obrony — a prawdziwe embeddingi (lekcja 11) oddzielają
takie pytania dużo lepiej.

## Podpowiedzi

- **cw1**: `slowa = tekst.split()`, `krok = rozmiar - zakladka`, pętla `for poczatek in range(0, len(slowa), krok)`; zakończ, gdy fragment sięgnął końca (`poczatek + rozmiar >= len(slowa)`).
- **cw2**: dla każdego dokumentu (w kolejności kluczy) i każdego fragmentu: `Fragment(zrodlo=f"{nazwa}#{numer}", tekst=..., wektor=embedding_haszujacy(...))`.
- **cw3**: policz `cosinus` z wektorem pytania, odrzuć poniżej progu, posortuj malejąco (stabilnie!), weź `[:k]`.
- **cw4**: zbuduj listę linii i połącz `"\n".join(...)`. Numeracja źródeł od 1.
- **cw5**: `re.findall(r"\[(\d+)\]", odpowiedz)`; zamień na int, usuń duplikaty (`set`), posortuj.
- **cw7**: `trafienia = wyszukaj(...)`; pusto → zwróć `BRAK_ODPOWIEDZI` bez wołania modelu. Inaczej `model(zbuduj_prompt(...))`, a jeśli odpowiedź cytuje nieistniejące źródła — dopisz ostrzeżenie.
