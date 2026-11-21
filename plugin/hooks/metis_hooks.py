#!/usr/bin/env python3
"""Claude Code hooks for metis. Read-only, stdlib only, Python 3.9+.

    python3 -I metis_hooks.py session-start      # product brief as context
    python3 -I metis_hooks.py user-prompt        # one-line reuse nudge
    python3 -I metis_hooks.py stop               # re-export reminder, once per session

Each reads the hook's JSON on stdin and never writes to metis. When metis is
unreachable, the repo is not a known product, or anything else goes wrong, it
prints nothing and exits 0, so a hook can never get in the way of a session.

The product is identified exactly, never fuzzily: a non-external product named
in metis-seed.json at the repo root whose name equals one product's name in
metis, else the git repo's directory name, slugified, equal to a product slug.
"""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
from datetime import datetime
import urllib.parse
import urllib.request

API = os.environ.get("METIS_API_URL", "http://localhost:8000").rstrip("/")
HTTP_TIMEOUT = 3.0
CACHE_TTL = 600  # seconds
SEED_FILE = "metis-seed.json"
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(value):
    """Same rule as backend/app/services/slugs.py: accents folded first."""
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.category(c).startswith("M")
    )
    return _NON_ALNUM.sub("-", folded.strip().lower()).strip("-")


# ---- local state ----


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_dir = []  # resolved once per process: [path or None]


def _data_dir():
    """CLAUDE_PLUGIN_DATA, else ~/.cache/metis-claude-plugin, created 0700.
    None when it is a symlink, not ours, or group/world writable: then nothing
    is cached and the Stop reminder stays off, rather than trusting files
    someone else could plant."""
    if not _dir:
        path = os.environ.get("CLAUDE_PLUGIN_DATA") or os.path.join(
            os.path.expanduser("~"), ".cache", "metis-claude-plugin"
        )
        try:
            os.makedirs(path, mode=0o700, exist_ok=True)
            st = os.lstat(path)
            safe = stat.S_ISDIR(st.st_mode) and not st.st_mode & 0o022
            if hasattr(os, "getuid"):
                safe = safe and st.st_uid == os.getuid()
        except OSError:
            safe = False
        _dir.append(path if safe else None)
    return _dir[0]


def _state(name):
    """A file in the data dir, keyed by the API it describes, or None."""
    root = _data_dir()
    if not root:
        return None
    tag = hashlib.sha1(API.encode()).hexdigest()[:8]
    return os.path.join(root, f"{name}-{tag}.json")


def _read(path):
    """(value, mtime). Never follows a symlink."""
    fd = os.open(path, os.O_RDONLY | _NOFOLLOW)
    with os.fdopen(fd) as f:
        return json.load(f), os.fstat(f.fileno()).st_mtime


