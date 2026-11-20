"""The docs that count the MCP tools and the plugin's skills agree with the code.

model.md is served to agents as metis://ontology/model, so a stale count there
is a wrong answer, not just a stale page.
"""

import re
from pathlib import Path

import pytest

from app.mcp.server import TOOLS

ROOT = Path(__file__).resolve().parents[2]
DOCS = ["README.md", "docs/mcp.md", "plugin/README.md", "backend/app/ontology/model.md"]
WORDS = {
    w: n
    for n, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen "
        "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}


@pytest.mark.parametrize("doc", DOCS)
def test_every_tool_count_is_the_real_one(doc):
    text = (ROOT / doc).read_text()
    said = [
        int(c) if c.isdigit() else WORDS[c.lower()]
        for c in re.findall(r"\b(\d+|[A-Za-z]+) tools\b", text)
        if c.isdigit() or c.lower() in WORDS
    ]
    assert all(n == len(TOOLS) for n in said), (doc, said)


@pytest.mark.parametrize("doc", ["README.md", "docs/mcp.md", "backend/app/ontology/model.md"])
def test_every_tool_is_named(doc):
    text = (ROOT / doc).read_text()
    assert [t.name for t in TOOLS if f"`{t.name}`" not in text] == [], doc


def _skills():
    return sorted(
        p.name for p in (ROOT / "plugin/skills").iterdir() if (p / "SKILL.md").exists()
    )


@pytest.mark.parametrize("doc", DOCS)
def test_every_skill_count_is_the_real_one(doc):
    text = (ROOT / doc).read_text()
    said = [
        int(c) if c.isdigit() else WORDS[c.lower()]
        for c in re.findall(r"\b(\d+|[A-Za-z]+) skills\b", text)
        if c.isdigit() or c.lower() in WORDS
    ]
    assert all(n == len(_skills()) for n in said), (doc, said)


def test_the_plugin_readme_names_every_skill_in_both_lists():
    skills = _skills()
    text = (ROOT / "plugin/README.md").read_text()
    bullets = text.split("## What it gives you")[1].split("## Install")[0]
    tree = text.split("## Files")[1]
    assert [s for s in skills if f"`{s}`" not in bullets] == []
    assert [s for s in skills if s not in tree] == []
