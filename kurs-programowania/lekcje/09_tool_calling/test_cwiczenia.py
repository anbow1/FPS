"""Testy lekcji 09. Uruchamiaj przez: python kurs.py sprawdz 09

Model jest atrapą: zwraca zaplanowane odpowiedzi w kształcie Messages API.
"""

import importlib
import json
import os
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


@contextmanager
def oczekuj_runtime_error() -> Iterator[None]:
    """Jak assertRaises(RuntimeError), ale przepuszcza NotImplementedError.

    NotImplementedError dziedziczy po RuntimeError, więc zwykłe assertRaises
    zaliczałoby test na niezrobionym ćwiczeniu.
    """
    try:
        yield
    except NotImplementedError:
        raise
    except RuntimeError:
        return
    raise AssertionError("oczekiwano RuntimeError, a funkcja zakończyła się bez błędu")


def kurs_walut(waluta: str) -> float:
    """Zwraca kurs waluty w złotych (dane testowe)."""
    kursy = {"EUR": 4.3, "USD": 3.9}
    if waluta not in kursy:
        raise KeyError(f"brak kursu dla {waluta}")
    return kursy[waluta]


def przelicz(kwota: float, kurs: float, zaokraglij: bool = True) -> float:
    """Mnoży kwotę przez kurs."""
    wynik = kwota * kurs
    return round(wynik, 2) if zaokraglij else wynik


def rejestr_testowy() -> dict[str, Any]:
    return {
        "kurs_walut": cw.Narzedzie(kurs_walut, {
            "name": "kurs_walut", "description": "Kurs waluty w PLN.",
            "input_schema": {"type": "object", "properties": {"waluta": {"type": "string", "enum": ["EUR", "USD", "GBP"]}},
                             "required": ["waluta"]},
        }),
        "przelicz": cw.Narzedzie(przelicz, {
            "name": "przelicz", "description": "Mnoży kwotę przez kurs.",
            "input_schema": {"type": "object",
                             "properties": {"kwota": {"type": "number"}, "kurs": {"type": "number"}, "zaokraglij": {"type": "boolean"}},
                             "required": ["kwota", "kurs"]},
        }),
    }


def atrapa_modelu(odpowiedzi: list[dict[str, Any]]) -> tuple[Any, list[list[dict[str, Any]]]]:
    widziane: list[list[dict[str, Any]]] = []

    def model(wiadomosci: list[dict[str, Any]], narzedzia: list[dict[str, Any]]) -> dict[str, Any]:
        widziane.append(json.loads(json.dumps(wiadomosci)))  # migawka historii w chwili wywołania
        return odpowiedzi[len(widziane) - 1]

    return model, widziane


