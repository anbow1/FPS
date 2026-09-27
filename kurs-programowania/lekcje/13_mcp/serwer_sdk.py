"""Ten sam serwer na oficjalnym SDK (opcjonalne): python -m pip install "mcp>=2"

    python serwer_sdk.py          # serwer stdio — podłącz go do klienta MCP

W pakiecie mcp 1.x ta klasa nazywała się FastMCP (from mcp.server.fastmcp import FastMCP).
"""

from mcp.server.mcpserver import MCPServer

mcp = MCPServer("kurs-sdk")


@mcp.tool()
def dodaj(a: float, b: float) -> float:
    """Dodaje dwie liczby."""
    return a + b


@mcp.tool()
def licz_slowa(tekst: str) -> dict[str, int]:
    """Liczy słowa i znaki w tekście."""
    return {"slowa": len(tekst.split()), "znaki": len(tekst)}


if __name__ == "__main__":
    mcp.run()
