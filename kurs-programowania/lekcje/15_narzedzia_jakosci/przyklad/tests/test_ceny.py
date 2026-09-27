import pytest

from sklep.ceny import cena_z_rabatem, suma_koszyka


def test_rabat_10_procent_od_1000_gr_daje_900() -> None:
    assert cena_z_rabatem(1000, 10) == 900


def test_rabat_zaokragla_w_dol_do_grosza() -> None:
    assert cena_z_rabatem(999, 15) == 849  # 849.15 → 849


@pytest.mark.parametrize("rabat, oczekiwana", [(0, 500), (100, 0), (50, 250)])
def test_rabat_na_granicach(rabat: int, oczekiwana: int) -> None:
    assert cena_z_rabatem(500, rabat) == oczekiwana


@pytest.mark.parametrize("cena, rabat", [(-1, 10), (100, -1), (100, 101)])
def test_zle_dane_to_blad(cena: int, rabat: int) -> None:
    with pytest.raises(ValueError):
        cena_z_rabatem(cena, rabat)


def test_suma_koszyka() -> None:
    assert suma_koszyka([(250, 2), (1000, 1)]) == 1500
    assert suma_koszyka([]) == 0
