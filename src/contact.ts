/**
 * The author card, bottom right: who built this, the "available for work"
 * status, and the links that matter — the source code, the feed the work is
 * posted to and the studio site.
 *
 * Styled like the rest of the app's chrome (the preloader, the busy pill):
 * frosted white, hairlines, tracked-out capitals. The ring around the portrait
 * takes the accent of the building on the stage, so the card follows the city
 * rather than a fixed brand colour. The source link is the exception: it is
 * gold whatever the city, and stays out as a pill when the card is collapsed
 * (the default on phones), so the code is always one tap away.
 *
 * The lil-gui column hangs from the top-right corner and can grow down into
 * this one; the card keeps its height in `--contact-clear` and the column's
 * max-height leaves that much room (contact.css), so the GUI scrolls instead
 * of sliding under the card.
 */
import "./contact.css";

const SITE_URL = "https://chirostudio.xyz";
const X_URL = "https://x.com/chirovisuals";
const REPO_URL = "https://github.com/achrefelouafi/ProdceduralBuildingsThreeJS";

/** GitHub's mark (Octicons mark-github, 24 box) */
const ICON_GITHUB = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522
      0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554
      -.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907
      .096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956
      -.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371
      c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915
      .701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035
      0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12
      c0-6.077-4.922-11-11-11Z"/>
  </svg>`;

/** X, from the official mark, in a 24 box so it sits on the pixel grid at 13px */
const ICON_X = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68
      l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>`;

/** a globe for the studio — stroked, hairline like the rest of the card */
const ICON_SITE = `
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M3.4 9h17.2M3.4 15h17.2"/>
    <path d="M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/>
  </svg>`;

const ICON_GO = `
  <svg class="contact__go" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 17 17 7M9 7h8v8"/>
  </svg>`;

const link = (href: string, className: string, icon: string, label: string, sub: string) => `
  <a class="contact__link ${className}" href="${href}" target="_blank" rel="noopener noreferrer">
    <span class="contact__icon">${icon}</span>
    <span class="contact__link-text"><b>${label}</b><em>${sub}</em></span>
    ${ICON_GO}
  </a>`;

const MARKUP = `
  <aside id="contact" class="contact-wrap" aria-label="About the author">
    <div class="contact">
      <button class="contact__toggle" type="button" aria-label="Hide the contact card" title="Hide">
        <span class="contact__toggle-bar"></span>
      </button>

      <div class="contact__head">
        <div class="contact__portrait">
          <span class="contact__frame">
            <img src="contact/p.jpg" alt="Portrait of Chiro" decoding="async" draggable="false" />
          </span>
        </div>
        <div class="contact__who">
          <span class="contact__status"><i></i>Available for work</span>
          <span class="contact__name">Chiro</span>
          <span class="contact__role">Creative dev &mdash; 3D, motion, games</span>
        </div>
      </div>

      <div class="contact__rule"><b></b></div>

      <p class="contact__note">
        Blender geometry nodes, evaluated live in three.js. Your building could be next.
      </p>

      <div class="contact__links">
        ${link(REPO_URL, "contact__link--code", ICON_GITHUB, "Get the source code", "Open source &middot; MIT &middot; GitHub")}
        ${link(X_URL, "contact__link--x", ICON_X, "@chirovisuals", "Work in motion, daily")}
        ${link(SITE_URL, "contact__link--site", ICON_SITE, "chirostudio.xyz", "Portfolio &amp; contact")}
      </div>
    </div>

    <a class="contact__code-pill" href="${REPO_URL}" target="_blank" rel="noopener noreferrer"
      aria-label="Get the source code on GitHub">
      ${ICON_GITHUB}<span>Get the code</span>
    </a>
  </aside>`;

const STORE_KEY = "chiro.contact.collapsed";

/**
 * Where the card opens by default: below this it starts as the portrait alone
 * (which fits anywhere), so a small window keeps its room for the GUI.
 */
const ROOM = "(min-width: 760px) and (min-height: 640px)";

/** gap kept between the bottom of the GUI column and the top of the card */
const GUI_GAP = 12;

/** reads / writes are best-effort: private windows throw on the first touch */
function readCollapsed(): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORE_KEY);
  } catch {
    /* fall through to the window's own answer */
  }
  if (stored !== null) return stored === "1";
  return !window.matchMedia(ROOM).matches;
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORE_KEY, collapsed ? "1" : "0");
  } catch {
    /* the card just forgets between visits */
  }
}

export class ContactCard {
  private readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private collapsed = false;

  constructor() {
    const holder = document.createElement("div");
    holder.innerHTML = MARKUP.trim();
    this.root = holder.firstElementChild as HTMLElement;
    this.toggle = this.root.querySelector(".contact__toggle")!;
    document.body.appendChild(this.root);

    this.setCollapsed(readCollapsed(), true);
    this.toggle.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    new ResizeObserver(() => this.clearGui()).observe(this.root);
  }

  setCollapsed(collapsed: boolean, silent = false): void {
    this.collapsed = collapsed;
    this.root.classList.toggle("is-collapsed", collapsed);
    this.toggle.setAttribute("aria-label", collapsed ? "Show the contact card" : "Hide the contact card");
    this.toggle.title = collapsed ? "Work with me" : "Hide";
    if (!silent) writeCollapsed(collapsed);
  }

  /** tint the portrait ring (and the studio link) with the building's accent */
  setAccent(accent: string): void {
    this.root.style.setProperty("--contact-accent", accent);
  }

  /** the entrance, once the preloader has cleared */
  reveal(): void {
    this.root.classList.add("is-ready");
  }

  /** room the GUI column leaves at the bottom of the window for the card */
  private clearGui(): void {
    const bottom = parseFloat(getComputedStyle(this.root).bottom) || 0;
    const clear = this.root.offsetHeight + bottom + GUI_GAP;
    document.documentElement.style.setProperty("--contact-clear", `${clear}px`);
  }
}
