// Player profile panel: nickname + player code (export / import). A native <dialog>, built on first open so the game's
// first paint does not pay for it. All logic lives in transfer.ts; this file is DOM only.
import { CodeError, NAME_KEY, cleanName, codeLink, encode, extractCode, importCode, snapshot, type KVStore } from "./transfer.ts";
import { pt } from "./i18n.ts";
import "./profile.css";

type Store = KVStore & { removeItem?(k: string): void };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

function countLocal(kv: Store) {
  let days = 0, moments = 0;
  try { days = Object.keys(JSON.parse(kv.getItem("pm.days") ?? "{}") as object).length; } catch { /* none */ }
  try {
    const m = JSON.parse(kv.getItem("pm.moments") ?? "{}") as Record<string, unknown[]>;
    moments = Object.values(m).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  } catch { /* none */ }
  return { days, moments };
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export interface ProfileOptions {
  kv?: Store;
  /** Page address the code link should open (defaults to this page without its fragment). */
  base?: string;
  /** Called after a successful import so the page can refresh its stats. */
  onImported?: () => void;
  /** A code to offer for import right away (from a #code= link). */
  pendingCode?: string;
}

let dialog: HTMLDialogElement | null = null;

export function openProfile(opts: ProfileOptions = {}): HTMLDialogElement {
  const kv: Store = opts.kv ?? localStorage;
  const base = opts.base ?? location.href.split("#")[0]!;
  dialog?.remove();

  const status = (live: HTMLElement, text: string, bad = false) => { live.textContent = text; live.classList.toggle("bad", bad); };

  // nickname
  const nameIn = el("input", { id: "pf-name", type: "text", maxLength: 20, autocomplete: "nickname", placeholder: pt("profile.namePh"), value: kv.getItem(NAME_KEY) ?? "" });
  const nameMsg = el("span", { className: "pf-msg fine", role: "status" });
  nameIn.addEventListener("change", () => {
    const v = cleanName(nameIn.value);
    nameIn.value = v;
    try { kv.setItem(NAME_KEY, v); status(nameMsg, pt("profile.nameSaved")); } catch { /* storage blocked */ }
  });

  // export
  const codeOut = el("textarea", { className: "pf-code", readOnly: true, rows: 3, hidden: true, ariaLabel: pt("profile.code.h") });
  const exportMsg = el("p", { className: "pf-msg fine", role: "status" });
  const make = el("button", { type: "button", className: "primary" }, pt("profile.code.make"));
  const copyBtn = el("button", { type: "button", className: "ghost", hidden: true }, pt("profile.code.copy"));
  const fileBtn = el("button", { type: "button", className: "ghost", hidden: true }, pt("profile.code.file"));
  const linkBtn = el("button", { type: "button", className: "ghost", hidden: true }, pt("profile.code.link"));
  let code = "";
  make.addEventListener("click", async () => {
    make.disabled = true;
    code = await encode(snapshot(kv));
    codeOut.value = code; codeOut.hidden = false;
    copyBtn.hidden = fileBtn.hidden = linkBtn.hidden = false;
    make.remove();
    codeOut.select();
  });
  copyBtn.addEventListener("click", async () => { if (await copy(code)) status(exportMsg, pt("profile.code.copied")); else codeOut.select(); });
  linkBtn.addEventListener("click", async () => { if (await copy(codeLink(base, code))) status(exportMsg, pt("profile.code.linkCopied")); });
  fileBtn.addEventListener("click", () => {
    const a = el("a", { href: URL.createObjectURL(new Blob([code + "\n"], { type: "text/plain" })), download: "playmaker-player-code.txt" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // import
  const importIn = el("textarea", { id: "pf-import", className: "pf-code", rows: 3, placeholder: pt("profile.import.ph"), spellcheck: false });
  const importMsg = el("p", { className: "pf-msg", role: "status" });
  const importBtn = el("button", { type: "button", className: "primary" }, pt("profile.import.go"));
  const stats = el("p", { className: "fine pf-stats" });
  const showStats = () => { const c = countLocal(kv); stats.textContent = pt("profile.stats", c); };
  importBtn.addEventListener("click", async () => {
    const text = importIn.value.trim();
    if (!text) { importIn.focus(); return; }
    importBtn.disabled = true;
    try {
      const sum = await importCode(kv, extractCode(text));
      status(importMsg, pt("profile.import.ok", { days: sum.days, moments: sum.moments }));
      importIn.value = ""; showStats(); opts.onImported?.();
    } catch (e) {
      const reason = e instanceof CodeError ? e.reason : "corrupt";
      status(importMsg, pt(`profile.import.${reason}`), true);
    } finally { importBtn.disabled = false; }
  });
  if (opts.pendingCode) { importIn.value = opts.pendingCode; status(importMsg, pt("profile.import.fromLink")); }

  const close = el("button", { type: "button", className: "pf-close", ariaLabel: pt("profile.close") }, "×");
  dialog = el("dialog", { className: "profile card", ariaLabel: pt("profile.title") },
    el("header", { className: "pf-head" }, el("h2", {}, pt("profile.title")), close),
    el("p", { className: "fine" }, pt("profile.lead")),
    stats,
    el("label", { className: "pf-field", htmlFor: "pf-name" }, el("span", {}, pt("profile.name")), nameIn, nameMsg),
    el("section", { className: "pf-sec" },
      el("h3", {}, pt("profile.code.h")), el("p", { className: "fine" }, pt("profile.code.fine")),
      make, codeOut, el("div", { className: "pf-row" }, copyBtn, linkBtn, fileBtn), exportMsg),
    el("section", { className: "pf-sec" },
      el("h3", {}, pt("profile.import.h")), el("p", { className: "fine" }, pt("profile.import.fine")),
      el("label", { className: "sr-only", htmlFor: "pf-import" }, pt("profile.import.h")), importIn, importBtn, importMsg),
  );
  close.addEventListener("click", () => dialog?.close());
  dialog.addEventListener("close", () => { dialog?.remove(); dialog = null; });
  document.body.append(dialog);
  showStats();
  dialog.showModal();
  (opts.pendingCode ? importBtn : nameIn).focus();
  return dialog;
}

/** If the page was opened from a code link (#code=...), returns the code and clears it from the address bar. */
export function takeLinkCode(): string | null {
  const m = /[#&]code=([^&]+)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try { return decodeURIComponent(m[1]!); } catch { return null; }
}
