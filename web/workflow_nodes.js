// Every node of `type` in a saved workflow, by its id in the queued prompt ("5:10" inside subgraph node 5).
export function collectNodes(workflow, type) {
    const definitions = new Map((workflow.definitions?.subgraphs || []).map((graph) => [graph.id, graph]));
    const found = new Map();
    const pending = [{ graph: workflow, path: [], ancestors: new Set() }];
    while (pending.length) {
        const { graph, path, ancestors } = pending.pop();
        if (ancestors.has(graph)) continue;
        for (const node of graph.nodes) {
            const id = [...path, String(node.id)].join(":");
            if (node.type === type) found.set(id, node);
            const subgraph = definitions.get(node.type);
            if (subgraph) pending.push({ graph: subgraph, path: [...path, String(node.id)], ancestors: new Set(ancestors).add(graph) });
        }
    }
    return found;
}
