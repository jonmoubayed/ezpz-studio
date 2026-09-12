import { blockNames, children, transformBlock, type HarnessBlock, type HarnessConnection } from './harness';

export const INPUT_NODE = 'boundary:input';
export const OUTPUT_NODE = 'boundary:output';
export const blockNodeId = (id: string) => `block:${id}`;
export const nodeBlockId = (id: string) => id.startsWith('block:') ? id.slice(6) : undefined;
export type GraphPoint = { x: number; y: number };
export type GraphNode = { id: string; position: GraphPoint; block?: HarnessBlock; label: string; detail: string; boundary?: 'input' | 'output' };
export type GraphEdge = { id: string; source: string; target: string; label?: string; conditional?: boolean; condition: HarnessConnection["condition"] };

export function blockTrail(root: HarnessBlock, id: string): HarnessBlock[] {
  if (root.id === id) return [root];
  for (const [, list] of children(root)) for (const child of list) {
    const trail = blockTrail(child, id);
    if (trail.length) return [root, ...trail];
  }
  return [];
}
export function blockSummary(block: HarnessBlock, defaultModel: string): string {
  if (block.kind === 'extract') return block.model?.name || `Default · ${defaultModel}`;
  if (block.kind === 'cascade') return `${block.tiers?.length || 0} tiers · threshold ${block.threshold ?? 'none'}`;
  if (block.kind === 'consensus') return `${block.branches?.length || 0} voters · quorum ${block.quorum ?? Math.floor((block.branches?.length || 0) / 2) + 1}`;
  if (block.kind === 'gate') return `Pass / fail · threshold ${block.threshold ?? 'none'}`;
  if (block.kind === 'parallel') return `${block.branches?.length || 0} branches · merge fields`;
  if (block.kind === 'sequence') return `${block.steps?.length || 0} steps in order`;
  if (block.kind === 'repair') return `Up to ${block.attempts ?? 1} repair attempts`;
  if (block.kind === 'pages') return 'Repeat for each parsed page';
  if (block.kind === 'parse') return block.parser?.name || 'Processor parser';
  return block.threshold === undefined ? 'Schema and field checks' : `Confidence ≥ ${block.threshold}`;
}

/** Project one scope into an executable flow, keeping nested programs as editable nodes. */
export function harnessGraph(scope: HarnessBlock, defaultModel: string) {
  const nested = children(scope);
  const blocks = nested.length ? nested.flatMap(([, list]) => list) : [scope];
  const fork = nested.length > 0 && ['consensus', 'parallel', 'gate'].includes(scope.kind);
  const nodes: GraphNode[] = [{ id: INPUT_NODE, label: fork ? 'Branch input' : 'Input', detail: 'Current document + fields', boundary: 'input', position: { x: fork ? (blocks.length - 1) * 160 : 0, y: 0 } }];
  blocks.forEach((block, index) => nodes.push({ id: blockNodeId(block.id), block, label: block.label || blockNames[block.kind], detail: blockSummary(block, defaultModel), position: { x: fork ? index * 320 : 0, y: fork ? 180 : 180 + index * 180 } }));
  nodes.push({ id: OUTPUT_NODE, label: scope.kind === 'consensus' ? 'Resolve majority' : scope.kind === 'parallel' ? 'Merge fields' : 'Output', detail: scope.kind === 'cascade' ? 'Accepted or tiers exhausted' : scope.kind === 'repair' ? `After up to ${scope.attempts ?? 1} attempts` : scope.kind === 'pages' ? 'Merge page results' : 'Continue with selected fields', boundary: 'output', position: { x: fork ? (blocks.length - 1) * 160 : 0, y: fork ? 400 : 180 + blocks.length * 180 } });
  const edges: GraphEdge[] = [];
  const connect = (source: string, target: string, label?: string, conditional = false) => edges.push({ id: `${source}->${target}:${label || ''}`, source, target, label, conditional, condition: label === "Accepted" ? "accepted" : ["Unresolved", "Needs another attempt"].includes(label || "") ? "unresolved" : "always" });
  if (fork) {
    blocks.forEach((block, index) => {
      const role = scope.kind === 'gate' ? (block.id === scope.pass?.id ? 'Accepted' : 'Needs another attempt') : `Branch ${index + 1}`;
      connect(INPUT_NODE, blockNodeId(block.id), role, scope.kind === 'gate');
      connect(blockNodeId(block.id), OUTPUT_NODE);
    });
  } else {
    let previous = INPUT_NODE;
    blocks.forEach((block, index) => {
      connect(previous, blockNodeId(block.id), scope.kind === 'cascade' && index > 0 ? 'Unresolved' : undefined, scope.kind === 'cascade' && index > 0);
      if (scope.kind === 'cascade' && index < blocks.length - 1) connect(blockNodeId(block.id), OUTPUT_NODE, 'Accepted', true);
      previous = blockNodeId(block.id);
    });
    connect(previous, OUTPUT_NODE);
  }
  if (scope.kind === 'gate' && nested.length) {
    if (!scope.pass) connect(INPUT_NODE, OUTPUT_NODE, 'Accepted', true);
    if (!scope.fail) connect(INPUT_NODE, OUTPUT_NODE, 'Needs another attempt', true);
  }
  return { nodes, edges: scope.routing ? scope.routing.edges.map(edge => ({ ...edge, label: edge.condition === 'accepted' ? 'Accepted' : edge.condition === 'unresolved' ? 'Unresolved' : undefined, conditional: edge.condition !== 'always' })) : edges };
}

export function removeBlock(root: HarnessBlock, id: string): HarnessBlock {
  const trail = blockTrail(root, id);
  const parent = trail.at(-2);
  if (!parent) return root;
  const group = children(parent).find(([, list]) => list.some(b => b.id === id));
  if (!group || !['steps', 'tiers', 'branches'].includes(group[0]) || group[1].length <= 1) return root;
  const list = group[1].filter(b => b.id !== id);
  return transformBlock(root, parent.id, b => {
    const result = { ...b, [group[0]]: list };
    if (b.routing) result.routing = { edges: b.routing.edges.filter(edge => edge.source !== blockNodeId(id) && edge.target !== blockNodeId(id)) };
    if (b.kind === 'consensus' && b.quorum !== undefined) result.quorum = Math.min(list.length, Math.max(Math.floor(list.length / 2) + 1, b.quorum));
    return result;
  });
}

export function savedConnections(scope: HarnessBlock): HarnessConnection[] {
  return harnessGraph(scope, '').edges.map(({ id, source, target, condition }) => ({ id, source, target, condition }));
}
export function updateConnection(scope: HarnessBlock, connection: Omit<HarnessConnection, 'id'>, replaceId?: string): HarnessConnection[] {
  const edges = savedConnections(scope);
  const duplicate = edges.find(edge => edge.id !== replaceId && edge.source === connection.source && edge.target === connection.target && edge.condition === connection.condition);
  if (duplicate) return replaceId ? edges.filter(edge => edge.id !== replaceId) : edges;
  const next = { ...connection, id: replaceId || crypto.randomUUID() };
  return replaceId ? edges.map(edge => edge.id === replaceId ? next : edge) : [...edges, next];
}
