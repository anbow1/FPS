"""Ceny w groszach (int), żeby uniknąć błędów zaokrągleń floatów."""


def cena_z_rabatem(cena_gr: int, rabat_procent: int) -> int:
    """Cena po rabacie, zaokrąglona w dół do pełnego grosza.

    Rabat 0–100; spoza zakresu albo cena ujemna → ValueError.
    """
    if cena_gr < 0:
        raise ValueError(f"cena nie może być ujemna, dostałem {cena_gr}")
    if not 0 <= rabat_procent <= 100:
        raise ValueError(f"rabat musi być w zakresie 0–100, dostałem {rabat_procent}")
    return cena_gr * (100 - rabat_procent) // 100


def suma_koszyka(pozycje: list[tuple[int, int]]) -> int:
    """Suma pozycji (cena_gr, sztuki). Pusty koszyk → 0."""
    return sum(cena_gr * sztuki for cena_gr, sztuki in pozycje)
