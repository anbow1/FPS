# Lekcja 11 — Embeddingi (wektory znaczeń)

Cel: rozumiesz, czym jest embedding, liczysz podobieństwo cosinusowe od zera
i budujesz prostą wyszukiwarkę „najbliższych” tekstów — fundament RAG.

## Teoria

### Tekst → wektor

**Embedding** to lista liczb (wektor) opisująca tekst tak, że teksty
o podobnym znaczeniu mają podobne wektory. Model embeddingowy zamienia
„Jak zresetować hasło?” na np. 1024 liczby. „Zapomniałem hasła” trafi blisko,
„Przepis na pierogi” — daleko.

```
                 ▲ wymiar 2
  "zapomniałem   │   ● "jak zresetować hasło?"
   hasła"  ●     │
                 │
                 │                 ● "przepis na pierogi"
                 └──────────────────────────▶ wymiar 1
```

(Prawdziwe embeddingi mają setki wymiarów, ale idea jest ta sama.)

### Podobieństwo cosinusowe

Mierzy kąt między wektorami, nie ich długość:

```
cos(a, b) = (a · b) / (|a| · |b|)          a · b = Σ aᵢ·bᵢ       |a| = √(Σ aᵢ²)
```

- `1` — ten sam kierunek (bardzo podobne),
- `0` — prostopadłe (niezwiązane),
- `-1` — przeciwne.

Jeśli wektory są **znormalizowane** (długość 1), cosinus to zwykły iloczyn
skalarny — dlatego bazy wektorowe często normalizują wszystko na wejściu.

### Embeddingi „ręczne”: worek słów (bag of words)

Najprostszy wektor: słownik słów, a na pozycji *i* — ile razy słowo *i*
występuje w tekście. Działa dla dopasowań słownych, ale nie rozumie
synonimów („auto” ≠ „samochód”) ani odmiany („hasło” ≠ „hasła”).

**TF-IDF** poprawia worek słów: słowa częste we *wszystkich* dokumentach
(„i”, „w”, „jest”) dostają małą wagę, rzadkie i charakterystyczne — dużą:

```
idf(słowo) = ln((1 + N) / (1 + df)) + 1      N — liczba dokumentów, df — w ilu jest słowo
```

**Hashing trick**: zamiast trzymać słownik, słowo trafia na pozycję
`hash(słowo) % wymiar`. Stały rozmiar wektora, zero pamięci na słownik.
Uwaga: wbudowane `hash()` dla napisów jest w Pythonie **losowe przy każdym
uruchomieniu** (ochrona przed atakami) — do zapisywanych wektorów potrzebny
stabilny hash, np. `zlib.crc32`.

### Prawdziwe embeddingi

Wyuczone modele rozumieją znaczenie, synonimy i wiele języków. Opcje:

- **lokalnie**: biblioteka `sentence-transformers` (model wielojęzyczny, działa też po polsku):

  ```python
  from sentence_transformers import SentenceTransformer

  model = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
  wektory = model.encode(["Jak zresetować hasło?", "Zapomniałem hasła"], normalize_embeddings=True)
  ```

- **przez API**: np. Voyage AI (polecany przez Anthropic — Claude sam nie
  udostępnia modelu embeddingów), OpenAI, Cohere. Nazwy modeli się zmieniają —
  sprawdź aktualne w dokumentacji dostawcy.

Zasady praktyczne:

- Dokumenty i zapytania embedduj **tym samym modelem** — wektory różnych
  modeli są nieporównywalne.
- Wysyłaj teksty **partiami** (lekcja 10) — mniej zapytań.
- Zapisuj wektory razem z nazwą modelu. Zmiana modelu = przeliczenie wszystkiego.
- Przy milionach wektorów potrzebujesz indeksu: `pgvector` (PostgreSQL),
  FAISS, Chroma, Qdrant… Przy tysiącach wystarczy lista i pętla — jak w ćwiczeniach.

## Ćwiczenia

Wszystko na czystym Pythonie — bez numpy, żeby zobaczyć każdą operację.

1. `tokenizuj(tekst)` — słowa małymi literami.
2. `wektor_bow(tokeny, slownik)` — worek słów.
3. `podobienstwo_cosinusowe(a, b)` — od zera.
4. `normalizuj(wektor)` — długość 1.
5. `embedding_haszujacy(tekst, wymiar)` — hashing trick ze stabilnym hashem.
6. `wagi_idf(dokumenty)` — wagi IDF.
7. `najblizsze(zapytanie, wektory, k)` — wyszukiwarka top-k.

## Podpowiedzi

- **cw1**: `re.findall(r"\w+", tekst.lower())` — `\w` łapie też polskie litery i cyfry.
- **cw2**: `[float(tokeny.count(slowo)) for slowo in slownik]` (albo `collections.Counter`).
- **cw3**: `sum(x * y for x, y in zip(a, b))`, `math.sqrt(sum(x * x for x in a))`. Uważaj na dzielenie przez zero.
- **cw5**: `zlib.crc32(token.encode("utf-8")) % wymiar` — pozycja; dodaj 1.0; na końcu `normalizuj` (chyba że wektor jest zerowy — wtedy zwróć zera).
- **cw6**: `df` liczysz po `set(tokeny)` każdego dokumentu. `math.log` to logarytm naturalny.
- **cw7**: policz pary `(id, podobieństwo)`, posortuj `key=lambda para: (-para[1], para[0])`, weź `[:k]`.
