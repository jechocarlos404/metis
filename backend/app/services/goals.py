"""Which product each goal belongs to. Computed here once; the goals API
carries it as `product_id` and every screen, MCP and Chat read that field.

A goal belongs to product P when it sits in P's goal tree: start at
P.goal_id and climb to the highest ancestor whose subtree no other product
points into, then take that whole subtree, except any subtree rooted at
another product's goal (that one is the other product's). A goal can belong
to no product: an org goal two products point into, or a goal two products
both point at. A product with no goal owns nothing. Someone else's product
(external) owns no goal even when it points at one: goals say why *our*
products exist, so pointing Strava at a goal never takes it from ours.

Per goal that comes to: the nearest goal at or above it that a product
points at decides; with none above it, the lowest ancestor whose subtree a
product points into does, when exactly one product does. The first case also
settles the one double claim the climb allows, in trees three levels deep
(Q on the top goal, P two levels down, P's climb reaching the middle goal):
a goal under Q's goal stays Q's unless it is under P's goal.
"""

import uuid
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Goal, Product


def goal_owners(
    parents: dict[uuid.UUID, uuid.UUID | None],
    product_goals: list[tuple[uuid.UUID, uuid.UUID | None]],
) -> dict[uuid.UUID, uuid.UUID]:
    """goal id -> owning product id, for the goals that have one.

    `parents` maps every goal to its parent; `product_goals` pairs each
    product with its goal_id (None when it has none)."""
    pointers: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    for product_id, goal_id in product_goals:
        if goal_id in parents:
            pointers[goal_id].add(product_id)
    children: dict[uuid.UUID | None, list[uuid.UUID]] = defaultdict(list)
    for goal_id, parent_id in parents.items():
        children[parent_id].append(goal_id)

    def upward(goal_id: uuid.UUID) -> list[uuid.UUID]:
        """The goal and its ancestors, nearest first; a parent cycle ends it."""
        out: list[uuid.UUID] = []
        cursor: uuid.UUID | None = goal_id
        while cursor in parents and cursor not in out:
            out.append(cursor)
            cursor = parents[cursor]
        return out

    def pointed_into(root: uuid.UUID) -> set[uuid.UUID]:
        """Products pointing at a goal in this subtree."""
        seen: set[uuid.UUID] = set()
        found: set[uuid.UUID] = set()
        stack = [root]
        while stack:
            goal_id = stack.pop()
            if goal_id in seen:
                continue
            seen.add(goal_id)
            found |= pointers.get(goal_id, set())
            stack.extend(children[goal_id])
        return found

    owners: dict[uuid.UUID, uuid.UUID] = {}
    for goal_id in parents:
        up = upward(goal_id)
        marked = next((g for g in up if g in pointers), None)
        if marked is not None:
            claim = pointers[marked]
        else:
            claim = next((found for g in up if (found := pointed_into(g))), set())
        if len(claim) == 1:
            owners[goal_id] = next(iter(claim))
    return owners


async def owners(session: AsyncSession) -> dict[uuid.UUID, uuid.UUID]:
    """goal_owners over every goal and product in the database."""
    parents = dict((await session.execute(select(Goal.id, Goal.parent_goal_id))).all())
    product_goals = list((await session.execute(
        select(Product.id, Product.goal_id).where(Product.external.is_(False))
    )).all())
    return goal_owners(parents, [tuple(row) for row in product_goals])
