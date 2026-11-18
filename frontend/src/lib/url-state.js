import React from "react";

// Selection lives in the query string so a view can be linked to and Back
// returns to the previous selection. User actions push a history entry;
// automatic choices (a default selection, a filter that types per keystroke)
// replace the current one.

export function readParam(key) {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

export function writeParams(params, { push = false } = {}) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  if (url.href === window.location.href) return;
  window.history[push ? "pushState" : "replaceState"](null, "", url);
}

// Calls apply(value) with the param on mount and whenever Back/Forward changes it.
export function useParamRestore(key, apply) {
  const applyRef = React.useRef(apply);
  applyRef.current = apply;
  React.useEffect(() => {
    const run = () => applyRef.current(readParam(key));
    run();
    window.addEventListener("popstate", run);
    return () => window.removeEventListener("popstate", run);
  }, [key]);
}
