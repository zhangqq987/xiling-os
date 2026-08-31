import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import type { ResearchGraphEntity, ResearchGraphProjection, ResearchGraphProposal, ResearchGraphView, ResearchRelationKind, ScientificCanvasLayout } from "@xiling/contracts";
import { apiJson, jsonInit } from "../lib/api-client.js";
import { useConversations } from "../workspace/ConversationContext.js";

type ScientificNodeData = ResearchGraphEntity & Record<string, unknown>;
type ScientificNode = Node<ScientificNodeData, "scientific">;
type ScientificEdge = Edge<{ kind: ResearchRelationKind }>;

const views: Array<{ id: ResearchGraphView; label: string; hint: string }> = [
  { id: "all", label: "全景", hint: "项目全部科研对象" },
  { id: "literature", label: "文献", hint: "论文、片段与引用" },
  { id: "evidence", label: "证据", hint: "主张与支持/反驳链" },
  { id: "provenance", label: "溯源", hint: "数据、计算与审查" },
  { id: "artifacts", label: "产物", hint: "版本与生命周期" },
];

const kindLabel: Record<string, string> = {
  Project: "项目", ResearchQuestion: "研究问题", Hypothesis: "假设", Claim: "主张", ClaimRevision: "主张版本",
  EvidenceAssertion: "证据断言", Paper: "论文", SourceFragment: "来源片段", Dataset: "数据集", DatasetSnapshot: "数据快照",
  ResearchPlan: "研究计划", Approval: "审批", ResearchRun: "计算运行", Artifact: "产物", ArtifactVersion: "产物版本",
  LifecycleEvent: "生命周期", ReviewReport: "审查报告", WikiRevisionRef: "Wiki 版本", Actor: "责任主体",
};
const relationLabel: Record<ResearchRelationKind, string> = {
  CONTAINS: "包含", HAS_REVISION: "版本", HAS_FRAGMENT: "片段", CITES: "引用", ASSERTS: "断言", BASED_ON: "依据",
  USED: "使用", GENERATED: "生成", DERIVED_FROM: "派生", EVALUATES: "评估", DOCUMENTS: "记录", SUPERSEDES: "取代",
  HAS_VERSION: "拥有版本", TRANSITIONED_BY: "状态变化", ASSOCIATED_WITH: "关联", REFERENCES: "指向",
};
const relationColor: Record<ResearchRelationKind, string> = {
  CONTAINS: "#a9b4bf", HAS_REVISION: "#8d91c7", HAS_FRAGMENT: "#8293b8", CITES: "#799ca0", ASSERTS: "#5d8f84", BASED_ON: "#4c8a7f",
  USED: "#97855f", GENERATED: "#467c9d", DERIVED_FROM: "#6f7eaa", EVALUATES: "#9a6f78", DOCUMENTS: "#8b7b91", SUPERSEDES: "#b07869",
  HAS_VERSION: "#617e9a", TRANSITIONED_BY: "#89929a", ASSOCIATED_WITH: "#9b9a87", REFERENCES: "#7e8a91",
};

