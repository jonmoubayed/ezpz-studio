import assert from "node:assert/strict";
import { recipes, harnessRecipe, harnessError, findBlock, newBlock, transformBlock } from "../src/harness";
import { configPayload, versionConfig, mergeEditableConfig } from "../src/api";
import { defaultConfig } from "../src/domain";
import { generateProcessorCode } from "../src/processor-code";

for (const recipe of recipes) {
  const harness = harnessRecipe(recipe.id);
  assert.equal(harnessError(harness), "");
  const config = { ...defaultConfig, harness };
  assert.deepEqual(versionConfig(configPayload(config)).harness, harness);
  assert.deepEqual(mergeEditableConfig({ harness: { name: "custom", plugin: "keep:me" } }, config).harness, harness);
  const code = generateProcessorCode(config);
  assert.match(code.code, /execute_harness/);
  assert.match(code.code, /execution_id/);
}
const harness = harnessRecipe("cascade");
const root = harness.flow!;
const cascade = root.steps![0];
const consensus = newBlock("consensus");
const hybrid = transformBlock(root, cascade.id, block => ({ ...block, tiers: [block.tiers![0], consensus] }));
assert.equal(findBlock(hybrid, consensus.id)?.branches?.length, 3);
assert.equal(cascade.tiers?.[1].kind, "extract", "Editing must not mutate a saved configuration");
assert.equal(harnessError({ ...harness, flow: hybrid }), "");
const legacy = { name: "custom", plugin: "production:extract" };
assert.deepEqual(mergeEditableConfig({ harness: legacy }, defaultConfig).harness, legacy);
assert.notEqual(harnessError({ ...harness, flow: { ...cascade, threshold: -1 } }), "");
console.log("Harness recipes, composition, saved versions, and export tests passed");

// Canvas edges must change the executable program, while layout never enters it.
const { harnessGraph, savedConnections, updateConnection, removeBlock, blockTrail, blockNodeId, INPUT_NODE, OUTPUT_NODE } = await import('../src/harness-graph');
const flow = { id: 'root', kind: 'sequence' as const, steps: ['a', 'b', 'c'].map(id => ({ id, kind: 'extract' as const })) };
const initial = savedConnections(flow);
const first = initial.find(edge => edge.source === INPUT_NODE)!;
const reconnected = updateConnection(flow, { source: INPUT_NODE, target: blockNodeId('c'), condition: 'accepted' }, first.id);
assert.equal(reconnected.find(edge => edge.id === first.id)?.target, blockNodeId('c'));
assert.equal(reconnected.find(edge => edge.id === first.id)?.condition, 'accepted');
assert.deepEqual(savedConnections(flow), initial, 'Editing an arrow does not mutate a saved version');
assert.deepEqual(flow.steps.map(b => b.id), ['a', 'b', 'c'], 'Edges are saved independently of array order');
for (const recipe of recipes) {
  const spec = harnessRecipe(recipe.id);
  const graph = harnessGraph(spec.flow!, 'local');
  const ids = new Set(graph.nodes.map(n => n.id));
  assert.ok(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)));
  assert.equal(JSON.stringify(spec).includes('position'), false);
}
const vote = { ...newBlock('consensus'), quorum: 3 };
const withVote = { ...flow, steps: [vote] };
assert.equal(blockTrail(withVote, vote.branches![0].id).length, 3);
const removed = removeBlock(withVote, vote.branches![0].id);
assert.equal(removed.steps?.[0].branches?.length, 2);
assert.equal(removed.steps?.[0].quorum, 2);
assert.equal(removeBlock(withVote, vote.id), withVote, 'Do not remove the only step');
const branches = harnessGraph(vote, 'local');
assert.equal(branches.edges.filter(e => e.source === INPUT_NODE).length, 3);
assert.equal(branches.edges.filter(e => e.target === OUTPUT_NODE).length, 3);
console.log('Canvas topology, connections, nested scopes, and deletion policies passed');

for (const kind of ['sequence', 'cascade', 'consensus', 'parallel', 'gate', 'repair', 'pages'] as const) {
  const block = newBlock(kind);
  const before = savedConnections(block);
  const changed = updateConnection(block, { source: INPUT_NODE, target: OUTPUT_NODE, condition: 'always' }, before[0].id);
  const saved = { ...block, routing: { edges: changed } };
  assert.equal(harnessGraph(saved, 'local').edges[0].target, OUTPUT_NODE, `${kind} must render saved destinations`);
  assert.deepEqual(versionConfig(configPayload({ ...defaultConfig, harness: { name: 'workflow', version: 1, flow: saved } })).harness?.flow?.routing, saved.routing);
}
