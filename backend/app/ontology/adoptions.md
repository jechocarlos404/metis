# Adoption policy — what each stance means, and which ones stop you

Served as the `metis://policy/adoptions` MCP resource. An agent that has read this
stops at `banned` without being told, and argues rather than obeys everywhere else.

A stance is the group's position on a technology. It lives in `adoptions`, one row per
technology, and it is **not** a property of the technology itself — the catalog is
world-scope and shareable precisely because it carries no opinion.

## The absence of a row is meaningful

No row means **no stance taken**. It does not mean `candidate`, and nothing may backfill
a default to make a join convenient. A technology nobody has an opinion about is still a
valid answer to "what could satisfy this capability" — that is what makes the catalog
worth having rather than a list of things we already use.

## The ramp is ordered, not categorical

```
promotion:  candidate → trial → adopted → standard
demotion:   contained → deprecated → banned
```

| Stance | Means | In practice |
|---|---|---|
| `candidate` | someone proposed it | no commitment; it is on the table |
| `trial` | in use in exactly one place, on purpose, being evaluated | a second use needs a conversation, not a shrug |
| `adopted` | proven; use it if it fits | no justification needed |
| `standard` | the default | *deviating* needs a reason, not choosing it |
| `contained` | in the estate, no new use | existing uses stay; do not add one |
| `deprecated` | actively being removed, and there is a target | new use is a decision someone will have to undo |
| `banned` | a constraint forbids it | not an argument you can win here |

Because it is ordered, "how much of the estate sits below `adopted`" is a comparison
rather than a special case.

## Who owns a promotion

Every `adoptions` row carries an `owner` and a `rationale`. Promotion and demotion are
that person's call, recorded with a reason and a date — those two columns are why the
estate is still explainable a year later.

**No agent writes a stance.** An agent reads it. A recommendation that a technology
should move up the ramp is a sentence in a proposal, not a row in a table.

## Two hard stops, everything else an argument

| Condition | Behaviour |
|---|---|
| stance `banned` | **Stop.** Cite the rule id. Do not proceed, do not propose it. |
| a blocking Constraint (`severity: block`) applies | **Stop.** Cite the constraint id and its reason. |
| stance `deprecated` or `contained` | Argument. Return it with its rationale; proceeding is allowed, and you should say why. |
| `fit: workaround` | Argument. Return it graded, not hidden. |
| no offer at all | Argument, and an answer. Return the gap. |

Both stop conditions trace to an id someone wrote down. Everything else is returned with
its rationale so the argument happens out loud, rather than an agent quietly declining
and leaving nobody to disagree with.

## What a stance is not

- **Not a quality score.** `standard` says the group has converged, not that it is the
  best tool. A `candidate` may be better and unadopted simply because nobody has argued
  for it yet.
- **Not a fit.** `fit` (`native` / `partial` / `workaround`) says how well a technology
  answers a *capability*; stance says where the group stands on the technology at all. A
  `standard` technology can be a `workaround` for the capability in front of you, and
  that combination is exactly what the ranking is designed to surface.
- **Not exposure.** A technology can be `standard` and still dying — an EOL date and a
  bus factor of one are facts about the world, and they surface in `tech_exposure`
  regardless of what the group has decided.