def _write(path, value):
    """A fresh 0600 file from mkstemp, renamed over the target. A rename
    replaces a planted symlink instead of writing through it."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


# ---- the API ----


def _token():
    """METIS_API_TOKEN if set. Else, with METIS_API_CLIENT_SECRET, a client
    credentials token from Keycloak, cached until shortly before it expires."""
    token = os.environ.get("METIS_API_TOKEN")
    if token:
        return token
    secret = os.environ.get("METIS_API_CLIENT_SECRET")
    if not secret:
        return None
    path = _state("token")
    try:
        cached, _ = _read(path)
        if cached["expires_at"] > time.time() + 30:
            return cached["access_token"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    url = "{}/realms/{}/protocol/openid-connect/token".format(
        os.environ.get("METIS_KEYCLOAK_URL", "http://localhost:8080").rstrip("/"),
        os.environ.get("METIS_KEYCLOAK_REALM", "metis"),
    )
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": os.environ.get("METIS_API_CLIENT_ID", "metis-mcp"),
            "client_secret": secret,
        }
    ).encode()
    with urllib.request.urlopen(url, body, timeout=HTTP_TIMEOUT) as resp:
        grant = json.load(resp)
    if path:
        _write(
            path,
            {
                "access_token": grant["access_token"],
                "expires_at": time.time() + int(grant.get("expires_in", 60)),
            },
        )
    return grant["access_token"]


def _get(path):
    request = urllib.request.Request(API + path, headers={"Accept": "application/json"})
    token = _token()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as resp:
        return json.load(resp)


def _cached(name, path, trim):
    """One GET per CACHE_TTL. The stored copy is trimmed to what hooks read."""
    file = _state(name)
    try:
        value, mtime = _read(file)
        if time.time() - mtime < CACHE_TTL:
            return value
    except (OSError, ValueError, TypeError):
        pass
    value = trim(_get(path))
    if file:
        _write(file, value)
    return value


def _ref(p):
    return {"id": p["id"], "slug": p["slug"], "name": p["name"]}


def products():
    return _cached(
        "products",
        "/api/products",
        lambda rows: [
            dict(
                _ref(p),
                external=bool(p.get("external")),
                # Left absent, not None, when an older metis does not report it.
                **({"seeded_at": p["seeded_at"]} if "seeded_at" in p else {}),
            )
            for p in rows
        ],
    )


def freshness(product):
    """(phrase, days) for how fresh the product's map is, worded as the
    desktop words it (frontend/src/lib/words.js). days is None when it was
    never imported. None when metis does not report it."""
    if "seeded_at" not in product:
        return None
    seeded = product["seeded_at"]
    if seeded is None:
        return "never imported from a seed file", None
    # Python 3.9 parses neither "Z" nor every fraction length; days need neither.
    when = datetime.fromisoformat(re.sub(r"\.\d+", "", seeded).replace("Z", "+00:00"))
    days = max(0, int((time.time() - when.timestamp()) // 86400))

    def count(n, unit):
        return f"{n} {unit}" + ("" if n == 1 else "s")

    if days == 0:
        phrase = "updated today"
    elif days < 30:
        phrase = f"updated {count(days, 'day')} ago"
    elif days < 365:
        phrase = f"updated {count(days // 30, 'month')} ago"
    else:
        phrase = f"updated {count(days // 365, 'year')} ago"
    return phrase, days


def inventory():
    return _cached(
        "inventory",
        "/api/capabilities/inventory",
        lambda rows: [
            {
                "name": e["name"],
                "slug": e["slug"],
                "products": [_ref(p) for p in e.get("products", [])],
            }
            for e in rows
        ],
    )


# ---- which product is this repo? ----


def _git(cwd, *args):
    out = subprocess.run(
        ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=2
    )
    return out.stdout.strip() if out.returncode == 0 else None


def repo(cwd):
    """(root, name). In a worktree the name is the main checkout's directory,
    not the worktree's."""
    root = _git(cwd, "rev-parse", "--show-toplevel")
    if not root:
        return cwd, os.path.basename(os.path.abspath(cwd))
    common = _git(cwd, "rev-parse", "--git-common-dir") or ".git"
    common = os.path.abspath(os.path.join(cwd, common))
    if os.path.basename(common) == ".git":
        return root, os.path.basename(os.path.dirname(common))
    return root, os.path.basename(root)


def identify(cwd):
    """(product, root, how) or (None, root, None). Exact matches only."""
    root, name = repo(cwd)
    ours = [p for p in products() if not p["external"]]
    seed = os.path.join(root, SEED_FILE)
    if os.path.isfile(seed):
        try:
            with open(seed) as f:
                declared = {
                    p.get("name")
                    for p in json.load(f).get("products") or []
                    if isinstance(p, dict) and not p.get("external")
                }
            hits = [p for p in ours if p["name"] in declared]
            if len(hits) == 1:
                return hits[0], root, SEED_FILE
        except (OSError, ValueError, AttributeError):
            pass
    slug = slugify(name)
    hit = next((p for p in ours if p["slug"] == slug), None)
    return hit, root, ("repo name" if hit else None)


