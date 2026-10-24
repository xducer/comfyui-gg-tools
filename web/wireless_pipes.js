import { app } from "../../../scripts/app.js";
import { PIPE_TO, PIPE_FROM, pipeKey, parseKey, collectPipes, compilePipes } from "./pipe_routing.js";

const states = new WeakMap();
const observed = new WeakSet();

function stateFor(root) {
    if (!states.has(root)) states.set(root, { pending: false, newSources: new Set(), newReceivers: new Set(), copies: new Map() });
    return states.get(root);
}

function rootOf(node) {
    return node.graph?.rootGraph || node.graph;
}

function schedule(root) {
    if (!root) return;
    const state = stateFor(root);
    if (state.pending) return;
    state.pending = true;
    queueMicrotask(() => {
        state.pending = false;
        if (app.configuringGraph) return;
        // A malformed workflow must remain editable; queuing reports the error.
        try { refresh(root); } catch (error) { console.warn(error); }
    });
}

function observe(graph) {
    if (observed.has(graph)) return;
    observed.add(graph);
    for (const event of ["node:added", "node:removed", "configured", "subgraph-created", "convert-to-subgraph", "node:slot-label:changed", "renaming-input"]) {
        graph.events.addEventListener(event, () => schedule(graph.rootGraph || graph));
    }
    // Renamed source nodes rename their entries.
    graph.events.addEventListener("node:property:changed", (event) => {
        if (event.detail.property === "title") schedule(graph.rootGraph || graph);
    });
}

function resize(node) {
    const size = node.computeSize();
    node.setSize([Math.max(node.size[0], size[0]), size[1]]);
    node.graph?.setDirtyCanvas(true, true);
}

// Legacy Reroute nodes pass a value through unchanged, so name the entry after what feeds them.
function namingSource(graph, link) {
    const seen = new Set();
    while (link && !seen.has(link)) {
        seen.add(link);
        if (link.originIsIoNode) return { output: graph.inputs[link.origin_slot] };
        const node = graph.getNodeById(link.origin_id);
        if (node?.type !== "Reroute") return { node, output: node?.outputs?.[link.origin_slot] };
        link = graph.getLink(node.inputs[0]?.link);
    }
    return {};
}

function variableOf(node) {
    if (node?.type !== "GetNode" && node?.type !== "SetNode") return;
    const variable = node.widgets.find((widget) => widget.name === "Constant")?.value;
    if (typeof variable === "string" && variable.trim()) return variable.trim();
}

// Returns [name, bracketed suffix] so duplicate numbers go on the name, e.g. `Encode_2 [latent]`.
function entryName(node, output, type) {
    const fallback = Array.isArray(type) ? "combo" : type === "*" || type === 0 ? "any" : String(type).toLowerCase();
    const descriptive = (name) => typeof name === "string" && name.trim() && name.trim().toLowerCase() !== fallback &&
        !/^(?:\*|any|output|out|value|entry|opt_connection|matchtype)(?:_\d+)?$/i.test(name.trim());
    // The source's own name for the value: a named output, a Get/Set variable, or the type.
    const variable = variableOf(node);
    const own = [output?.label, output?.name].find(descriptive)?.trim() || variable || fallback;
    // A title the user gave the node leads, with the source's own name in brackets unless it is mentioned.
    // KJNodes titles Get/Set nodes after their variable, so those titles are not the user's.
    const title = node?.title?.trim();
    const automatic = [node?.constructor.title, node?.type, own, variable && `Get_${variable}`, variable && `Set_${variable}`];
    if (title && !automatic.includes(title)) return [title, title.toLowerCase().includes(own.toLowerCase()) ? "" : ` [${own}]`];
    if (own !== fallback) return [own, ""];
    // Otherwise use the input name of the source's other consumers when they agree, e.g. `positive`.
    const roles = new Set();
    for (const id of node ? output?.links || [] : []) {
        const link = node.graph.getLink(id);
        const target = link && node.graph.getNodeById(link.target_id);
        const input = target?.type !== PIPE_TO && target?.inputs?.[link.target_slot];
        // A Set node names the value it stores; other consumers name it by their input.
        const name = target?.type === "SetNode" ? variableOf(target) : input && (input.label || input.name);
        if (descriptive(name)) roles.add(name.trim());
    }
    return [roles.size === 1 ? [...roles][0] : fallback, ""];
}

