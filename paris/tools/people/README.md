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