def tool_use(identyfikator: str, nazwa: str, wejscie: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool_use", "id": identyfikator, "name": nazwa, "input": wejscie}


class TestDefinicje(unittest.TestCase):
    def test_cw1_definicja_pogody(self) -> None:
        """cw1: nazwa, opis i schemat z wymaganym miastem i enum jednostki"""
        definicja = cw.definicja_pogody()
        self.assertEqual(definicja["name"], "pobierz_pogode")
        self.assertTrue(definicja["description"].strip())
        schemat = definicja["input_schema"]
        self.assertEqual(schemat["type"], "object")
        self.assertEqual(schemat["required"], ["miasto"])
        self.assertEqual(schemat["properties"]["miasto"]["type"], "string")
        self.assertTrue(schemat["properties"]["miasto"].get("description"))
        self.assertEqual(schemat["properties"]["jednostka"], {"type": "string", "enum": ["C", "F"]})

    def test_cw2_definicja_z_funkcji(self) -> None:
        """cw2: typy z adnotacji, wymagane = bez wartości domyślnej"""
        self.assertEqual(
            cw.definicja_z_funkcji(przelicz),
            {
                "name": "przelicz",
                "description": "Mnoży kwotę przez kurs.",
                "input_schema": {
                    "type": "object",
                    "properties": {"kwota": {"type": "number"}, "kurs": {"type": "number"}, "zaokraglij": {"type": "boolean"}},
                    "required": ["kwota", "kurs"],
                },
            },
        )

    def test_cw2_funkcja_bez_docstringu_to_blad(self) -> None:
        """cw2: brak docstringu → ValueError"""
        def bez_opisu(x: int) -> int:
            return x
        with self.assertRaises(ValueError):
            cw.definicja_z_funkcji(bez_opisu)


class TestWalidacja(unittest.TestCase):
    SCHEMAT = rejestr_testowy()["przelicz"].definicja["input_schema"]

    def test_cw3_poprawne_wejscie(self) -> None:
        """cw3: int i float są poprawnym number"""
        self.assertEqual(cw.waliduj_wejscie(self.SCHEMAT, {"kwota": 100, "kurs": 4.3}), [])

    def test_cw3_bledy(self) -> None:
        """cw3: brak pola, zły typ (także bool), nieznane pole"""
        self.assertEqual(
            cw.waliduj_wejscie(self.SCHEMAT, {"kwota": "sto", "zaokraglij": 1, "waluta": "EUR"}),
            ["brak wymaganego pola 'kurs'", "pole 'kwota': oczekiwano number",
             "pole 'zaokraglij': oczekiwano boolean", "nieznane pole 'waluta'"],
        )
        self.assertEqual(cw.waliduj_wejscie(self.SCHEMAT, {"kwota": True, "kurs": 1}), ["pole 'kwota': oczekiwano number"])

    def test_cw3_enum_i_nie_obiekt(self) -> None:
        """cw3: wartość spoza enum; lista zamiast obiektu"""
        schemat = rejestr_testowy()["kurs_walut"].definicja["input_schema"]
        self.assertEqual(cw.waliduj_wejscie(schemat, {"waluta": "JPY"}), ["pole 'waluta': wartość 'JPY' spoza [EUR, USD, GBP]"])
        self.assertEqual(cw.waliduj_wejscie(schemat, ["EUR"]), ["wejście musi być obiektem"])


class TestWykonanie(unittest.TestCase):
    def test_cw4_sukces(self) -> None:
        """cw4: wynik liczbowy zamieniony na tekst JSON, bez is_error"""
        wynik = cw.wykonaj_wywolanie(tool_use("t1", "przelicz", {"kwota": 10, "kurs": 4.3}), rejestr_testowy())
        self.assertEqual(wynik, {"type": "tool_result", "tool_use_id": "t1", "content": "43.0"})

    def test_cw4_nieznane_narzedzie(self) -> None:
        """cw4: nieznane narzędzie → is_error"""
        wynik = cw.wykonaj_wywolanie(tool_use("t2", "rm_rf", {}), rejestr_testowy())
        self.assertEqual(wynik, {"type": "tool_result", "tool_use_id": "t2", "content": "nieznane narzędzie 'rm_rf'", "is_error": True})

    def test_cw4_blad_walidacji_nie_wywoluje_funkcji(self) -> None:
        """cw4: złe argumenty → is_error z opisem, funkcja nie rusza"""
        wynik = cw.wykonaj_wywolanie(tool_use("t3", "przelicz", {"kwota": 10}), rejestr_testowy())
        self.assertEqual(wynik["content"], "brak wymaganego pola 'kurs'")
        self.assertIs(wynik["is_error"], True)

    def test_cw4_wyjatek_w_narzedziu(self) -> None:
        """cw4: wyjątek w funkcji → is_error z typem i treścią"""
        wynik = cw.wykonaj_wywolanie(tool_use("t4", "kurs_walut", {"waluta": "GBP"}), rejestr_testowy())
        self.assertIs(wynik["is_error"], True)
        self.assertTrue(wynik["content"].startswith("KeyError:"), wynik["content"])


class TestPetla(unittest.TestCase):
    def test_cw5_dwa_narzedzia_i_odpowiedz(self) -> None:
        """cw5: krok z narzędziem, krok z drugim, odpowiedź końcowa"""
        model, widziane = atrapa_modelu([
            {"stop_reason": "tool_use", "content": [{"type": "text", "text": "Sprawdzam kurs."},
                                                    tool_use("a", "kurs_walut", {"waluta": "EUR"})]},
            {"stop_reason": "tool_use", "content": [tool_use("b", "przelicz", {"kwota": 100, "kurs": 4.3})]},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "100 EUR to "}, {"type": "text", "text": "430 zł."}]},
        ])
        tekst, historia = cw.petla_agenta(model, "Ile to 100 EUR?", rejestr_testowy())
        self.assertEqual(tekst, "100 EUR to 430 zł.")
        self.assertEqual([w["role"] for w in historia], ["user", "assistant", "user", "assistant", "user", "assistant"])
        self.assertEqual(widziane[1][2], {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": "4.3"}]})
        self.assertEqual(widziane[2][4]["content"][0]["content"], "430.0")

    def test_cw5_rownolegle_wywolania_w_jednej_wiadomosci(self) -> None:
        """cw5: dwa tool_use naraz → jedna wiadomość user z dwoma wynikami"""
        model, widziane = atrapa_modelu([
            {"stop_reason": "tool_use", "content": [tool_use("x", "kurs_walut", {"waluta": "EUR"}),
                                                    tool_use("y", "kurs_walut", {"waluta": "USD"})]},
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": "gotowe"}]},
        ])
        cw.petla_agenta(model, "kursy?", rejestr_testowy())
        wyniki = widziane[1][2]["content"]
        self.assertEqual([w["tool_use_id"] for w in wyniki], ["x", "y"])
        self.assertEqual([w["content"] for w in wyniki], ["4.3", "3.9"])

    def test_cw5_limit_krokow(self) -> None:
        """cw5: model w kółko prosi o narzędzie → RuntimeError po max_krokow"""
        zapetlony = {"stop_reason": "tool_use", "content": [tool_use("z", "kurs_walut", {"waluta": "EUR"})]}
        model, widziane = atrapa_modelu([zapetlony] * 3)
        with oczekuj_runtime_error():
            cw.petla_agenta(model, "?", rejestr_testowy(), max_krokow=3)
        self.assertEqual(len(widziane), 3)

    def test_cw5_odmowa_to_blad(self) -> None:
        """cw5: stop_reason "refusal" → RuntimeError"""
        model, _ = atrapa_modelu([{"stop_reason": "refusal", "content": []}])
        with oczekuj_runtime_error():
            cw.petla_agenta(model, "?", rejestr_testowy())


if __name__ == "__main__":
    unittest.main()
