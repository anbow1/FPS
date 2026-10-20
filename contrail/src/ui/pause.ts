// The pause screen. On a desktop the flight pauses whenever the mouse is let go
// (Esc, P, or the window losing it); on a phone with the ❚❚ button. The
// simulation stands still behind it (FixedLoop.paused) and the sound stops.
// It only appears once the player has flown: before that the "click to fly"
// banner stands, and the test scripts that drive the game without a pointer
// lock never meet it.

export interface PauseActions {
  resume(): void;
  /** Back to the start menu (reloads the page without the skip-menu parameters). */
  menu(): void;
}

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

export class PauseMenu {
  private readonly root: HTMLDivElement;
  /** The on-screen pause button (touch screens only). */
  readonly touchButton: HTMLButtonElement | null;

  /** Both live on the body: #ui is a fixed (stacking) layer under the touch controls' z-index. */
  constructor(touch: boolean, actions: PauseActions) {
    this.root = document.createElement('div');
    this.root.className = 'menu pause';
    this.root.style.display = 'none';
    const card = document.createElement('div');
    card.className = 'menu-card';
    const title = document.createElement('h1');
    title.textContent = 'PAUSED';
    const note = document.createElement('p');
    note.textContent = touch ? 'The flight is on hold.' : 'The flight is on hold. Resume (or click the view) to take the controls again.';
    const resume = document.createElement('button');
    resume.className = 'go';
    resume.textContent = 'RESUME';
    resume.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.resume();
    });
    const menu = document.createElement('button');
    menu.className = 'quit';
    menu.textContent = 'Main menu';
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.menu();
    });
    const quit = document.createElement('button');
    quit.className = 'quit';
    quit.textContent = 'Quit game';
    quit.addEventListener('click', (e) => {
      e.stopPropagation();
      quitGame(actions.menu);
    });
    card.append(title, note, resume, menu, quit);
    this.root.appendChild(card);
    document.body.appendChild(this.root);
    if (touch) {
      this.touchButton = document.createElement('button');
      this.touchButton.className = 'pause-btn';
      this.touchButton.textContent = '❚❚';
      this.touchButton.setAttribute('aria-label', 'Pause');
      this.touchButton.style.display = 'none';
      document.body.appendChild(this.touchButton);
    } else this.touchButton = null;
  }

  show(): void {
    this.root.style.display = 'flex';
    if (this.touchButton) this.touchButton.style.display = 'none';
  }

  /** Hides the screen; `flying` shows the touch pause button. */
  hide(flying: boolean): void {
    this.root.style.display = 'none';
    if (this.touchButton) this.touchButton.style.display = flying ? 'block' : 'none';
  }
}

/** The page's URL without the parameters that skip the start menu. */
export function menuUrl(): string {
  const u = new URL(window.location.href);
  for (const k of ['autostart', 'spawn']) u.searchParams.delete(k);
  return u.toString();
}