function sourceChoices(node, catalog) {
    const choices = [];
    if (node.graph !== rootOf(node)) {
        const local = new Set();
        for (const source of catalog.sources) {
            if (source.graph !== node.graph || local.has(source.node)) continue;
            local.add(source.node);
            choices.push({ key: pipeKey(null, source.node.properties.pipeId), label: `This instance — Pipe #${source.node.id}` });
        }
    }
    for (const source of catalog.sources) choices.push({ key: source.key, label: source.label });
    return choices;
}

function selectedSource(node, catalog) {
    const choice = node.properties.source;
    if (!choice) return;
    const absolute = catalog.sources.find((source) => source.key === choice);
    if (absolute) return absolute;
    return catalog.sources.find((source) => source.graph === node.graph && pipeKey(null, source.node.properties.pipeId) === choice);
}

function refresh(root) {
    const state = stateFor(root);
    let catalog = collectPipes(root);
    for (const graph of catalog.graphs) observe(graph);
    const senders = new Set(catalog.sources.map((row) => row.node));
    for (const sender of state.newSources) {
        if (!senders.has(sender)) continue;
        if ([...senders].some((other) => other !== sender && other.properties.pipeId === sender.properties.pipeId)) {
            const old = sender.properties.pipeId;
            sender.properties.pipeId = crypto.randomUUID();
            state.copies.set(old, sender);
        }
    }
    for (const sender of senders) sender.updateInputs();
    catalog = collectPipes(root);
    for (const receiver of state.newReceivers) {
        const reference = parseKey(receiver.properties.source);
        if (!reference) continue;
        const [path, uid] = reference;
        const copied = state.copies.get(uid);
        if (!copied) continue;
        const sources = catalog.sources.filter((row) => row.node === copied);
        if (path !== null) {
            const originals = catalog.sources.filter((row) => row.node.properties.pipeId === uid);
            if (originals.length > 1 || sources.length > 1) {
                receiver.properties.source = "";
                receiver.properties.needsSelection = true;
                continue;
            }
            if (originals[0]?.key !== receiver.properties.source) continue;
        } else if (receiver.graph !== copied.graph) continue;
        if (receiver.graph === copied.graph) {
            receiver.properties.source = pipeKey(receiver.graph === root ? [] : null, copied.properties.pipeId);
        } else if (sources.length === 1) receiver.properties.source = sources[0].key;
    }
    // Senders added in this refresh, by the uid they arrived with.
    const added = new Map([...state.newSources].filter((sender) => senders.has(sender)).map((sender) => [sender.properties.pipeId, sender]));
    for (const [uid, sender] of state.copies) added.set(uid, sender);
    state.newSources.clear();
    state.newReceivers.clear();
    state.copies.clear();
    const receivers = new Set(catalog.receivers.map((row) => row.node));
    for (const receiver of receivers) {
        const reference = parseKey(receiver.properties.source);
        if (!reference) continue;
        const [path, uid] = reference;
        // A relative key has no dropdown choice on the main canvas, so it is rewritten as absolute there.
        if (selectedSource(receiver, catalog) && (path !== null || receiver.graph !== root)) continue;
        // Follow a sender moved out of a graph that still exists (Convert to Subgraph, cut/paste),
        // or unpacked from a removed instance. Deleting an instance adds no sender, so it stays missing.
        const moved = path === null || graphAt(root, path)
            ? catalog.sources.filter((row) => row.node.properties.pipeId === uid)
            : catalog.sources.filter((row) => row.node === added.get(uid));
        if (moved.length !== 1) continue;
        receiver.properties.source = receiver.graph === moved[0].graph && receiver.graph !== root ? pipeKey(null, moved[0].node.properties.pipeId) : moved[0].key;
    }
    for (const receiver of receivers) receiver.updateOutputs(catalog);
    return catalog;
}

