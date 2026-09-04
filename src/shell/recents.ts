import { escapeHtml } from "../viewer/markdown";

// ---------- 最近のファイル ----------
type Recent = { path: string; name: string };

function load(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem("recents") ?? "[]");
  } catch {
    return [];
  }
}

export function pushRecent(path: string, name: string) {
  const list = [{ path, name }, ...load().filter((r) => r.path !== path)].slice(0, 8);
  localStorage.setItem("recents", JSON.stringify(list));
}

export function renderRecents(
  section: HTMLElement,
  list: HTMLElement,
  onPick: (path: string) => void
) {
  const items = load();
  section.classList.toggle("hidden", items.length === 0);
  list.innerHTML = items
    .map(
      (r) =>
        `<li><button data-path="${escapeHtml(r.path)}">
          <span class="ink-r-name">${escapeHtml(r.name)}</span>
          <span class="ink-r-path">${escapeHtml(r.path)}</span>
        </button></li>`
    )
    .join("");
  list
    .querySelectorAll<HTMLButtonElement>("button[data-path]")
    .forEach((b) => b.addEventListener("click", () => onPick(b.dataset.path!)));
}
