# Ludzie z MakeHuman przez Blendera

`build_people.py` buduje obsadę bulwaru z danych MakeHuman 1.x (CC0): kształt
ciała z targetów (płeć, wiek, pochodzenie, mięśnie, waga, wzrost), ubrania
z powłok pomocniczych siatki bazowej (`helper-tights` → kurtka, płaszcz,
spodnie; `helper-skirt` → poły płaszcza, spódnica; `helper-hair` → włosy),
buty, 163 kości MakeHuman złożone w 15 kości gry, decymacja w Blenderze do
budżetu (pełna ~6 tys. trójkątów, daleka ~1,4 tys.) i AO wypalone Cyclesem
w wierzchołki. Wynik: `<postać>_<lod>.bin` + `.json` (stawy szkieletu).

## Dane

- `base.obj`, `default.mhskel`, `default_weights.mhw` — z
  https://github.com/makehumancommunity/makehuman (`makehuman/data/3dobjs`,
  `makehuman/data/rigs`), CC0.
- targety: `makehuman/data/targets/macrodetails` z tego samego repozytorium,
  CC0 (`git clone --sparse`, `git sparse-checkout set makehuman/data/targets/macrodetails`).

## Uruchomienie

W Blenderze (Python wbudowany):

```bash
blender -b --python build_people.py -- --mh-files <dir> --mh-data <makehuman/data> --out out --preview
```

albo z modułem `bpy` (`pip install bpy==4.2.0`, Python 3.11):

```bash
python -I build_people.py --mh-files <dir> --mh-data <makehuman/data> --out out --preview
```

`--preview` renderuje każdą postać Cyclesem do `out/preview/`. `--only man_coat,woman_skirt` buduje wybrane.

## Wersja z MPFB (prawdziwe ubrania, włosy, skóry) — na PC z Blenderem

`build_people_mpfb.py` buduje 12 postaci z rozszerzenia MPFB i paczki
**MakeHuman system assets** (CC0): skóra (młoda / w średnim wieku / starsza,
według pochodzenia i płci), oczy, brwi, rzęsy, fryzura, ubranie i buty
wybrane po słowach kluczowych z tego, co jest zainstalowane (pierwszy pasujący
wzorzec wygrywa, więc działa z każdą wersją paczki). Każdy element jest
dopasowany przez MPFB i chowa ciało pod sobą; skrypt liczy go w pozie
spoczynkowej, obraca do układu gry, decymuje (pełna ~12 tys. trójkątów,
daleka ~2,2 tys.; brwi, rzęsy i oczy bez decymacji), wypala AO Cyclesem
(OptiX na RTX) z całą postacią w scenie i zapisuje:

- `<postać>_full.bin/.json`, `<postać>_far.bin/.json` — format 2: pozycje,
  normalne, UV, 4 kości z 15 kości gry z wagami, AO; w `.json` stawy
  i zakresy indeksów z materiałem (tekstura, normal map, kolor, szorstkość,
  alpha dla włosów i brwi);
- `tex/` — tekstury przeskalowane (skóra 2048 / 512, ubrania 1024 / 256…),
  wspólne dla postaci.

Wymagania: Blender 4.2+ (działa na 5.x), MPFB 2.0.x z extensions.blender.org,
w MPFB *Apply assets → Load pack* z paczką system assets.

Najprościej na Windows: pobierz cały folder `paris/tools/people` (skrypt
potrzebuje też `build_people.py` i `mhdata.py` obok siebie) i uruchom
`people_mpfb.bat` (lista assetów) albo `people_mpfb.bat build` (budowa).
W `.bat` jest ścieżka do `blender.exe` — popraw ją, jeśli Blender stoi gdzie
indziej. Ręcznie, w wierszu poleceń w tym folderze:

```bat
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --python build_people_mpfb.py -- --list
```

`blender` w poniższych przykładach to właśnie ta pełna ścieżka do `blender.exe`.

```bat
:: lista tego, co MPFB widzi (ubrania, fryzury, skóry, oczy)
blender -b --python build_people_mpfb.py -- --list
:: cała obsada + podglądy z teksturami (out\preview\*.png)
blender -b --python build_people_mpfb.py -- --out out --preview
:: tylko wybrane, albo bez GPU
blender -b --python build_people_mpfb.py -- --out out --only man_suit,woman_african --cpu
```

Na RTX 5090 cała obsada trwa kilka minut. Folder `out` (pliki `.bin`,
`.json`, `tex/`) wrzuć do `paris/src/assets/people/` albo prześlij — gra
wczyta postacie z niego. Jeśli `--list` pokazuje inne nazwy ubrań niż
w `CAST` (np. z innych paczek), wystarczy dopisać je do wzorców postaci.