function graphAt(root, path) {
    let graph = root;
    for (const id of path) graph = graph?.getNodeById(id)?.subgraph;
    return graph;
}

class PipeTo extends LGraphNode {
    static title = PIPE_TO;

    constructor() {
        super(PIPE_TO);
        this.comfyClass = PIPE_TO;
        this.isVirtualNode = false;
        this.properties = { pipeId: crypto.randomUUID(), nextEntry: 0 };
        this.addInput("new", "*", { label: "connect anything" });
    }

    getTitle() {
        return `${this.title} #${this.id}`;
    }

    onAdded() {
        const root = rootOf(this);
        if (!app.configuringGraph) stateFor(root).newSources.add(this);
        schedule(root);
    }

    onConfigure() { schedule(rootOf(this)); }

    onRemoved() { schedule(rootOf(this)); }
    onConnectionsChange() { schedule(rootOf(this)); }
    onConnectionsChainChange() { schedule(rootOf(this)); }

    updateInputs() {
        let changed = false;
        const names = new Set();
        for (let i = this.inputs.length - 1; i >= 0; i--) {
            if (this.inputs[i].name !== "new" && this.inputs[i].link == null) {
                this.removeInput(i);
                changed = true;
            }
        }
        for (const input of this.inputs) {
            if (input.link == null) continue;
            if (input.name === "new") {
                input.name = `entry_${this.properties.nextEntry++}`;
                changed = true;
            }
            const link = this.graph.getLink(input.link);
            const node = link && this.graph.getNodeById(link.origin_id);
            const source = node?.outputs?.[link.origin_slot];
            const boundary = link?.originIsIoNode ? this.graph.inputs[link.origin_slot] : null;
            let type = source?.type || boundary?.type || link?.type || "*";
            if (type === "*" && link?.type) type = link.type;
            const origin = namingSource(this.graph, link);
            const [name, suffix] = entryName(origin.node, origin.output, type);
            let label = name + suffix;
            let count = 1;
            while (names.has(label.toLowerCase())) label = `${name}_${++count}${suffix}`;
            names.add(label.toLowerCase());
            if (input.type !== type || input.label !== label) changed = true;
            input.type = type;
            input.label = label;
        }
        if (!this.inputs.some((input) => input.name === "new")) {
            this.addInput("new", "*", { label: "connect anything" });
            changed = true;
        }
        if (changed) resize(this);
    }
}

class PipeFrom extends LGraphNode {
    static title = PIPE_FROM;

    constructor() {
        super(PIPE_FROM);
        this.comfyClass = PIPE_FROM;
        this.isVirtualNode = false;
        this.serialize_widgets = true;
        this.properties = { source: "", sourceLabel: "", needsSelection: false };
        const widget = this.addWidget("combo", "pipe", "Select a Pipe To", (label) => {
            const catalog = collectPipes(rootOf(this));
            const choice = sourceChoices(this, catalog).find((choice) => choice.label === label);
            if (!choice) return;
            if (choice.key !== this.properties.source) {
                this.properties.source = choice.key;
                this.remapOutputs(catalog);
            }
            this.properties.sourceLabel = choice.label;
            this.properties.needsSelection = false;
            refresh(rootOf(this));
            this.graph.change();
        }, {
            values: () => {
                const root = rootOf(this);
                if (!root) return ["Select a Pipe To"];
                const choices = sourceChoices(this, collectPipes(root));
                const selected = choices.find((choice) => choice.key === this.properties.source);
                const values = choices.map((choice) => choice.label);
                if (!selected) values.unshift(this.properties.source ? `Missing: ${this.properties.sourceLabel}` : this.properties.needsSelection ? "Select copied pipe source" : "Select a Pipe To");
                return values;
            },
        });
        widget.serializeValue = () => this.properties.source;
    }

