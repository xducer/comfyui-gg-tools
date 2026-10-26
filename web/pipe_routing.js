export const PIPE_TO = "Pipe To (ggtools)";
export const PIPE_FROM = "Pipe From (ggtools)";

export function pipeKey(path, id) {
    return JSON.stringify([path, id]);
}

export function parseKey(key) {
    let reference;
    try { reference = JSON.parse(key); } catch { return null; }
    if (!Array.isArray(reference) || reference.length !== 2 ||
        !(reference[0] === null || Array.isArray(reference[0])) || typeof reference[1] !== "string") return null;
    return reference;
}

export function collectPipes(root) {
    const definitions = new Map((root.definitions?.subgraphs || []).map((graph) => [graph.id, graph]));
    const sources = [];
    const receivers = [];
    const graphs = new Set();
    const pending = [{ graph: root, path: [], location: [], ancestors: new Set() }];
    while (pending.length) {
        const { graph, path, location, ancestors } = pending.pop();
        if (ancestors.has(graph)) throw new Error("GG Tools pipes: remove the recursive subgraph before queuing.");
        const nextAncestors = new Set(ancestors).add(graph);
        graphs.add(graph);
        for (const node of graph.nodes) {
            const id = [...path, String(node.id)].join(":");
            if (node.type === PIPE_TO || node.type === PIPE_FROM) {
                const row = { id, path, node, graph };
                if (node.type === PIPE_TO) {
                    row.key = pipeKey(path, node.properties.pipeId);
                    const title = node.title && node.title !== PIPE_TO ? ` — ${node.title}` : "";
                    row.label = `Pipe #${node.id}${title} — ${location.join(" / ") || "Main canvas"}`;
                    sources.push(row);
                } else receivers.push(row);
            }
            const subgraph = node.subgraph || definitions.get(node.type);
            if (subgraph) pending.push({
                graph: subgraph,
                path: [...path, String(node.id)],
                location: [...location, `${node.title || "Subgraph"} #${node.id}`],
                ancestors: nextAncestors,
            });
        }
    }
    return { sources, receivers, graphs };
}

const OMITTED = Symbol("omitted input");

export function compilePipes(prompt, catalog) {
    const sources = new Map(catalog.sources.map((row) => [row.key, row]));
    const receivers = new Map(catalog.receivers.map((row) => [row.id, row]));
    const cache = new Map();
    const changed = new Set();

    function resolve(start) {
        let value = start;
        const chain = [];
        const active = new Set();
        while (Array.isArray(value) && prompt[value[0]]?.class_type === PIPE_FROM) {
            const [id, slot] = value;
            const key = JSON.stringify(value);
            if (cache.has(key)) { value = cache.get(key); break; }
            if (active.has(key)) throw new Error(`GG Tools pipes: connection loop at Pipe From #${id}.`);
            active.add(key);
            chain.push(key);
            const receiver = receivers.get(String(id));
            if (!receiver) throw new Error(`GG Tools pipes: Pipe From #${id} is missing from the workflow.`);
            const reference = parseKey(prompt[id].inputs.pipe);
            if (!reference) throw new Error(`Pipe From #${id}: select a Pipe To source.`);
            const [path, uid] = reference;
            const source = sources.get(pipeKey(path === null ? receiver.path : path, uid));
            if (!source) throw new Error(`Pipe From #${id}: the selected source is missing. Select a Pipe To.`);
            const entry = receiver.node.outputs[slot]?.name;
            if (!entry || !source.node.inputs.some((input) => input.name === entry)) {
                throw new Error(`Pipe From #${id}: a connected entry was removed. Reconnect the missing output.`);
            }
            const sender = prompt[source.id];
            value = sender && Object.hasOwn(sender.inputs, entry) ? sender.inputs[entry] : OMITTED;
        }
        for (const key of chain) cache.set(key, value);
        return value;
    }

    const output = {};
    for (const [id, node] of Object.entries(prompt)) {
        if (node.class_type === PIPE_TO || node.class_type === PIPE_FROM) continue;
        const inputs = { ...node.inputs };
        for (const [name, value] of Object.entries(inputs)) {
            if (!Array.isArray(value) || prompt[value[0]]?.class_type !== PIPE_FROM) continue;
            changed.add(id);
            const resolved = resolve(value);
            if (resolved === OMITTED) delete inputs[name];
            else inputs[name] = resolved;
        }
        output[id] = { ...node, inputs };
    }

    // Only visit dependencies of consumers changed by wireless routing.
    const state = new Map();
    for (const id of changed) {
        const stack = [[id, false]];
        while (stack.length) {
            const [current, leaving] = stack.pop();
            if (leaving) { state.set(current, 2); continue; }
            if (state.get(current) === 2) continue;
            if (state.get(current) === 1) throw new Error(`GG Tools pipes: execution dependency loop at node #${current}.`);
            if (!output[current]) continue;
            state.set(current, 1);
            stack.push([current, true]);
            for (const value of Object.values(output[current].inputs)) {
                if (Array.isArray(value)) stack.push([String(value[0]), false]);
            }
        }
    }
    return output;
}
