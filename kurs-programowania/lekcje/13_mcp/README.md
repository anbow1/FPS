# Lekcja 13 — MCP (Model Context Protocol)

Cel: rozumiesz, jak aplikacje AI podłączają się do narzędzi przez MCP,
piszesz własny serwer MCP na czystym JSON-RPC (bez bibliotek) i podłączasz
go do prawdziwego klienta, np. Claude Code.

## Teoria

### Problem, który rozwiązuje MCP

W lekcji 09 narzędzia były zaszyte w Twoim programie. A gdyby ten sam zestaw
narzędzi (np. „szukaj w firmowej wiki”) miał działać w Claude Code, Claude
Desktop, IDE i Twoim agencie? MCP to **wspólny standard**: piszesz **serwer**
raz, a każda aplikacja-**klient** umie go użyć. Jak USB dla narzędzi AI.

```
 host (Claude Code, IDE, Twój agent)
   │ klient MCP ──── JSON-RPC ────▶ serwer MCP "wiki"   ── Twoja baza wiedzy
   │ klient MCP ──── JSON-RPC ────▶ serwer MCP "github" ── API GitHuba
   └─ model AI dostaje listę narzędzi ze wszystkich serwerów
```

Serwer może udostępniać:

- **tools** — funkcje do wywołania (jak w lekcji 09),
- **resources** — dane do odczytu (pliki, rekordy),
- **prompts** — gotowe szablony poleceń.

### Transport

- **stdio** — klient uruchamia serwer jako proces i rozmawia przez
  stdin/stdout, **jedna wiadomość JSON na linię**. Najprostsze, lokalne.
  Wszystko, co nie jest protokołem (logi!), idzie na **stderr** — `print()`
  na stdout zepsuje komunikację.
- **Streamable HTTP** — serwer zdalny pod adresem URL.

### JSON-RPC 2.0

Trzy rodzaje wiadomości:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}          ← żądanie (czeka na odpowiedź)
{"jsonrpc": "2.0", "id": 1, "result": {"tools": [...]}}                    ← odpowiedź: sukces
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "..."}}   ← odpowiedź: błąd
{"jsonrpc": "2.0", "method": "notifications/initialized"}                  ← powiadomienie: BEZ id, bez odpowiedzi
```

Standardowe kody błędów:

| Kod | Nazwa | Kiedy |
|---|---|---|
| -32700 | Parse error | to nie jest poprawny JSON |
| -32600 | Invalid Request | JSON, ale nie wiadomość JSON-RPC |
| -32601 | Method not found | nieznana metoda |
| -32602 | Invalid params | złe parametry, np. nieznane narzędzie |
| -32603 | Internal error | błąd serwera |

### Cykl życia sesji

```
klient                                         serwer
  │── initialize {protocolVersion, ...} ──────▶│
  │◀── {protocolVersion, capabilities,         │
  │      serverInfo} ──────────────────────────│
  │── notifications/initialized ──────────────▶│   (powiadomienie)
  │── tools/list ─────────────────────────────▶│
  │◀── {tools: [{name, description, inputSchema}]}
  │── tools/call {name, arguments} ───────────▶│
  │◀── {content: [{type: "text", text}], isError}
```

- **Negocjacja wersji**: klient podaje wersję protokołu (np. `"2025-06-18"`).
  Jeśli serwer ją obsługuje — odsyła tę samą; jeśli nie — swoją najnowszą.
- `capabilities` mówią, co serwer umie (`{"tools": {}}` = ma narzędzia).
- Uwaga na nazwę: w MCP schemat argumentów to **`inputSchema`** (camelCase),
  a w API Claude'a — `input_schema`. Klient tłumaczy jedno na drugie.

### Dwa rodzaje błędów przy tools/call

- **Błąd protokołu** (odpowiedź `error`): np. nieznane narzędzie → `-32602`.
- **Błąd wykonania narzędzia** (odpowiedź `result` z `"isError": true` i
  opisem w `content`): np. dzielenie przez zero, złe dane. Ten trafia do
  modelu, który może się poprawić — jak `is_error` w lekcji 09.

### Podłączenie do Claude Code

```bash
claude mcp add kurs -- python C:\sciezka\do\lekcje\13_mcp\cwiczenia.py
claude mcp list
```

W Claude Desktop — w pliku konfiguracyjnym `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kurs": {"command": "python", "args": ["C:\\sciezka\\do\\lekcje\\13_mcp\\cwiczenia.py"]}
  }
}
```

### Oficjalne SDK

Na co dzień nie piszesz JSON-RPC ręcznie — robi to SDK (`pip install mcp`).
W wersji 2.x pakietu wygląda to tak (w 1.x klasa nazywała się `FastMCP` i była
w `mcp.server.fastmcp`) — pełny plik: `serwer_sdk.py`:

```python
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("kurs")

@mcp.tool()
def dodaj(a: float, b: float) -> float:
    """Dodaje dwie liczby."""
    return a + b

if __name__ == "__main__":
    mcp.run()          # stdio
```

SDK buduje `inputSchema` z adnotacji typów i docstringu — dokładnie to, co
napisałeś w lekcji 09 (`definicja_z_funkcji`).

### Bezpieczeństwo

Serwer MCP wykonuje kod na Twojej maszynie na prośbę modelu. Instaluj tylko
zaufane serwery, dawaj minimalne uprawnienia, a wyniki narzędzi traktuj jak
niezaufane dane (mogą zawierać prompt injection).

## Ćwiczenia

Piszesz serwer MCP z dwoma narzędziami (`dodaj`, `licz_slowa`) — gotowe są
definicje narzędzi i pętla `main()` czytająca stdin. Twoje zadania:

1. `odpowiedz_ok(id, wynik)` i `odpowiedz_blad(id, kod, komunikat)`.
2. `obsluz_initialize(params)` — z negocjacją wersji.
3. `obsluz_tools_list()`.
4. `obsluz_tools_call(params)` — dwa rodzaje błędów.
5. `obsluz_wiadomosc(wiadomosc)` — rozdzielanie metod, powiadomienia, błędy.
6. `obsluz_linie(linia)` — tekst → tekst, z błędem parsowania.

Potem zobacz rozmowę klienta z Twoim serwerem: `python klient_demo.py`.

## Podpowiedzi

- **cw2**: `wersja = params.get("protocolVersion")`; jeśli jest w `OBSLUGIWANE_WERSJE`, odeślij ją, inaczej `OBSLUGIWANE_WERSJE[0]`.
- **cw4**: nieznane narzędzie → `raise BladProtokolu(INVALID_PARAMS, ...)`. Wywołanie funkcji w `try`; każdy wyjątek → wynik z `"isError": True` i treścią `f"{type(blad).__name__}: {blad}"`. Wynik funkcji zamień na tekst: `str` bez zmian, reszta `json.dumps(..., ensure_ascii=False)`.
- **cw5**: kolejność: czy to słownik z `"jsonrpc": "2.0"` i napisem w `"method"` (jeśli nie → Invalid Request z `id` z wiadomości albo `None`); czy nie ma `"id"` (powiadomienie → `None`); potem słownik `metoda → funkcja`. `BladProtokolu` łap i zamieniaj na `odpowiedz_blad`.
- **cw6**: `json.loads` w `try`; błąd → `odpowiedz_blad(None, PARSE_ERROR, ...)`. Pusta linia → `None`. Odpowiedź serializuj `json.dumps(..., ensure_ascii=False)` — bez `indent`, bo jedna wiadomość = jedna linia.
