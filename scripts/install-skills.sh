#!/bin/sh
# Install the metis-export Claude Code skill globally on this machine by
# symlinking it into ~/.claude/skills, so any repository can export a
# metis-seed.json. Because it is a symlink, `git pull` in this repo updates
# the installed skill automatically.
#
# The companion loader and unseed skills live next to it in
# plugin/skills/ and ship with the metis Claude Code plugin.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="$HOME/.claude/skills/metis-export"

if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "error: $dest exists and is not a symlink — remove it first" >&2
    exit 1
fi

mkdir -p "$HOME/.claude/skills"
ln -sfn "$repo_dir/plugin/skills/metis-export" "$dest"
echo "installed: $dest -> $repo_dir/plugin/skills/metis-export"