def _names(refs, limit):
    names = [r["name"] for r in refs]
    more = len(names) - limit
    return ", ".join(names[:limit]) + (f" (+{more} more)" if more > 0 else "")


# ---- hooks ----


def session_start(event):
    product, _, how = identify(event.get("cwd") or os.getcwd())
    if not product:
        return None
    pid = product["id"]
    coverage = _get(f"/api/products/{pid}/coverage")
    mine = [e for e in inventory() if any(p["id"] == pid for p in e["products"])]
    shared = []
    for entry in mine:  # the inventory is already most reused first
        others = [p for p in entry["products"] if p["id"] != pid]
        if others:
            shared.append((entry, others))
    lines = [
        f"metis: this repo is the product {product['name']} ({product['slug']}), "
        f"matched by {how}.",
        f"{coverage['total_features']} feature(s), {len(mine)} capabilit(ies), "
        f"{len(shared)} shared with other products.",
    ]
    fresh = freshness(product)
    if fresh:
        lines.append(f"Its map in metis was {fresh[0]}.")
    if shared:
        lines.append("Shared capabilities, most reused first (capability -> other products):")
        for entry, others in shared[:15]:
            lines.append(f"- {entry['name']} -> {_names(others, 4)}")
        if len(shared) > 15:
            lines.append(f"- ... and {len(shared) - 15} more")
    lines.append(
        "Before building a capability, check metis for reuse with the metis MCP tools "
        "(check_idea, capability). metis is read-only here."
    )
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n".join(lines),
        }
    }


def user_prompt(event):
    prompt = event.get("prompt") or ""
    if not prompt.strip():
        return None
    product, _, _ = identify(event.get("cwd") or os.getcwd())
    if not product:
        return None
    found = []
    for entry in inventory():
        others = [p for p in entry["products"] if p["id"] != product["id"]]
        if not others:
            continue
        pattern = r"(?<!\w)" + re.escape(entry["name"]) + r"(?!\w)"
        if re.search(pattern, prompt, re.IGNORECASE):
            found.append(f"{entry['name']} ({entry['slug']}) already exists in {_names(others, 3)}")
    if not found:
        return None
    line = "metis: " + "; ".join(found[:3])
    line += ". Look at how it was built there before writing it again (metis capability tool)."
    return {
        "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": line}
    }


def _changed_outside_seed(root):
    """True when the working tree has changes to anything but seed files."""
    out = subprocess.run(
        ["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        capture_output=True,
        text=True,
        timeout=2,
    )
    if out.returncode != 0:
        return False
    entries = out.stdout.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        status, path = entry[:2], entry[3:]
        if "R" in status or "C" in status:
            i += 1  # the original path follows a rename or copy
        base = os.path.basename(path)
        if not (base.startswith("metis-seed") and base.endswith(".json")):
            return True
    return False


def stop(event):
    if event.get("stop_hook_active"):
        return None
    session = re.sub(r"[^A-Za-z0-9_-]", "", str(event.get("session_id") or ""))
    if not session:
        return None
    root = _data_dir()
    if not root:
        return None  # no safe place to remember it, so no promise of once
    marker = os.path.join(root, f"stop-reminded-{session}")
    if os.path.lexists(marker):
        return None
    product, root, _ = identify(event.get("cwd") or os.getcwd())
    if not product or not _changed_outside_seed(root):
        return None
    _write(marker, {})
    fresh = freshness(product)
    stale = fresh is not None and (fresh[1] is None or fresh[1] > 7)
    return {
        "systemMessage": (
            f"metis: {product['name']} has code changes. Re-export its seed file with "
            "the metis-export skill so metis stays accurate."
            + (f" Its map was {fresh[0]}." if stale else "")
        )
    }


HOOKS = {"session-start": session_start, "user-prompt": user_prompt, "stop": stop}


def main():
    try:
        event = json.load(sys.stdin)
        result = HOOKS[sys.argv[1]](event)
        if result:
            sys.stdout.write(json.dumps(result))
    except Exception:  # never let metis being down get in a session's way
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
