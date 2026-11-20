export const prerender = false;

const backend = () =>
  (process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "item";
}

function flattenCapabilities(nodes, depth = 0, parentId = null, out = []) {
  for (const node of nodes || []) {
    out.push({ ...node, depth, parent_id: node.parent_id ?? parentId });
    flattenCapabilities(node.children || [], depth + 1, node.id, out);
  }
  return out;
}

function collectGoalChain(goalById, startId) {
  const ids = new Set();
  let cursor = goalById.get(startId);
  while (cursor && !ids.has(cursor.id)) {
    ids.add(cursor.id);
    cursor = cursor.parent_goal_id ? goalById.get(cursor.parent_goal_id) : null;
  }
  return ids;
}

// The product's own features, every capability they realize, and each of
// those capabilities' PART_OF ancestors (so parent_ref resolves in the file).
function withAncestors(capabilities, startIds) {
  const byId = new Map(capabilities.map((cap) => [cap.id, cap]));
  const included = new Set();
  for (const id of startIds) {
    let cursor = byId.get(id);
    while (cursor && !included.has(cursor.id)) {
      included.add(cursor.id);
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : null;
    }
  }
  return included;
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function GET({ request, locals }) {
  if (!locals.accessToken) {
    return new Response(JSON.stringify({ detail: "Not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId");
  if (!productId) {
    return new Response(JSON.stringify({ detail: "productId is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  async function api(route) {
    const res = await fetch(`${backend()}${route}`, {
      headers: { authorization: `Bearer ${locals.accessToken}` },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${route} returned ${res.status}: ${JSON.stringify(body)}`);
    return body;
  }

  // Guesses are editor/admin only and the technology plane may be empty or
  // absent on an older instance: a refusal there means "none", not a failure.
  async function optional(route) {
    try {
      return await api(route);
    } catch {
      return null;
    }
  }

  async function allTechnologies() {
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const page = await optional(`/api/tech?limit=200&offset=${offset}`);
      if (!page) return rows;
      rows.push(...page.rows);
      if (offset + 200 >= page.total || page.rows.length === 0) return rows;
    }
  }

  try {
    const [product, productsGoals, capabilityTree, features, edges, decompositions, bundles] = await Promise.all([
      api(`/api/products/${productId}`),
      api("/api/goals"),
      api("/api/capabilities/map"),
      api("/api/features"),
      api("/api/features/edges"),
      api(`/api/products/${productId}/decompositions`),
      api(`/api/products/${productId}/bundles`),
    ]);
    const [guessRows, usage, satisfactions, technologies] = await Promise.all([
      optional("/api/guesses"),
      optional(`/api/stacks/usage?product_id=${productId}`),
      optional("/api/tech/satisfactions"),
      allTechnologies(),
    ]);
    const guesses = guessRows || [];

    const goals = productsGoals;
    const goalById = new Map(goals.map((goal) => [goal.id, goal]));
    const capabilityList = flattenCapabilities(capabilityTree);

    const productGoalIds = product.goal_id ? collectGoalChain(goalById, product.goal_id) : new Set();
    const motivationLists = await Promise.all(
      capabilityList.map(async (capability) => ({
        capability_id: capability.id,
        goals: await api(`/api/capabilities/${capability.id}/motivations`),
      })),
    );

    const allMotivations = motivationLists.flatMap(({ capability_id, goals: linkedGoals }) =>
      linkedGoals.map((goal) => ({ capability_id, goal_id: goal.id })),
    );
    const includedFeatures = features.filter((feature) => feature.product_id === productId);
    const includedFeatureIds = new Set(includedFeatures.map((feature) => feature.id));
    // A feature's guesses, minus any its confirmed links already cover.
    const guessesOf = new Map();
    for (const guess of guesses) {
      const feature = includedFeatures.find((f) => f.id === guess.feature_id);
      if (!feature || (feature.capability_ids || []).includes(guess.capability_id)) continue;
      guessesOf.set(feature.id, [...(guessesOf.get(feature.id) || []), guess]);
    }
    const includedCapabilityIds = withAncestors(capabilityList, [
      ...includedFeatures.flatMap((feature) => feature.capability_ids || []),
      ...[...guessesOf.values()].flat().map((guess) => guess.capability_id),
      ...bundles.map((capability) => capability.id),
    ]);
    const includedCapabilities = capabilityList.filter((capability) => includedCapabilityIds.has(capability.id));
    const includedEdges = edges.filter(
      (edge) => includedFeatureIds.has(edge.src_id) && includedFeatureIds.has(edge.dst_id),
    );

    const includedGoalIds = new Set(productGoalIds);
    const includedMotivations = allMotivations.filter((motivation) => {
      if (!includedCapabilityIds.has(motivation.capability_id)) return false;
      if (!productGoalIds.has(motivation.goal_id)) return false;
      includedGoalIds.add(motivation.goal_id);
      return true;
    });
    const includedGoals = goals.filter((goal) => includedGoalIds.has(goal.id));

    const goalRef = new Map(includedGoals.map((goal, i) => [goal.id, `goal-${slug(goal.display_id || goal.title)}-${i + 1}`]));
    const capRef = new Map(includedCapabilities.map((capability, i) => [capability.id, `cap-${slug(capability.name)}-${i + 1}`]));
    const featureRef = new Map(includedFeatures.map((feature, i) => [feature.id, `feat-${slug(feature.name)}-${i + 1}`]));

    const latestDecomposition = decompositions[0]?.document;
    const productRef = `prod-${slug(product.display_id || product.name)}`;

    // The technologies this product uses, each with its links to capabilities
    // already in the file: confirmed satisfactions, then guesses.
    const usedTechIds = new Set((usage || []).map((row) => row.tech_id));
    const includedTechs = technologies.filter((tech) => usedTechIds.has(tech.id));
    const techEntries = includedTechs.map((tech, i) => {
      const confirmed = (satisfactions || []).filter(
        (s) => s.tech_id === tech.id && includedCapabilityIds.has(s.capability_id),
      );
      const confirmedIds = new Set(confirmed.map((s) => s.capability_id));
      const guessed = guesses.filter(
        (g) => g.tech_id === tech.id && includedCapabilityIds.has(g.capability_id) && !confirmedIds.has(g.capability_id),
      );
      const satisfies = [
        ...confirmed.map((s) => ({ capability_ref: capRef.get(s.capability_id), fit: s.fit })),
        ...guessed.map((g) => ({
          capability_ref: capRef.get(g.capability_id),
          ...(g.fit ? { fit: g.fit } : {}),
          confidence: g.confidence,
          ...(g.basis ? { basis: g.basis } : {}),
        })),
      ];
      return {
        ref: `tech-${slug(tech.slug)}-${i + 1}`,
        name: tech.name,
        slug: tech.slug,
        kind: tech.kind,
        ...(tech.layer ? { layer: tech.layer } : {}),
        products: [productRef],
        ...(satisfies.length > 0 ? { satisfies } : {}),
      };
    });

    const doc = {
      format: "metis-seed/v1",
      source: {
        name: product.name,
        generated_by: "metis-export-ui",
      },
      goals: includedGoals.map((goal) => ({
        ref: goalRef.get(goal.id),
        goal_type: goal.goal_type,
        parent_ref: goal.parent_goal_id ? goalRef.get(goal.parent_goal_id) : null,
        title: goal.title,
        description: goal.description,
        success_criteria: goal.success_criteria,
        priority: goal.priority,
        status: goal.status,
      })),
      capabilities: includedCapabilities.map((capability) => ({
        ref: capRef.get(capability.id),
        parent_ref: includedCapabilityIds.has(capability.parent_id) ? capRef.get(capability.parent_id) : null,
        name: capability.name,
        slug: capability.slug,
        description: capability.description,
        maturity: capability.maturity,
        facets: capability.facets,
        evidence_anchors: capability.evidence_anchors,
      })),
      motivations: includedMotivations.map((motivation) => ({
        goal_ref: goalRef.get(motivation.goal_id),
        capability_ref: capRef.get(motivation.capability_id),
      })),
      features: includedFeatures.map((feature) => ({
        ref: featureRef.get(feature.id),
        capability_refs: (feature.capability_ids || []).map((id) => capRef.get(id)),
        ...(feature.unknown_capabilities ? { unknown_capabilities: true } : {}),
        ...(guessesOf.has(feature.id)
          ? {
              capability_guesses: guessesOf.get(feature.id).map((guess) => ({
                capability_ref: capRef.get(guess.capability_id),
                confidence: guess.confidence,
                ...(guess.basis ? { basis: guess.basis } : {}),
              })),
            }
          : {}),
        product_ref: productRef,
        name: feature.name,
        description: feature.description,
        facets: feature.facets,
        status: feature.status,
        priority: feature.priority,
        priority_rationale: feature.priority_rationale,
      })),
      edges: includedEdges.map((edge) => ({
        src_ref: featureRef.get(edge.src_id),
        dst_ref: featureRef.get(edge.dst_id),
        kind: edge.kind,
      })),
      products: [
        {
          ref: productRef,
          goal_ref: product.goal_id ? goalRef.get(product.goal_id) : null,
          name: product.name,
          summary: product.summary,
          body: product.body,
          ...(product.external ? { external: true } : {}),
          bundle_refs: bundles.map((capability) => capRef.get(capability.id)).filter(Boolean),
          decomposition: latestDecomposition
            ? {
                summary: latestDecomposition.summary,
                epics: (latestDecomposition.epics || []).map((epic) => ({
                  title: epic.title,
                  acceptance_criteria: epic.acceptance_criteria,
                  capability_ref: epic.capability_id ? capRef.get(epic.capability_id) : null,
                  stories: (epic.stories || []).map((story) => ({
                    title: story.title,
                    description: story.description,
                    feature_ref: story.feature_id ? featureRef.get(story.feature_id) : null,
                    tickets: (story.tickets || []).map((ticket) => ({
                      title: ticket.title,
                      description: ticket.description,
                      technical_approach: ticket.technical_approach,
                      acceptance_criteria: ticket.acceptance_criteria,
                      affected_files: ticket.affected_files,
                      context_budget: ticket.context_budget,
                    })),
                  })),
                })),
              }
            : null,
        },
      ],
      ...(techEntries.length > 0 ? { technologies: techEntries } : {}),
    };

    const filename = `${slug(product.name)}.metis-seed.json`;
    return jsonResponse({ filename, document: doc });
  } catch (error) {
    return new Response(JSON.stringify({ detail: String(error.message || error) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
