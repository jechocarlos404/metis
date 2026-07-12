#!/bin/sh
# Install the metis-export Claude Code skill globally on this machine by
# symlinking it into ~/.claude/skills, so any repository can export a
# metis-seed.json. Because it is a symlink, `git pull` in this repo updates
# the installed skill automatically.
#
# The companion loader skill (.claude/skills/metis-seed-instance) needs no
# install — Claude Code picks up project skills from this repo directly.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="$HOME/.claude/skills/metis-export"

if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    echo "error: $dest exists and is not a symlink — remove it first" >&2
    exit 1
fi

mkdir -p "$HOME/.claude/skills"
ln -sfn "$repo_dir/skills/metis-export" "$dest"
echo "installed: $dest -> $repo_dir/skills/metis-export"