    onAdded() {
        const root = rootOf(this);
        if (!app.configuringGraph) stateFor(root).newReceivers.add(this);
        schedule(root);
    }

    onConfigure() { schedule(rootOf(this)); }

    onRemoved() { schedule(rootOf(this)); }
    onConnectionsChange() { schedule(rootOf(this)); }

    // Entry keys are per sender, so a new source keeps only outputs with the same label and type.
    remapOutputs(catalog) {
        const entries = selectedSource(this, catalog)?.node.inputs.filter((input) => input.name !== "new") || [];
        const used = new Set();
        this.outputs.forEach((output, i) => {
            const label = (output.label || output.name).replace(/ \(missing\)$/, "");
            const entry = entries.find((entry) => !used.has(entry.name) && entry.label === label && entry.type === output.type);
            if (entry) used.add(entry.name);
            output.name = entry?.name || `missing_${i}`;
        });
    }

    updateOutputs(catalog) {
        let changed = false;
        const choices = sourceChoices(this, catalog);
        if (!this.properties.source && !this.properties.needsSelection && catalog.sources.length === 1) {
            this.properties.source = choices[0].key;
            changed = true;
        }
        const selection = choices.find((choice) => choice.key === this.properties.source);
        const label = selection?.label || (this.properties.source ? `Missing: ${this.properties.sourceLabel}` : this.properties.needsSelection ? "Select copied pipe source" : "Select a Pipe To");
        if (selection) this.properties.sourceLabel = selection.label;
        if (this.widgets[0].value !== label) {
            this.widgets[0].value = label;
            changed = true;
        }
        const source = selectedSource(this, catalog);
        const entries = source?.node.inputs.filter((input) => input.name !== "new") || [];
        for (let i = this.outputs.length - 1; i >= 0; i--) {
            const output = this.outputs[i];
            if (entries.some((input) => input.name === output.name)) continue;
            if (!output.links?.length) this.removeOutput(i);
            else {
                const missing = `${output.label?.replace(/ \(missing\)$/, "") || output.name} (missing)`;
                if (output.label === missing) continue;
                output.label = missing;
            }
            changed = true;
        }
        for (const entry of entries) {
            let output = this.outputs.find((output) => output.name === entry.name);
            if (!output) {
                output = this.addOutput(entry.name, entry.type, { label: entry.label });
                changed = true;
            }
            if (output.type !== entry.type || output.label !== entry.label) {
                output.type = entry.type;
                output.label = entry.label;
                for (const id of output.links || []) {
                    const link = this.graph.getLink(id);
                    if (link) {
                        link.type = entry.type;
                        this.graph.getNodeById(link.target_id)?.onConnectionsChainChange?.();
                    }
                }
                changed = true;
            }
        }
        if (changed) resize(this);
    }
}

app.registerExtension({
    name: "ggtools.wireless_pipes",
    registerCustomNodes() {
        LiteGraph.registerNodeType(PIPE_TO, PipeTo);
        LiteGraph.registerNodeType(PIPE_FROM, PipeFrom);
        PipeTo.category = "ggtools";
        PipeFrom.category = "ggtools";
    },
    setup() {
        const graphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function (graph = this.rootGraph || this.graph, ...args) {
            const catalog = refresh(graph);
            const result = await graphToPrompt.call(this, graph, ...args);
            if (!catalog.sources.length && !catalog.receivers.length) return result;
            return { ...result, output: compilePipes(result.output, collectPipes(result.workflow)) };
        };
    },
    afterConfigureGraph() {
        schedule(app.rootGraph || app.graph);
    },
});
