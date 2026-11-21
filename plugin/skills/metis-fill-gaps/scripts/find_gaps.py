#!/usr/bin/env python3
"""List the features of this repo's product whose capabilities are unknown.

Read-only. Stdlib only. The product is found the same way the metis plugin's
hooks find it, with exact matches only:
  1. metis-seed.json at the repo root names one of our (non-external) products;
  2. else the repo's directory name (the main checkout's, in a worktree),
     slugified, equals one of our products' slugs.
Pass --product "<exact name>" to name it yourself instead.

With auth on, pass a token (--token, or METIS_TOKEN / METIS_API_TOKEN): any
valid token reads, including the read-only metis-mcp service account's.

Usage: python3 find_gaps.py [--repo DIR] [--product NAME] [--base-url URL] [--token TOKEN]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request


def slugify(value):
    """The backend's slug rule: accents folded, then lowercase kebab."""
    folded = "".join(
        c for c in unicodedata.normalize("NFKD", value) if not unicodedata.category(c).startswith("M")
    )
    return re.sub(r"[^a-z0-9]+", "-", folded.strip().lower()).strip("-")


def get(base, path, token):
    req = urllib.request.Request(base.rstrip("/") + path)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            why = "the token was refused (expired? they last 5 minutes)" if token else "no token was sent"
            sys.exit(f"error: GET {path} returned 401: the API has auth on and {why}. "
                     "Pass --token or set METIS_TOKEN; see the skill's SKILL.md.")
        raise


def git(cwd, *args):
    out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else None


def repo(cwd):
    """(root, name). In a worktree, name is the main checkout's directory."""
    root = git(cwd, "rev-parse", "--show-toplevel")
    if not root:
        return cwd, os.path.basename(os.path.abspath(cwd))
    common = os.path.abspath(os.path.join(cwd, git(cwd, "rev-parse", "--git-common-dir") or ".git"))
    if os.path.basename(common) == ".git":
        return root, os.path.basename(os.path.dirname(common))
    return root, os.path.basename(root)


def identify(products, cwd):
    root, name = repo(cwd)
    ours = [p for p in products if not p["external"]]
    seed = os.path.join(root, "metis-seed.json")
    if os.path.isfile(seed):
        try:
            with open(seed) as fh:
                declared = {p.get("name") for p in json.load(fh).get("products") or []
                            if isinstance(p, dict) and not p.get("external")}
            hits = [p for p in ours if p["name"] in declared]
            if len(hits) == 1:
                return hits[0], root, "metis-seed.json"
        except (OSError, ValueError, AttributeError):
            pass
    hit = next((p for p in ours if p["slug"] == slugify(name)), None)
    return hit, root, ("repo name" if hit else None)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default=os.getcwd())
    ap.add_argument("--product", help="exact product name, instead of finding it from the repo")
    ap.add_argument("--base-url", default=os.environ.get("METIS_API_URL", "http://localhost:8000"))
    ap.add_argument(
        "--token",
        default=os.environ.get("METIS_TOKEN") or os.environ.get("METIS_API_TOKEN"),
        help="bearer token for an instance with auth on (default: $METIS_TOKEN, else $METIS_API_TOKEN)",
    )
    args = ap.parse_args()

    try:
        products = get(args.base_url, "/api/products", args.token)
        features = get(args.base_url, "/api/features", args.token)
        cap_names = {c["id"]: c["name"] for c in get(args.base_url, "/api/capabilities", args.token)}
    except OSError as e:
        sys.exit(f"error: metis at {args.base_url} is unreachable: {e}")

    root = os.path.abspath(args.repo)
    if args.product:
        product = next((p for p in products if p["name"] == args.product), None)
        how = "--product"
    else:
        product, root, how = identify(products, args.repo)
    if product is None:
        sys.exit("stop: this repo is not a known product in metis (no exact match). "
                 "Export it first with the metis-export skill.")
    if product["external"]:
        sys.exit(f"stop: {product['name']!r} is an external product, with no code of ours to read. "
                 "Use the metis-map-outside-product skill instead.")

    gaps = [f for f in features if f["product_id"] == product["id"] and f.get("unknown_capabilities")]
    print(f"product: {product['name']} (slug {product['slug']}, id {product['id']}, matched by {how})")
    print(f"repo: {root}")
    print(f"features with unknown capabilities: {len(gaps)}")
    for f in sorted(gaps, key=lambda f: f["name"]):
        known = ", ".join(sorted(cap_names.get(c, c) for c in f.get("capability_ids") or [])) or "none"
        desc = (f.get("description") or "").replace("\n", " ")[:160]
        print(f"- {f['name']}\n    status {f.get('status')}; already confirmed: {known}\n    {desc}")
    if not gaps:
        print("stop: nothing to fill.")


if __name__ == "__main__":
    main()
