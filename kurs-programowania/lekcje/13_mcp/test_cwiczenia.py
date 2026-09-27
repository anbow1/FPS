"""Testy lekcji 13. Uruchamiaj przez: python kurs.py sprawdz 13"""

import importlib
import json
import os
import subprocess
import sys
import unittest

cw = importlib.import_module(os.environ.get("KURS_MODUL", "cwiczenia"))


def zadanie(identyfikator: int, metoda: str, params: dict | None = None) -> dict:
    wiadomosc = {"jsonrpc": "2.0", "id": identyfikator, "method": metoda}
    if params is not None:
        wiadomosc["params"] = params
    return wiadomosc


class TestOdpowiedzi(unittest.TestCase):
    def test_cw1_ksztalt_odpowiedzi(self) -> None:
        """cw1: odpowiedź-sukces i odpowiedź-błąd JSON-RPC 2.0"""
        self.assertEqual(cw.odpowiedz_ok(7, {"x": 1}), {"jsonrpc": "2.0", "id": 7, "result": {"x": 1}})
        self.assertEqual(
            cw.odpowiedz_blad("a", -32601, "brak"),
            {"jsonrpc": "2.0", "id": "a", "error": {"code": -32601, "message": "brak"}},
        )

    def test_cw2_initialize_zna_wersje_klienta(self) -> None:
        """cw2: znana wersja klienta wraca bez zmian; capabilities i serverInfo"""
        wynik = cw.obsluz_initialize({"protocolVersion": "2025-06-18", "capabilities": {}})
        self.assertEqual(wynik, {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": cw.NAZWA_SERWERA, "version": cw.WERSJA_SERWERA},
        })

    def test_cw2_initialize_nieznana_wersja(self) -> None:
        """cw2: nieznana albo brakująca wersja → nasza najnowsza"""
        self.assertEqual(cw.obsluz_initialize({"protocolVersion": "1999-01-01"})["protocolVersion"], cw.OBSLUGIWANE_WERSJE[0])
        self.assertEqual(cw.obsluz_initialize({})["protocolVersion"], cw.OBSLUGIWANE_WERSJE[0])

    def test_cw3_tools_list(self) -> None:
        """cw3: lista definicji narzędzi z inputSchema"""
        narzedzia = cw.obsluz_tools_list()["tools"]
        self.assertEqual([n["name"] for n in narzedzia], ["dodaj", "licz_slowa"])
        self.assertIn("inputSchema", narzedzia[0])


class TestToolsCall(unittest.TestCase):
    def test_cw4_sukces(self) -> None:
        """cw4: liczba i słownik zamienione na tekst, isError false"""
        self.assertEqual(
            cw.obsluz_tools_call({"name": "dodaj", "arguments": {"a": 2, "b": 40}}),
            {"content": [{"type": "text", "text": "42"}], "isError": False},
        )
        wynik = cw.obsluz_tools_call({"name": "licz_slowa", "arguments": {"tekst": "zażółć gęślą"}})
        self.assertEqual(json.loads(wynik["content"][0]["text"]), {"slowa": 2, "znaki": 12})

    def test_cw4_blad_wykonania_to_iserror(self) -> None:
        """cw4: brak argumentu → isError true z typem wyjątku (bez wyjątku na zewnątrz)"""
        wynik = cw.obsluz_tools_call({"name": "dodaj", "arguments": {"a": 2}})
        self.assertIs(wynik["isError"], True)
        self.assertTrue(wynik["content"][0]["text"].startswith("TypeError:"))

    def test_cw4_nieznane_narzedzie_to_blad_protokolu(self) -> None:
        """cw4: nieznane narzędzie → BladProtokolu z INVALID_PARAMS"""
        with self.assertRaises(cw.BladProtokolu) as kontekst:
            cw.obsluz_tools_call({"name": "usun_wszystko", "arguments": {}})
        self.assertEqual(kontekst.exception.kod, cw.INVALID_PARAMS)


