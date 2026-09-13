import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, useUpdateNodeInternals, type Connection, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, Braces, CheckCheck, FileText, GitBranch, Layers, LayoutGrid, Repeat2, Sparkles } from 'lucide-react';
import type { HarnessBlock } from './harness';
import { children } from './harness';
import { harnessGraph, INPUT_NODE, OUTPUT_NODE, nodeBlockId, type GraphNode, type GraphPoint } from './harness-graph';
import '@xyflow/react/dist/style.css';

type CanvasData = GraphNode & { open: (id: string) => void; select: (id: string) => void; connectable: boolean; hasAcceptanceExit: boolean };
type CanvasNode = Node<CanvasData, 'harness'>;
const icons = { extract: Sparkles, parse: FileText, sequence: Layers, cascade: Layers, consensus: CheckCheck, parallel: GitBranch, gate: GitBranch, repair: Repeat2, pages: FileText, validate: Braces, return: CheckCheck };
function HarnessNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.hasAcceptanceExit, updateNodeInternals]);
  const Icon = data.block ? icons[data.block.kind] : data.boundary === 'input' ? FileText : CheckCheck;
  return <div className={`harness-canvas-node ${data.boundary ? 'boundary' : ''} ${selected ? 'selected' : ''}`}>
    {data.boundary !== 'input' && <Handle type="target" position={Position.Top} id="in" isConnectable={data.connectable} />}
    <div className="harness-node-content">
      <span className={`harness-node-icon ${data.block?.kind || ''}`}><Icon size={18} /></span>
      {data.block ? <button type="button" className="nodrag harness-node-label" aria-label={`Edit ${data.label}`} onClick={() => data.select(data.block!.id)}><strong>{data.label}</strong><small>{data.detail}</small></button> : <div className="harness-node-label"><strong>{data.label}</strong><small>{data.detail}</small></div>}
    </div>
    {data.block && children(data.block).length > 0 && <button type="button" className="nodrag harness-open-flow" onClick={() => data.open(data.block!.id)} aria-label={`Open ${data.label} flow`}>Open flow <ArrowUpRight size={13} /></button>}
    {data.boundary !== 'output' && <Handle type="source" position={Position.Bottom} id="out" title="Always" isConnectable={data.connectable} />}
    {data.boundary !== 'output' && <><Handle type="source" position={Position.Right} id="accepted" title="When accepted" isConnectable className="harness-conditional-handle" /><Handle type="source" position={Position.Left} id="unresolved" title="When unresolved" isConnectable className="harness-conditional-handle unresolved" /></>}
  </div>;
}
const nodeTypes = { harness: HarnessNode };
function readPositions(key: string): Record<string, GraphPoint> {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, GraphPoint] => {
      const point = entry[1] as GraphPoint;
      return point && Number.isFinite(point.x) && Number.isFinite(point.y);
    }));
  } catch { return {}; }
}
function FlowCanvas({ scope, rootId, defaultModel, selected, onSelect, onOpen, onConnect, selectedEdge, onSelectEdge, onDeleteEdges }: {
  scope: HarnessBlock; rootId: string; defaultModel: string; selected: string;
  onSelect: (id: string) => void; onOpen: (id: string) => void; onConnect: (connection: Connection, replaceId?: string) => void; selectedEdge?: string; onSelectEdge: (id: string) => void; onDeleteEdges: (ids: string[]) => void;
}) {
  const graph = useMemo(() => harnessGraph(scope, defaultModel), [scope, defaultModel]);
  const storageKey = `ezpz-harness-layout:${rootId}:${scope.id}`;
  const [positions, setPositions] = useState(() => readPositions(storageKey));
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const { fitView, getNodes } = useReactFlow();
  const initialized = useNodesInitialized();
  const fitted = useRef('');
  const signature = graph.nodes.map(node => node.id).join('|');
  useEffect(() => {
    if (!initialized || fitted.current === signature) return;
    const current = getNodes();
    if (current.length !== graph.nodes.length || !graph.nodes.every(node => current.some(item => item.id === node.id && item.measured?.width && item.measured?.height))) return;
    fitted.current = signature;
    void fitView({ padding: .2, maxZoom: 1 });
  }, [initialized, signature, graph.nodes, getNodes, fitView, nodes.length]);
  const canConnect = true;
  useEffect(() => {
    setNodes(previous => graph.nodes.map(node => ({
      id: node.id, type: 'harness', position: previous.find(p => p.id === node.id)?.position || positions[node.id] || node.position,
      selected: node.block?.id === selected, draggable: true, deletable: false,
      ariaLabel: node.label, data: { ...node, open: onOpen, select: onSelect, connectable: canConnect, hasAcceptanceExit: !node.boundary && graph.edges.some(edge => edge.source === node.id && edge.label === 'Accepted') },
    })));
  }, [graph, selected, onOpen, onSelect, canConnect, positions, setNodes]);
  const edges = useMemo(() => graph.edges.map(edge => ({ ...edge, type: 'smoothstep', className: `harness-edge-${edge.condition}`, sourceHandle: edge.condition === 'always' ? 'out' : edge.condition, targetHandle: 'in', selected: edge.id === selectedEdge, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }, style: { strokeWidth: edge.id === selectedEdge ? 2.5 : 1.5, ...(edge.conditional ? { strokeDasharray: '5 4' } : {}) }, labelStyle: { fontSize: 11 }, labelBgPadding: [7, 4] as [number, number], deletable: true, reconnectable: true, interactionWidth: 24 })), [graph, selectedEdge]);

  function storePositions(next: Record<string, GraphPoint>) {
    setPositions(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Layout is optional; execution remains saved in the processor. */ }
  }
  function arrange() {
    setNodes(current => current.map(node => ({ ...node, position: graph.nodes.find(n => n.id === node.id)!.position })));
    storePositions({});
    requestAnimationFrame(() => { void fitView({ padding: .2, duration: 250, maxZoom: 1 }); });
  }
  return <div className="harness-canvas" aria-label="Extraction workflow canvas">
    <ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
      onNodeClick={(_, node) => { if (node.data.block) onSelect(node.data.block.id); }}
      onNodeDoubleClick={(_, node) => { if (node.data.block && children(node.data.block).length) onOpen(node.data.block.id); }}
      onNodeDragStop={(_, node) => storePositions({ ...positions, [node.id]: node.position })}
      onConnect={connection => onConnect(connection)} onReconnect={(edge, connection) => onConnect(connection, edge.id)}
      elevateEdgesOnSelect onEdgeClick={(_, edge) => onSelectEdge(edge.id)} onEdgesDelete={edges => onDeleteEdges(edges.map(edge => edge.id))} reconnectRadius={18}
      isValidConnection={connection => canConnect && connection.source !== connection.target && ['out', 'accepted', 'unresolved'].includes(connection.sourceHandle || '') && connection.targetHandle === 'in' && (connection.source === INPUT_NODE || !!nodeBlockId(connection.source)) && (connection.target === OUTPUT_NODE || !!nodeBlockId(connection.target))}
      nodesConnectable={canConnect} edgesReconnectable={canConnect} deleteKeyCode={["Backspace", "Delete"]} minZoom={.2} maxZoom={1.75}
      fitView fitViewOptions={{ padding: .2, maxZoom: 1 }} panOnScroll zoomOnScroll={false} selectionOnDrag={false} preventScrolling={false}>
      <Background color="#ced8cb" gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap style={{ width: 115, height: 80 }} pannable zoomable nodeColor={node => node.selected ? '#6e8c68' : '#dce5d8'} maskColor="rgba(247,249,245,.65)" />
      <Panel position="top-right"><button type="button" className="harness-arrange" onClick={arrange}><LayoutGrid size={14} /> Auto layout</button></Panel>
    </ReactFlow>
  </div>;
}
export function HarnessCanvas(props: React.ComponentProps<typeof FlowCanvas>) {
  return <ReactFlowProvider key={`${props.rootId}:${props.scope.id}`}><FlowCanvas {...props} /></ReactFlowProvider>;
}
