export const LORA_MATRIX = "LoRA Multi-Stack (ggtools)";

export function collectMatrices(workflow) {
    const definitions = new Map((workflow.definitions?.subgraphs || []).map((graph) => [graph.id, graph]));
    const matrices = new Map();
    const pending = [{ graph: workflow, path: [], ancestors: new Set() }];
    while (pending.length) {
        const { graph, path, ancestors } = pending.pop();
        if (ancestors.has(graph)) continue;
        for (const node of graph.nodes) {
            const id = [...path, String(node.id)].join(":");
            if (node.type === LORA_MATRIX) matrices.set(id, node);
            const subgraph = definitions.get(node.type);
            if (subgraph) pending.push({ graph: subgraph, path: [...path, String(node.id)], ancestors: new Set(ancestors).add(graph) });
        }
    }
    return matrices;
}

// "0.8" sets both strengths, "0.8/0.5" sets model and clip.
export function parseStrength(text) {
    const parts = String(text).split("/").map((part) => part.trim());
    if (parts.length > 2 || parts.some((part) => part === "" || !Number.isFinite(Number(part)))) return null;
    const [model, clip = model] = parts.map(Number);
    return { model, clip };
}

export function compileMatrices(prompt, matrices) {
    const output = { ...prompt };
    const chains = new Map();

    function chain(id, key) {
        const cacheKey = `${id}|${key}`;
        if (chains.has(cacheKey)) return chains.get(cacheKey);
        const record = prompt[id];
        const { columns, rows } = matrices.get(id).properties.matrix;
        const column = columns.find((column) => column.key === key);
        if (!column) throw new Error(`LoRA Multi-Stack #${id}: a connected group was removed. Reconnect its output.`);
        if (!record.inputs.model) throw new Error(`LoRA Multi-Stack #${id}: connect a model.`);
        let model = follow(record.inputs.model);
        let clip = follow(record.inputs.clip);
        // A bypassed group passes model and clip through without its LoRAs.
        for (const row of column.bypass ? [] : rows) {
            const cell = row.cells[key];
            if (!row.lora || row.mute || !cell?.on || !String(cell.value).trim()) continue;
            const strength = parseStrength(cell.value);
            if (!strength) throw new Error(`LoRA Multi-Stack #${id}: "${cell.value}" for ${row.lora} in ${column.name} isn't a strength. Use a number such as 0.8, or 0.8/0.5 for model/clip.`);
            // A strength of 0 changes nothing, so it needs no loader.
            if (strength.model === 0 && (!clip || strength.clip === 0)) continue;
            const loader = `${id}.${key}.${row.key}`;
            if (clip && strength.clip !== 0) {
                output[loader] = { class_type: "LoraLoader", inputs: { model, clip, lora_name: row.lora, strength_model: strength.model, strength_clip: strength.clip }, _meta: { title: `${column.name}: ${row.lora}` } };
                model = [loader, 0];
                clip = [loader, 1];
            } else {
                output[loader] = { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: row.lora, strength_model: strength.model }, _meta: { title: `${column.name}: ${row.lora}` } };
                model = [loader, 0];
            }
        }
        const result = { model, clip };
        chains.set(cacheKey, result);
        return result;
    }

    function resolve(id, slot) {
        const name = matrices.get(id)?.outputs?.[slot]?.name;
        const [kind, key] = name?.split(":") || [];
        if (kind !== "model" && kind !== "clip") throw new Error(`LoRA Multi-Stack #${id}: reconnect the output in slot ${slot}.`);
        const value = chain(id, key)[kind];
        if (!value) throw new Error(`LoRA Multi-Stack #${id}: connect a clip to use its clip outputs.`);
        return value;
    }

    function follow(value) {
        return Array.isArray(value) && prompt[value[0]]?.class_type === LORA_MATRIX ? resolve(String(value[0]), value[1]) : value;
    }

    for (const id of Object.keys(prompt)) {
        if (prompt[id].class_type === LORA_MATRIX) delete output[id];
    }
    for (const [id, node] of Object.entries(output)) {
        let inputs = null;
        for (const [name, value] of Object.entries(node.inputs)) {
            const resolved = follow(value);
            if (resolved === value) continue;
            inputs ??= { ...node.inputs };
            inputs[name] = resolved;
        }
        if (inputs) output[id] = { ...node, inputs };
    }
    return output;
}
