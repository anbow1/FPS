# Lekcja 07 — pandas

Cel: wczytujesz dane tabelaryczne (CSV), czyścisz braki, filtrujesz,
grupujesz i robisz tabele przestawne — bez pisania pętli.

> Wymaga pakietu `pandas`: w aktywnym venv `python -m pip install -r requirements.txt`
> (katalog kursu). Bez niego testy tej lekcji będą oznaczone jako pominięte.

## Teoria

### Series i DataFrame

- **Series** — jedna kolumna: wartości + indeks (etykiety wierszy).
- **DataFrame** — tabela: słownik kolumn-Series ze wspólnym indeksem.

```python
import pandas as pd

df = pd.DataFrame({"produkt": ["Kawa", "Herbata"], "sztuki": [10, 5], "cena_zl": [25.0, 15.0]})
df["sztuki"]              # Series
df[["produkt", "sztuki"]] # DataFrame z dwiema kolumnami (uwaga: podwójne nawiasy)
```

### Wczytywanie i pierwszy rzut oka

```python
df = pd.read_csv("sprzedaz.csv", parse_dates=["data"])
df.head()        # pierwsze 5 wierszy
df.info()        # kolumny, typy, liczba nie-pustych wartości
df.describe()    # statystyki kolumn liczbowych
df.shape         # (wiersze, kolumny)
df["region"].value_counts()
```

### Wybieranie wierszy

```python
df[df["sztuki"] > 5]                                   # maska logiczna
df[(df["region"] == "Północ") & (df["sztuki"] >= 5)]   # & | ~ zamiast and or not, NAWIASY!
df[df["produkt"].isin(["Kawa", "Herbata"])]
df.loc[0, "produkt"]      # po etykiecie
df.iloc[0, 1]             # po pozycji
```

### Nowe kolumny — operacje wektorowe

```python
df["przychod"] = df["sztuki"] * df["cena_zl"]   # cała kolumna naraz, bez pętli
df = df.assign(przychod=df["sztuki"] * df["cena_zl"])  # to samo, ale zwraca NOWY DataFrame
```

Pętla `for` po wierszach (`iterrows`) jest zwykle 100× wolniejsza — myśl
kolumnami.

### Braki danych

Puste pole w CSV to `NaN` (not a number).

```python
df.isna().sum()                         # ile braków w każdej kolumnie
df.dropna(subset=["cena_zl"])           # wyrzuć wiersze z brakiem ceny
df["sztuki"].fillna(0)                  # wstaw 0
# mediana ceny w grupie produktu, rozciągnięta na każdy wiersz:
df["cena_zl"].fillna(df.groupby("produkt")["cena_zl"].transform("median"))
```

Kolumna liczb całkowitych z `NaN` staje się `float` — po uzupełnieniu wróć
do `int` przez `.astype(int)`.

### Grupowanie

```python
df.groupby("region")["przychod"].sum()                       # Series: region → suma
df.groupby(["region", "produkt"])["sztuki"].agg(["sum", "mean"])
df.groupby("region")["przychod"].sum().sort_values(ascending=False)
```

Schemat myślowy: **podziel** (group by) → **policz** (sum/mean/count) → **sklej**.

### Tabela przestawna i łączenie

```python
pd.pivot_table(df, index="region", columns="produkt", values="przychod",
               aggfunc="sum", fill_value=0)

regiony = pd.DataFrame({"region": ["Północ"], "kierownik": ["Ala"]})
df.merge(regiony, on="region", how="left")     # jak LEFT JOIN w SQL
```

### Daty

```python
df["data"].dt.month
df["data"].dt.to_period("M").astype(str)       # "2026-01"
df.groupby(df["data"].dt.to_period("M"))["przychod"].sum()
```

### Zapis

```python
df.to_csv("wynik.csv", index=False)
df.to_json("wynik.json", orient="records", force_ascii=False)
```

### Kopie

Funkcje, które „zmieniają” DataFrame, niech zwracają **nowy** obiekt
(`df.copy()`, `assign`) zamiast modyfikować argument. Unikasz wtedy
ostrzeżeń `SettingWithCopyWarning` i niespodzianek u wywołującego.

## Ćwiczenia

Plik z danymi: `sprzedaz.csv` (są w nim celowe braki).

1. `wczytaj(sciezka)` — `read_csv` z datami.
2. `dodaj_przychod(df)` — nowa kolumna, bez zmiany wejścia.
3. `filtruj(df, region, min_sztuk)` — maska logiczna.
4. `suma_wg_regionu(df)` — groupby + sortowanie.
5. `uzupelnij_braki(df)` — 0 dla sztuk, mediana produktu dla ceny.
6. `tabela_przestawna(df)` — region × produkt.
7. `sprzedaz_miesieczna(df)` — suma przychodu na miesiąc.

Poeksperymentuj też w konsoli: `python`, potem `import pandas as pd` i `pd.read_csv("sprzedaz.csv")`.

## Podpowiedzi

- **cw1**: `pd.read_csv(sciezka, parse_dates=["data"])`.
- **cw2**: `return df.assign(przychod=df["sztuki"] * df["cena_zl"])`.
- **cw3**: `df[(df["region"] == region) & (df["sztuki"] >= min_sztuk)]`. Indeks zresetuj: `.reset_index(drop=True)`.
- **cw4**: `df.groupby("region")["przychod"].sum().sort_values(ascending=False)`.
- **cw5**: zacznij od `wynik = df.copy()`, potem przypisuj kolumny w `wynik`.
- **cw6**: `pd.pivot_table(..., aggfunc="sum", fill_value=0)`.
- **cw7**: klucz grupowania: `df["data"].dt.to_period("M").astype(str)`; nazwij Series: `.rename("przychod")` i indeks `.rename_axis("miesiac")`.
