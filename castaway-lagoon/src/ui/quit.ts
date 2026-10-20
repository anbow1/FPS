/**
 * Ends the game: in the Android app it closes the app (GameActivity's AndroidApp bridge); in a
 * browser it closes the tab where the page may, and otherwise falls back (the start menu) — a tab
 * the player opened ignores window.close().
 */
export function quitGame(fallback: () => void): void {
  const app = (window as unknown as { AndroidApp?: { quit(): void } }).AndroidApp;
  if (app) {
    app.quit();
    return;
  }
  window.close();
  setTimeout(fallback, 200);
}