class TestRozdzielanie(unittest.TestCase):
    def test_cw5_metody(self) -> None:
        """cw5: initialize, ping, tools/list, tools/call"""
        self.assertEqual(cw.obsluz_wiadomosc(zadanie(1, "ping")), {"jsonrpc": "2.0", "id": 1, "result": {}})
        self.assertIn("tools", cw.obsluz_wiadomosc(zadanie(2, "tools/list"))["result"])
        wynik = cw.obsluz_wiadomosc(zadanie(3, "tools/call", {"name": "dodaj", "arguments": {"a": 1, "b": 1}}))
        self.assertEqual(wynik["result"]["content"][0]["text"], "2")
        self.assertEqual(cw.obsluz_wiadomosc(zadanie(4, "initialize", {"protocolVersion": "2025-06-18"}))["id"], 4)

    def test_cw5_powiadomienia_bez_odpowiedzi(self) -> None:
        """cw5: wiadomość bez id → None (nawet nieznana metoda)"""
        self.assertIsNone(cw.obsluz_wiadomosc({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertIsNone(cw.obsluz_wiadomosc({"jsonrpc": "2.0", "method": "cokolwiek"}))

    def test_cw5_bledy(self) -> None:
        """cw5: nieznana metoda, zła wiadomość, nieznane narzędzie → odpowiednie kody"""
        self.assertEqual(cw.obsluz_wiadomosc(zadanie(5, "resources/list"))["error"]["code"], cw.METHOD_NOT_FOUND)
        self.assertEqual(cw.obsluz_wiadomosc({"id": 6, "method": "ping"})["error"]["code"], cw.INVALID_REQUEST)
        self.assertEqual(cw.obsluz_wiadomosc([1, 2])["error"]["code"], cw.INVALID_REQUEST)
        blad = cw.obsluz_wiadomosc(zadanie(7, "tools/call", {"name": "brak"}))
        self.assertEqual((blad["id"], blad["error"]["code"]), (7, cw.INVALID_PARAMS))

    def test_cw6_obsluz_linie(self) -> None:
        """cw6: linia JSON → jedna linia odpowiedzi; zły JSON → -32700; pusta → None"""
        odpowiedz = cw.obsluz_linie('{"jsonrpc": "2.0", "id": 1, "method": "ping"}\n')
        self.assertNotIn("\n", odpowiedz)
        self.assertEqual(json.loads(odpowiedz), {"jsonrpc": "2.0", "id": 1, "result": {}})
        blad = json.loads(cw.obsluz_linie("{zepsuty"))
        self.assertEqual((blad["id"], blad["error"]["code"]), (None, cw.PARSE_ERROR))
        self.assertIsNone(cw.obsluz_linie("   \n"))
        self.assertIsNone(cw.obsluz_linie('{"jsonrpc": "2.0", "method": "notifications/initialized"}'))


class TestPrawdziwyProces(unittest.TestCase):
    def test_cw6_serwer_stdio_od_poczatku_do_konca(self) -> None:
        """cw6: uruchomiony serwer odpowiada na stdin → stdout, polskie znaki działają"""
        cw.obsluz_linie('{"jsonrpc": "2.0", "id": 0, "method": "ping"}')  # niezrobione ćwiczenie zgłosi się tu, nie w podprocesie
        wejscie = "".join(json.dumps(w, ensure_ascii=False) + "\n" for w in [
            zadanie(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}}),
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            zadanie(2, "tools/call", {"name": "licz_slowa", "arguments": {"tekst": "zażółć gęślą jaźń"}}),
        ])
        wynik = subprocess.run([sys.executable, cw.__file__], input=wejscie, capture_output=True,
                               text=True, encoding="utf-8", timeout=20, check=True)
        odpowiedzi = [json.loads(linia) for linia in wynik.stdout.splitlines()]
        self.assertEqual([o["id"] for o in odpowiedzi], [1, 2])
        self.assertEqual(json.loads(odpowiedzi[1]["result"]["content"][0]["text"]), {"slowa": 3, "znaki": 17})


if __name__ == "__main__":
    unittest.main()