const formatNodeTime = (value?: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `更新于 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return `更新于 ${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`;
};

function ScientificNodeCard({ data, selected }: NodeProps<ScientificNode>) {
  const updatedLabel = formatNodeTime(data.updatedAt);
  return <article className={`scientific-node scientific-node-${data.kind.toLowerCase()} ${selected ? "selected" : ""}`}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <header><span>{kindLabel[data.kind] ?? data.kind}</span>{data.status ? <i>{data.status}</i> : null}</header>
    <h3>{data.title}</h3>
    <p>{data.summary || "暂无摘要"}</p>
    <footer><span>v{data.revision}</span>{data.confidence !== undefined ? <span>置信度 {Math.round(data.confidence * 100)}%</span> : null}{updatedLabel ? <span>{updatedLabel}</span> : null}</footer>
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </article>;
}

const nodeTypes: NodeTypes = { scientific: ScientificNodeCard };

const semanticRank: Record<string, number> = {
  Project: 0, ResearchQuestion: 1, Hypothesis: 2, ResearchPlan: 2, Claim: 3, Paper: 3, Dataset: 3, Approval: 3,
  ClaimRevision: 4, SourceFragment: 4, DatasetSnapshot: 4, EvidenceAssertion: 5, ResearchRun: 5, WikiRevisionRef: 5,
  Artifact: 6, ReviewReport: 6, ArtifactVersion: 7, LifecycleEvent: 8, Actor: 8,
};

export function arrangedPositions(entities: ResearchGraphEntity[], relations: ResearchGraphProjection["relations"] = []): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, string[]>();
  const forward = new Set<ResearchRelationKind>(["CONTAINS", "HAS_REVISION", "HAS_FRAGMENT", "GENERATED", "HAS_VERSION", "TRANSITIONED_BY"]);
  const reverse = new Set<ResearchRelationKind>(["ASSERTS", "BASED_ON", "USED", "DERIVED_FROM", "EVALUATES", "DOCUMENTS", "SUPERSEDES"]);
  for (const relation of relations) {
    const parentId = forward.has(relation.kind) ? relation.sourceId : reverse.has(relation.kind) ? relation.targetId : undefined;
    const childId = forward.has(relation.kind) ? relation.targetId : reverse.has(relation.kind) ? relation.sourceId : undefined;
    if (parentId && childId) incoming.set(childId, [...(incoming.get(childId) ?? []), parentId]);
  }
  const ranks = new Map<string, number>();
  const rankOf = (entity: ResearchGraphEntity, stack = new Set<string>()): number => {
    const cached = ranks.get(entity.id); if (cached !== undefined) return cached;
    if (stack.has(entity.id)) return semanticRank[entity.kind] ?? 4;
    const nextStack = new Set(stack).add(entity.id);
    const parents = (incoming.get(entity.id) ?? []).map((id) => entities.find((candidate) => candidate.id === id)).filter(Boolean) as ResearchGraphEntity[];
    const graphRank = parents.length ? Math.max(...parents.map((parent) => rankOf(parent, nextStack))) + 1 : 0;
    const value = Math.max(graphRank, semanticRank[entity.kind] ?? 0);
    ranks.set(entity.id, value); return value;
  };
  const grouped = new Map<number, ResearchGraphEntity[]>();
  for (const entity of entities) {
    const rank = rankOf(entity);
    grouped.set(rank, [...(grouped.get(rank) ?? []), entity]);
  }
  const result = new Map<string, { x: number; y: number }>();
  [...grouped.entries()].sort(([left], [right]) => left - right).forEach(([, siblings], row) => {
    const sorted = [...siblings].sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
    const width = (sorted.length - 1) * 310;
    sorted.forEach((entity, column) => result.set(entity.id, { x: column * 310 - width / 2, y: row * 210 }));
  });
  return result;
}

function toNodes(graph: ResearchGraphProjection, layout: ScientificCanvasLayout): ScientificNode[] {
  const automatic = arrangedPositions(graph.nodes, graph.relations);
  const persisted = new Map(layout.positions.map((position) => [position.entityId, { x: position.x, y: position.y }]));
  return graph.nodes.map((entity) => ({ id: entity.id, type: "scientific", data: entity as ScientificNodeData, position: persisted.get(entity.id) ?? automatic.get(entity.id) ?? { x: 0, y: 0 } }));
}

function toEdges(graph: ResearchGraphProjection): ScientificEdge[] {
  return graph.relations.map((relation) => ({
    id: relation.id,
    source: relation.sourceId,
    target: relation.targetId,
    // React Flow's built-in "default" edge is the cubic Bézier renderer.
    type: "default",
    selectable: false,
    focusable: false,
    label: relationLabel[relation.kind],
    labelStyle: { fill: "#68727c", fontSize: 9 },
    labelBgStyle: { fill: "rgba(255,255,255,.92)" },
    labelBgPadding: [5, 3],
    data: { kind: relation.kind },
    style: { stroke: relationColor[relation.kind], strokeWidth: 1.35, opacity: .66 },
    markerEnd: { type: MarkerType.ArrowClosed, color: relationColor[relation.kind], width: 13, height: 13 },
  }));
}

export function ScientificCanvasView({ projectId, onNavigate }: { projectId: string; onNavigate?: (view: "chat" | "wiki" | "papers") => void }) {
  const [view, setView] = useState<ResearchGraphView>("all");
  const [graph, setGraph] = useState<ResearchGraphProjection>();
  const [layout, setLayout] = useState<ScientificCanvasLayout>();
  const [nodes, setNodes, onNodesChange] = useNodesState<ScientificNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ScientificEdge>([]);
  const [selectedId, setSelectedId] = useState("");
  const [quotedIds, setQuotedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [focusOneHop, setFocusOneHop] = useState(false);
  const [relationFilter, setRelationFilter] = useState<ResearchRelationKind | "all">("all");
  const [status, setStatus] = useState("正在读取科研图…");
  const [proposals, setProposals] = useState<ResearchGraphProposal[]>([]);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalSummary, setProposalSummary] = useState("");
  const flow = useRef<ReactFlowInstance<ScientificNode, ScientificEdge> | null>(null);
  const revisionByView = useRef(new Map<ResearchGraphView, number>());
  const viewRef = useRef(view);
  const viewport = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const acceptViewportChanges = useRef(false);
  const nodesRef = useRef(nodes);
  const saveChain = useRef(Promise.resolve());
  const { activeSessionId, refreshSessions } = useConversations();

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { viewRef.current = view; }, [view]);

  const load = useCallback(async () => {
    acceptViewportChanges.current = false;
    setStatus("正在读取科研图…");
    try {
      const encodedProject = encodeURIComponent(projectId);
      const [nextGraph, nextLayout, nextProposals] = await Promise.all([
        apiJson<ResearchGraphProjection>(`/api/projects/${encodedProject}/research-graph?view=${view}`),
        apiJson<ScientificCanvasLayout>(`/api/projects/${encodedProject}/research-graph/layout?view=${view}`),
        apiJson<ResearchGraphProposal[]>(`/api/projects/${encodedProject}/research-graph/proposals`),
      ]);
      setGraph(nextGraph);
      setLayout(nextLayout);
      revisionByView.current.set(view, nextLayout.revision);
      setNodes(toNodes(nextGraph, nextLayout));
      setEdges(toEdges(nextGraph));
      setProposals(nextProposals);
      setSelectedId((current) => nextGraph.nodes.some((node) => node.id === current) ? current : nextGraph.nodes.find((node) => node.kind === "ResearchQuestion")?.id ?? nextGraph.nodes[0]?.id ?? "");
      setQuotedIds([]);
      setStatus(`${nextGraph.nodes.length} 个科研对象 · ${nextGraph.relations.length} 条关系`);
      window.setTimeout(async () => {
        if (nextLayout.viewport) await flow.current?.setViewport(nextLayout.viewport, { duration: 0 });
        else await flow.current?.fitView({ padding: .18, duration: 300 });
        acceptViewportChanges.current = true;
      }, 30);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, [projectId, setEdges, setNodes, view]);

  useEffect(() => { void load(); }, [load]);

  const persistLayout = useCallback((snapshot: ScientificNode[], nextViewport = viewport.current) => {
    const targetView = view;
    const positions = snapshot.map((node) => ({ entityId: node.id, x: node.position.x, y: node.position.y }));
    saveChain.current = saveChain.current.then(async () => {
      try {
        const saved = await apiJson<ScientificCanvasLayout>(`/api/projects/${encodeURIComponent(projectId)}/research-graph/layout?view=${targetView}`, jsonInit("PUT", { revision: revisionByView.current.get(targetView) ?? 0, positions, viewport: nextViewport }));
        revisionByView.current.set(targetView, saved.revision);
        if (viewRef.current === targetView) { setLayout(saved); setStatus(`布局已保存 · r${saved.revision}`); }
      } catch (error) {
        if (viewRef.current === targetView) { setStatus(error instanceof Error ? `布局保存失败：${error.message}` : "布局保存失败"); await load(); }
      }
    });
  }, [load, projectId, view]);

  const autoArrange = () => {
    if (!graph) return;
    const positions = arrangedPositions(graph.nodes, graph.relations);
    const next = nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    setNodes(next);
    acceptViewportChanges.current = false;
    window.setTimeout(async () => {
      await flow.current?.fitView({ padding: .18, duration: 380 });
      const nextViewport = flow.current?.getViewport() ?? viewport.current;
      viewport.current = nextViewport;
      acceptViewportChanges.current = true;
      persistLayout(next, nextViewport);
    }, 20);
  };

  const selected = graph?.nodes.find((node) => node.id === selectedId);
  const relatedRelations = graph?.relations.filter((relation) => relation.sourceId === selectedId || relation.targetId === selectedId) ?? [];
  const focusedIds = useMemo(() => {
    if (!focusOneHop || !selectedId) return undefined;
    const ids = new Set([selectedId]);
    for (const relation of graph?.relations ?? []) if (relation.sourceId === selectedId || relation.targetId === selectedId) {
      ids.add(relation.sourceId); ids.add(relation.targetId);
    }
    return ids;
  }, [focusOneHop, graph?.relations, selectedId]);
  const filteredEdges = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const matching = term ? new Set(nodes.filter((node) => `${node.data.title} ${node.data.summary} ${kindLabel[node.data.kind] ?? node.data.kind}`.toLocaleLowerCase().includes(term)).map((node) => node.id)) : undefined;
    return edges.map((edge) => {
      const relationMatches = relationFilter === "all" || edge.data?.kind === relationFilter;
      const focusMatches = !focusedIds || (focusedIds.has(edge.source) && focusedIds.has(edge.target));
      return { ...edge, hidden: !relationMatches || !focusMatches, style: { ...edge.style, opacity: matching ? matching.has(edge.source) || matching.has(edge.target) ? .8 : .09 : selectedId && (edge.source === selectedId || edge.target === selectedId) ? .9 : .42, strokeWidth: selectedId && (edge.source === selectedId || edge.target === selectedId) ? 1.8 : 1.15 } };
    });
  }, [edges, focusedIds, nodes, query, relationFilter, selectedId]);
  const displayedNodes = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return nodes.map((node) => {
      const matches = !term || `${node.data.title} ${node.data.summary} ${kindLabel[node.data.kind] ?? node.data.kind}`.toLocaleLowerCase().includes(term);
      return { ...node, hidden: Boolean(focusedIds && !focusedIds.has(node.id)), selected: node.id === selectedId, style: { ...node.style, opacity: matches ? 1 : .18 } };
    });
  }, [focusedIds, nodes, query, selectedId]);

  const focusSearch = () => {
    const term = query.trim().toLocaleLowerCase();
    const match = nodes.find((node) => `${node.data.title} ${node.data.summary}`.toLocaleLowerCase().includes(term));
    if (!match || !flow.current) return;
    setSelectedId(match.id);
    void flow.current.setCenter(match.position.x + 125, match.position.y + 65, { zoom: Math.max(flow.current.getZoom(), .85), duration: 280 });
  };

  const setChatContext = async () => {
    if (!activeSessionId || !selectedId) return;
    setStatus("正在更新 Chat 上下文…");
    try {
      await apiJson(`/api/v1/chat-sessions/${encodeURIComponent(activeSessionId)}/context`, jsonInit("PUT", { activeNodeId: selectedId, quotedNodeIds: quotedIds.filter((id) => id !== selectedId) }));
      await refreshSessions(activeSessionId);
      setStatus("已将科研实体与显式引用设为当前 Chat 上下文");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const submitProposal = async () => {
    if (!proposalTitle.trim() || !proposalSummary.trim()) return;
    const action = selected?.kind === "Claim"
      ? { type: "revise_claim" as const, claimId: selected.id, title: proposalTitle.trim(), summary: proposalSummary.trim() }
      : { type: "create_claim" as const, title: proposalTitle.trim(), summary: proposalSummary.trim() };
    setStatus("正在创建科研图变更提案…");
    try {
      const created = await apiJson<ResearchGraphProposal>(`/api/projects/${encodeURIComponent(projectId)}/research-graph/proposals`, jsonInit("POST", action));
      setProposals((current) => [created, ...current]);
      setProposalOpen(false); setProposalTitle(""); setProposalSummary("");
      setStatus("提案已生成；接受前不会改变科研事实");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const decideProposal = async (proposal: ResearchGraphProposal, decision: "accept" | "reject") => {
    setStatus(decision === "accept" ? "正在应用已确认的科研变更…" : "正在拒绝提案…");
    try {
      await apiJson(`/api/projects/${encodeURIComponent(projectId)}/research-graph/proposals/${proposal.id}/decision`, jsonInit("POST", { decision }));
      await load();
      setStatus(decision === "accept" ? "科研图已写入新主张版本" : "提案已拒绝；科研图未改变");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  return <div className="scientific-canvas-shell">
    <div className="scientific-canvas-topbar">
      <div><span className="scientific-canvas-mark">RG</span><b>科研画布</b><small>事实、证据、计算溯源与产物生命周期</small></div>
      <div className="scientific-canvas-views">{views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} title={item.hint} onClick={() => setView(item.id)}>{item.label}</button>)}</div>
      <div className="scientific-canvas-actions"><button onClick={() => { setProposalOpen(true); setProposalTitle(selected?.kind === "Claim" ? selected.title : ""); setProposalSummary(selected?.kind === "Claim" ? selected.summary : ""); }}>{selected?.kind === "Claim" ? "修订主张" : "提出主张"}</button><button className={focusOneHop ? "active" : ""} disabled={!selectedId} onClick={() => setFocusOneHop((current) => !current)}>{focusOneHop ? "退出聚焦" : "聚焦 1 跳"}</button><button onClick={autoArrange}>自动整理</button><button onClick={() => void flow.current?.fitView({ padding: .18, duration: 300 })}>查看全景</button></div>
    </div>
    <div className="scientific-canvas-search"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") focusSearch(); }} placeholder="搜索实体、摘要或类型" /><button onClick={focusSearch}>定位</button><span>{status}</span></div>
    <ReactFlow<ScientificNode, ScientificEdge>
      nodes={displayedNodes}
      edges={filteredEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => setSelectedId(node.id)}
      onNodeDragStop={(_, dragged) => {
        const snapshot = nodesRef.current.map((node) => node.id === dragged.id ? { ...node, position: dragged.position } : node);
        persistLayout(snapshot);
      }}
      onInit={(instance) => { flow.current = instance; }}
      onMoveEnd={(_, nextViewport) => { viewport.current = nextViewport; if (acceptViewportChanges.current) persistLayout(nodesRef.current, nextViewport); }}
      nodesDraggable
      nodesConnectable={false}
      edgesFocusable={false}
      edgesReconnectable={false}
      panOnScroll
      panOnScrollSpeed={.8}
      zoomOnScroll={false}
      minZoom={.16}
      maxZoom={2.4}
      deleteKeyCode={null}
    >
      <Background color="#dfe4e8" gap={32} size={1} />
      <MiniMap position="bottom-left" pannable zoomable nodeColor={(node) => node.id === selectedId ? "#4c8fd8" : "#aebbc7"} maskColor="rgba(248,250,251,.72)" />
      <Controls position="bottom-right" />
    </ReactFlow>
    <aside className={`scientific-canvas-detail ${selected ? "open" : ""}`}>
      {selected ? <>
        <header><span>{kindLabel[selected.kind] ?? selected.kind}</span><button aria-label="关闭详情" onClick={() => setSelectedId("")}>×</button></header>
        <h2>{selected.title}</h2><p>{selected.summary || "暂无摘要"}</p>
        <dl><div><dt>状态</dt><dd>{selected.status ?? "未标记"}</dd></div><div><dt>版本</dt><dd>{selected.revision}</dd></div><div><dt>关系</dt><dd>{relatedRelations.length}</dd></div>{selected.stance ? <div><dt>立场</dt><dd>{selected.stance}</dd></div> : null}</dl>
        {selected.uri ? <code>{selected.uri}</code> : null}
        {selected.sourceLocator ? <div className="scientific-source-action">{/^https?:\/\//.test(selected.sourceLocator) ? <a href={selected.sourceLocator} target="_blank" rel="noreferrer">打开原始来源 ↗</a> : <button onClick={() => onNavigate?.(selected.kind === "Paper" || selected.kind === "SourceFragment" ? "papers" : selected.kind === "WikiRevisionRef" ? "wiki" : "chat")}>前往来源视图</button>}<small>{selected.sourceLocator}</small></div> : null}
        <section><b>直接关系</b>{relatedRelations.slice(0, 8).map((relation) => {
          const peerId = relation.sourceId === selected.id ? relation.targetId : relation.sourceId;
          const peer = graph?.nodes.find((node) => node.id === peerId);
          return <button key={relation.id} onClick={() => setSelectedId(peerId)}><span>{relationLabel[relation.kind]}</span>{peer?.title ?? peerId}</button>;
        })}{!relatedRelations.length ? <small>尚无直接关系</small> : null}</section>
        <div className="scientific-context-actions">
          <button className={quotedIds.includes(selected.id) ? "active" : ""} onClick={() => setQuotedIds((current) => current.includes(selected.id) ? current.filter((id) => id !== selected.id) : [...current, selected.id].slice(-12))}>{quotedIds.includes(selected.id) ? "移除显式引用" : "加入显式引用"}</button>
          <button className="primary" disabled={!activeSessionId} title={activeSessionId ? "当前会话只会加载该实体的有限科研邻域" : "请先在 Chat 中新建或选择一个对话"} onClick={() => void setChatContext()}>设为 Chat 上下文</button>
        </div>
        {!activeSessionId ? <small className="scientific-context-hint">先在 Chat 新建或选择对话后即可绑定上下文。</small> : <small className="scientific-context-hint">仅加载所选实体、有限邻域与显式引用，不载入整张图。</small>}
      </> : null}
    </aside>
    <div className="scientific-canvas-legend"><button className={relationFilter === "all" ? "active" : ""} onClick={() => setRelationFilter("all")}>全部关系</button>{(["BASED_ON", "ASSERTS", "USED", "GENERATED", "DERIVED_FROM", "EVALUATES"] as ResearchRelationKind[]).map((kind) => <button key={kind} className={relationFilter === kind ? "active" : ""} onClick={() => setRelationFilter((current) => current === kind ? "all" : kind)}><i style={{ background: relationColor[kind] }} />{relationLabel[kind]}</button>)}</div>
    {proposalOpen ? <div className="scientific-proposal-dialog" role="dialog" aria-modal="true" aria-label="科研图变更提案"><div><header><div><small>{selected?.kind === "Claim" ? "创建不可变主张版本" : "创建新科研主张"}</small><h2>预览科研图变更</h2></div><button aria-label="关闭" onClick={() => setProposalOpen(false)}>×</button></header><label><span>主张标题</span><input autoFocus value={proposalTitle} onChange={(event) => setProposalTitle(event.target.value)} /></label><label><span>主张内容与适用边界</span><textarea value={proposalSummary} onChange={(event) => setProposalSummary(event.target.value)} placeholder="写明结论、条件、时间/区域范围和不确定性…" /></label><p>提交只生成待审提案；接受后才会写入 Claim / ClaimRevision，并保留版本关系。</p><footer><button onClick={() => setProposalOpen(false)}>取消</button><button className="primary" disabled={!proposalTitle.trim() || !proposalSummary.trim()} onClick={() => void submitProposal()}>生成提案</button></footer></div></div> : null}
    {proposals.some((proposal) => proposal.status === "pending") ? <aside className="scientific-proposal-tray"><header><b>待确认变更</b><span>{proposals.filter((proposal) => proposal.status === "pending").length}</span></header>{proposals.filter((proposal) => proposal.status === "pending").map((proposal) => <article key={proposal.id}><small>{proposal.action.type === "create_claim" ? "新建主张" : "修订主张"}</small><b>{proposal.action.title}</b><p>{proposal.action.summary}</p><footer><button onClick={() => void decideProposal(proposal, "reject")}>拒绝</button><button className="primary" onClick={() => void decideProposal(proposal, "accept")}>接受并写入</button></footer></article>)}</aside> : null}
  </div>;
}
