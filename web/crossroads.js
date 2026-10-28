import { app } from "../../../scripts/app.js";
import { SPLIT, JOIN, MissingInputsError, compileCrossroads, pathByNumber } from "./crossroads_compile.js";
import { addPromptStep, CROSSROADS } from "./prompt_steps.js";

const { ComfyWidgets } = window.comfyAPI.widgets;
const { PromptExecutionError } = window.comfyAPI.api;
const { setWidgetConfig } = window.comfyAPI.widgetInputs;

// ComfyUI names a subgraph input or output made by dropping onto a socket after that socket ("v3", or "v3_1").
const namedAfter = (io, slot) => io.name === slot?.name || io.name.startsWith(`${slot?.name}_`);

// What a connection carries, as the source names it: an output label, or its type in lower case. Straight from a
// Split it is that Split's value name, not its "Path 2 · image" output label, so nested crossroads stay readable.
// A subgraph input named after the receiving socket, and not renamed by hand, says nothing about the value, so its
// type names it instead; a "Path 2 · " in a subgraph input's label is ours (copied from a Split output when
// converting, or set by labelBoundary) and is left off, so the name doesn't grow a prefix each round trip.
function sourceLabel(graph, link) {
    const source = link.originIsIoNode ? null : graph.getNodeById(link.origin_id);
    const output = link.originIsIoNode ? graph.inputs?.[link.origin_slot] : source?.outputs?.[link.origin_slot];
    if (link.originIsIoNode && output) {
        if (!renamedByHand(output) && namedAfter(output, graph.getNodeById(link.target_id)?.inputs?.[link.target_slot])) {
            return !link.type || link.type === "*" ? "value" : String(link.type).toLowerCase();
        }
        return withoutPath(output.label || output.name);
    }
    if (source instanceof CrossroadsSplit) {
        const value = source.inputs.find((input) => input.name === output?.name.split(":")[1]);
        if (value?.label) return value.label;
    }
    const name = output?.label || output?.localized_name || output?.name || String(link.type);
    return name === link.type ? name.toLowerCase() : name;
}

const isValue = (input) => /^v\d+$/.test(input.name);
// Slot labels are drawn by the node, so an inactive path's can be dimmed; the frontend draws every label alike.
const INACTIVE_ALPHA = 0.4;
// The row between the Split's sockets and its path field holds the "+ Path" control, under the outputs.
const PATH_ROW = 20;
// Like the remove buttons of the LoRA Multi-Stack: grey, red under the pointer.
const REMOVE_HOVER = "#ff6b6b";

function hideLabel(slot) {
    if (!Object.hasOwn(slot, "renderingLabel")) Object.defineProperty(slot, "renderingLabel", { get: () => "", configurable: true });
}

function drawLabel(ctx, node, text, input, slot, alpha) {
    const [x, y] = node.getConnectionPos(input, slot);
    ctx.globalAlpha = alpha;
    ctx.textAlign = input ? "left" : "right";
    ctx.fillText(text, x - node.pos[0] + (input ? 10 : -10), y - node.pos[1] + 5);
}

// Wires are read through the node: an input's link lives in the graph's link store, filed by slot number.
const inputLink = (node, input) => node.getInputLink(node.inputs.indexOf(input));
const linksOf = (node) => (node?.inputs ?? []).map((input) => inputLink(node, input)).filter(Boolean);

// The Split path a connection comes from: the nearest Split upstream. A nested crossroads counts as one node,
// whose inputs are those of its own Split.
function tracePath(graph, link) {
    let level = [link];
    const seen = new Set();
    while (level.length) {
        const next = [];
        for (const link of level) {
            const node = graph.getNodeById(link.origin_id);
            if (!node || seen.has(node)) continue;
            seen.add(node);
            if (node instanceof CrossroadsSplit) {
                const key = node.outputs[link.origin_slot]?.name.split(":")[0];
                const path = node.crossroads.paths.find((path) => path.key === key);
                if (path) return { split: node, path };
                continue;
            }
            const from = node instanceof CrossroadsJoin ? node.pairedSplit() : node;
            next.push(...linksOf(from));
        }
        level = next;
    }
}

// Gives a node exactly the `wanted` outputs ({ name, type, label }), in that order. The frontend files links under
// their origin slot number, so a moved output takes its links along explicitly; nodes that name their inputs after
// the source (Pipe To) learn about renamed outputs, as on reconnecting.
function arrangeOutputs(node, wanted) {
    for (let i = node.outputs.length - 1; i >= 0; i--) {
        if (!wanted.some((w) => w.name === node.outputs[i].name)) node.removeOutput(i);
    }
    const changed = new Set();
    for (const w of wanted) {
        const output = node.outputs.find((output) => output.name === w.name) || node.addOutput(w.name, w.type);
        if (output.label !== w.label || output.type !== w.type) changed.add(output);
        Object.assign(output, { label: w.label, type: w.type });
    }
    const order = wanted.map((w) => w.name);
    const before = [...node.outputs];
    const sorted = [...before].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    const outgoing = [...node.graph.links.values()].filter((link) => link.origin_id === node.id);
    if (sorted.some((output, i) => output !== before[i])) {
        const moves = outgoing.map((link) => [link, sorted.indexOf(before[link.origin_slot])]);
        node.outputs.splice(0, node.outputs.length, ...sorted);
        for (const [link, slot] of moves) link.origin_slot = slot;
    }
    for (const link of outgoing.filter((link) => changed.has(node.outputs[link.origin_slot]))) {
        link.type = node.outputs[link.origin_slot].type;
        const target = node.graph.getNodeById(link.target_id);
        target?.onConnectionsChange?.(LiteGraph.INPUT, link.target_slot, true, link, target.inputs?.[link.target_slot]);
    }
}

// An old-style Primitive only hands its value to an input's field, and Split values and Join rows have none, so
// the value would never arrive. They refuse it instead, pointing to the nodes that send a real wire.
function refusePrimitive(origin) {
    if (origin?.type !== "PrimitiveNode") return false;
    app.extensionManager.toast.add({ severity: "warn", summary: "Crossroads", detail: "Use an Int, Float, String or Boolean node here: the old Primitive only feeds fields, so its value would not arrive.", life: 6000 });
    return true;
}

// Such a subgraph socket would show our socket's key ("p6:v2"), which the queue step reads; it shows the node's name
// for what flows through instead (`boundaryLabel`), until renamed by hand.
const boundaryLabels = new WeakMap();
let relabelling = false;

// A label counts as ours when we set it this session, or when it is one of our "Path 2 · image" labels that only
// differs in the path number (saved before the paths were renumbered).
const withoutPath = (label) => label?.replace(/^Path \d+ · /, "");
const renamedByHand = (io, label) => !!io.label && io.label !== boundaryLabels.get(io)
    && !(label && io.label !== withoutPath(io.label) && withoutPath(io.label) === withoutPath(label));

function labelBoundary(node) {
    const { graph } = node;
    if (!graph || graph === graph.rootGraph) return;
    const relabel = (io, slot, input, rename) => {
        const label = slot && node.boundaryLabel(slot, input);
        if (!io || !label || !namedAfter(io, slot) || renamedByHand(io, label)) return;
        boundaryLabels.set(io, label);
        if (io.label === label) return;
        relabelling = true;
        rename(io, label);
        relabelling = false;
    };
    for (const link of graph.links.values()) {
        if (link.origin_id === node.id && link.targetIsIoNode) relabel(graph.outputs[link.target_slot], node.outputs[link.origin_slot], false, (io, label) => graph.renameOutput(io, label));
        if (link.target_id === node.id && link.originIsIoNode) relabel(graph.inputs[link.origin_slot], node.inputs[link.target_slot], true, (io, label) => graph.renameInput(io, label));
    }
}

// Renaming a subgraph input or output by hand renames what flows through it, so a node inside refreshes its labels
// then; our own relabelling is left out. The event comes before the new name is set. Returns the function that
// stops listening.
function watchRenames(node, refresh) {
    const events = node.graph && node.graph !== node.graph.rootGraph ? node.graph.events : null;
    if (!events) return null;
    const listener = () => { if (!relabelling) queueMicrotask(refresh); };
    for (const type of ["renaming-input", "renaming-output"]) events.addEventListener(type, listener);
    return () => { for (const type of ["renaming-input", "renaming-output"]) events.removeEventListener(type, listener); };
}

function crossroadsNodes(type) {
    const root = app.rootGraph || app.graph;
    return [root, ...(root?.subgraphs?.values?.() ?? [])].flatMap((graph) => graph?.nodes ?? []).filter((node) => node instanceof type);
}

function grow(node) {
    const [width, height] = node.computeSize();
    node.setSize([Math.max(node.size[0], width), height]);
    node.graph?.setDirtyCanvas(true, true);
}

class CrossroadsSplit extends LGraphNode {
    static title = SPLIT;
    static description = "Sends its inputs down one of several numbered paths. Only the selected path runs; the others are left out of the queued prompt.";

    constructor() {
        super(SPLIT);
        this.comfyClass = SPLIT;
        this.isVirtualNode = false;
        this.serialize_widgets = true;
        this.properties = { crossroads: { paths: [{ key: "p0" }, { key: "p1" }], next: 2 } };
        // A widget input, so the path number can also come from an Int, a Primitive or a subgraph input.
        this.addInput("path", "INT", { widget: { name: "path" } });
        this.pathWidget = ComfyWidgets.INT(this, "path", ["INT", { default: 1, min: 1, max: 2 }], app).widget;
        this.describePathInput();
        this.addValueInput();
        this.update();
    }

    get crossroads() { return this.properties.crossroads; }

    onAdded() { this.unwatch = watchRenames(this, () => this.update()); }

    // Joins that only reach this Split through other nodes get no callback when it goes, so they are told.
    onRemoved() {
        this.unwatch?.();
        const { graph } = this;
        queueMicrotask(() => { for (const join of crossroadsNodes(CrossroadsJoin)) if (join.graph === graph) join.sync(); });
    }

    // A subgraph socket made from one of the Split's shows the value's name, or the output's "Path 2 · image".
    boundaryLabel(slot) {
        return slot.label;
    }

    // An old-style Primitive wired into `path` builds its field from the input's widget config, which a node from a
    // node definition gets from that definition. Loading replaces the inputs, so it is set again then. The wrapper
    // stores the config on the input's widget without the frontend rebuilding a connected Primitive mid-load. The
    // maximum is not the path count: a Primitive counting up still wraps around through the paths.
    describePathInput() {
        const input = this.inputs.find((input) => input.name === "path");
        setWidgetConfig({ widget: input.widget }, ["INT", { default: 1, min: 1, max: 9999 }]);
    }

    pathName(path) { return `Path ${this.crossroads.paths.indexOf(path) + 1}`; }

    addValueInput() {
        this.addInput(`v${this.crossroads.next++}`, "*", { label: "connect anything" });
    }

    // Pasting configures the node, then restores its wires in the same step; values left without a wire on
    // either side (a Split pasted without its sources) are tidied away once that is done.
    onConfigure() {
        this.describePathInput();
        this.pathWidget.options.max = this.crossroads.paths.length;
        this.placeWidgets();
        queueMicrotask(() => { if (this.graph) this.update(true); });
    }

    // The path that will run, as far as the canvas can tell: a wired number counts only when it comes straight
    // from a constant, as at queue time.
    selectedPath() {
        let value = this.pathWidget.value;
        const link = this.graph && this.getInputLink(this.inputs.findIndex((input) => input.name === "path"));
        if (link) {
            const source = link.originIsIoNode ? null : this.graph.getNodeById(link.origin_id);
            value = linksOf(source).length ? undefined : source?.widgets?.find((widget) => widget.name === "value")?.value;
        }
        return Number.isInteger(value) ? pathByNumber(this.crossroads.paths, value) : undefined;
    }

    // Hovering an output shows a × left of its label that removes its path; "+ Path" sits above the path field.
    // Both are drawn here and their areas kept in `controls` for onMouseDown.
    onDrawForeground(ctx, canvas) {
        this.controls = [];
        if (this.flags.collapsed || canvas?.low_quality) return;
        const selected = this.selectedPath();
        ctx.save();
        ctx.font = this.innerFontStyle;
        this.outputs.forEach((output, slot) => {
            const key = output.name.split(":")[0];
            ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR;
            drawLabel(ctx, this, output.label, false, slot, !selected || selected.key === key ? 1 : INACTIVE_ALPHA);
            if (this.hovered?.slot !== slot || this.crossroads.paths.length < 2) return;
            const path = this.crossroads.paths.find((path) => path.key === key);
            const [x, y] = this.getConnectionPos(false, slot);
            const center = x - this.pos[0] - 10 - ctx.measureText(output.label).width - 10;
            this.drawControl(ctx, `remove:${key}`, "×", center, y - this.pos[1], "center", () => this.removePath(path));
        });
        this.drawControl(ctx, "add", "+ Path", this.size[0] - 15, this.widgets_start_y - PATH_ROW / 2, "right", () => this.addPath());
        ctx.restore();
    }

    drawControl(ctx, id, text, x, y, align, action) {
        const width = ctx.measureText(text).width;
        const left = { center: x - width / 2, right: x - width, left: x }[align] - 4;
        const lit = this.hovered?.control === id;
        ctx.globalAlpha = 1;
        ctx.textAlign = align;
        ctx.fillStyle = lit ? (id === "add" ? LiteGraph.NODE_TEXT_COLOR : REMOVE_HOVER) : LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
        ctx.fillText(text, x, y + 4);
        this.controls.push({ id, left, right: left + width + 8, top: y - 9, bottom: y + 9, action });
    }

    controlAt([x, y]) {
        return this.controls?.find((c) => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom);
    }

    onMouseMove(e, pos) {
        const slot = this.outputs.findIndex((output, i) => Math.abs(this.getConnectionPos(false, i)[1] - this.pos[1] - pos[1]) <= LiteGraph.NODE_SLOT_HEIGHT / 2);
        const hovered = { slot: slot >= 0 ? slot : null, control: this.controlAt(pos)?.id ?? null };
        if (hovered.slot !== this.hovered?.slot || hovered.control !== this.hovered?.control) this.setDirtyCanvas(true, false);
        // A hand over the drawn controls, like the Multi-Stack's buttons. The canvas sets its own cursor after this
        // handler on every move, so the hand goes in once it is done, through the canvas's setter (it caches the
        // cursor it set). Off a control, the canvas's own cursor simply stays.
        if (hovered.control != null) queueMicrotask(() => app.canvas?._setCursor?.("pointer"));
        this.hovered = hovered;
    }

    onMouseLeave() {
        this.hovered = null;
        this.setDirtyCanvas(true, false);
    }

    onMouseDown(e, pos) {
        const control = this.controlAt(pos);
        if (!control) return false;
        control.action();
        return true;
    }

    // Room for the × left of the output labels; the "+ Path" row is in widgets_start_y.
    computeSize(out) {
        const size = super.computeSize(out);
        size[0] += 20;
        return size;
    }

    // The widgets would start right below the last socket; leave a row there for "+ Path".
    placeWidgets() {
        const ys = [
            ...this.inputs.flatMap((input, i) => (input.widget ? [] : [this.getConnectionPos(true, i)[1]])),
            ...this.outputs.map((output, i) => this.getConnectionPos(false, i)[1]),
        ];
        this.widgets_start_y = Math.max(...ys) - this.pos[1] + LiteGraph.NODE_SLOT_HEIGHT / 2 + 2 + PATH_ROW;
    }

    onConnectInput(slot, type, output, origin) {
        return !(isValue(this.inputs[slot]) && refusePrimitive(origin));
    }

    // Links are only complete once the workflow has loaded; afterConfigureGraph syncs then.
    // Removing a path's outputs disconnects their wires, which calls back here mid-update.
    onConnectionsChange(type, index, connected, link) {
        if (app.configuringGraph || this.updating) return;
        const input = type === LiteGraph.INPUT ? this.inputs[index] : null;
        if (input && !isValue(input)) return;
        if (input && connected && link) {
            input.type = link.type;
            input.label = sourceLabel(this.graph, link);
        }
        this.update(!connected);
    }

    // Unused values are only dropped after a wire is removed (`prune`): pasting restores wires one at a time, and
    // pruning then would drop values whose wires are still to come.
    update(prune = false) {
        this.pathWidget.options.max = this.crossroads.paths.length;
        if (this.pathWidget.value > this.crossroads.paths.length) this.pathWidget.value = this.crossroads.paths.length;
        if (this.graph) {
            this.updating = true;
            this.syncInputs(prune);
            this.syncOutputs();
            this.updating = false;
        }
        this.placeWidgets();
        grow(this);
        labelBoundary(this);
        for (const join of crossroadsNodes(CrossroadsJoin)) if (join.graph === this.graph) join.sync();
    }

    // A value stays while it is connected on either side; one spare input waits at the end.
    syncInputs(prune) {
        const used = (input) => inputLink(this, input) || this.outputs.some((output, slot) => output.name.endsWith(`:${input.name}`) && this.isOutputConnected(slot));
        for (let i = this.inputs.length - 2; prune && i >= 0; i--) {
            if (isValue(this.inputs[i]) && !used(this.inputs[i])) this.removeInput(i);
        }
        const last = this.inputs.at(-1);
        if (!isValue(last) || used(last)) this.addValueInput();
        else Object.assign(last, { type: "*", label: "connect anything" });
        // A connected value keeps the name its source gives it, which can change after connecting.
        for (const input of this.inputs.filter(isValue)) {
            const link = inputLink(this, input);
            if (link) input.label = sourceLabel(this.graph, link);
        }
    }

    // Each path gives one output per value, grouped by path.
    syncOutputs() {
        // Every value but the spare at the end, whatever its type: a "*" value (from a subgraph input) carries too.
        const values = this.inputs.filter(isValue).slice(0, -1);
        arrangeOutputs(this, this.crossroads.paths.flatMap((path) => values.map((input) => ({ name: `${path.key}:${input.name}`, type: input.type, label: `${this.pathName(path)} · ${input.label}` }))));
        // The Split draws its output labels itself, dimming the paths that aren't selected.
        for (const output of this.outputs) hideLabel(output);
    }

    getExtraMenuOptions() {
        const { paths } = this.crossroads;
        return [
            { content: "Add path", callback: () => this.addPath() },
            {
                content: "Remove path", has_submenu: true, disabled: paths.length < 2,
                submenu: { options: paths.map((path) => ({ content: this.pathName(path), callback: () => this.removePath(path) })) },
            },
        ];
    }

    addPath() {
        this.crossroads.paths.push({ key: `p${this.crossroads.next++}` });
        this.update();
    }

    // The paths after it move up a number; the typed selection follows, so the same path stays selected.
    removePath(path) {
        const index = this.crossroads.paths.indexOf(path);
        if (index + 1 < this.pathWidget.value) this.pathWidget.value--;
        this.crossroads.paths.splice(index, 1);
        this.update();
    }
}

class CrossroadsJoin extends LGraphNode {
    static title = JOIN;
    static description = "Brings the paths of a Crossroads Split back together: inputs are grouped by path, and each output carries what the selected path delivers.";

    constructor() {
        super(JOIN);
        this.comfyClass = JOIN;
        this.isVirtualNode = false;
        // A row per value brought back, with an input for each path of the Split and one output.
        this.properties = { crossroads: { values: [], next: 0 } };
        this.addInput("+", "*", { label: "connect a path" });
        grow(this);
    }

    get crossroads() { return this.properties.crossroads; }

    // The Split whose paths this Join brings together: the one its wires trace back to.
    pairedSplit() {
        for (const link of linksOf(this)) {
            const traced = tracePath(this.graph, link);
            if (traced) return traced.split;
        }
        return null;
    }

    onConnectInput(slot, type, output, origin) {
        return !refusePrimitive(origin);
    }

    onAdded() { this.unwatch = watchRenames(this, () => this.sync()); }

    onRemoved() { this.unwatch?.(); }

    // A subgraph socket made from one of the Join's shows its label ("Path 1 · image", or the output's value); the
    // spare is never named.
    boundaryLabel(slot) {
        return slot.name === "+" ? null : slot.label;
    }

    // Like the Split: once a paste has restored the wires, rows left without any are tidied away.
    onConfigure() {
        queueMicrotask(() => this.sync(true));
    }

    onConnectionsChange(type, index, connected, link) {
        if (app.configuringGraph || this.updating) return;
        // Rows are only dropped after a wire is removed: pasting restores wires one at a time. A wire dropped on a used
        // input replaces its wire, and the canvas reports that removal first, so tidying up waits until the new wire
        // is in place.
        if (!connected) {
            if (type === LiteGraph.INPUT && link) this.replaced = { name: this.inputs[index]?.name, origin: link.origin_id, slot: link.origin_slot };
            queueMicrotask(() => {
                this.replaced = null;
                this.sync(true);
            });
            return;
        }
        const restore = type === LiteGraph.INPUT && connected && link ? this.place(index, link) : null;
        this.sync();
        restore?.();
    }

    // A new wire goes to its value's row under the path it comes from. Dropped on the spare, it fills its path's free
    // slot in a row of the same type, or starts a new row; dropped on a row, it lands in that row's slot for its own
    // path. A wire from no path of this Join's Split stays where it was dropped on a row, since a path may start
    // elsewhere; the spare can't tell which path it is for.
    place(index, link) {
        const input = this.inputs[index];
        const split = this.pairedSplit();
        const traced = tracePath(this.graph, link);
        const path = traced && traced.split === split ? traced.path : null;
        let row = input.name === "+" ? null : input.name.split(":")[1];
        if (!path) {
            if (row) return;
            // Disconnecting from inside the connection callback would undo a link the canvas is still finishing.
            queueMicrotask(() => this.disconnectInput(this.inputs.findIndex((input) => inputLink(this, input) === link)));
            const detail = traced ? "This wire comes from another Crossroads Split. To use it here, drop it on a path's row of this Join."
                : "Connect a wire that comes from a Crossroads Split path, or drop it on a path's row of the Join.";
            app.extensionManager.toast.add({ severity: "warn", summary: "Crossroads", detail, life: 6000 });
            return;
        }
        row ??= this.crossroads.values.find((value) => {
            const slot = this.inputs.find((input) => input.name === `${path.key}:${value.key}`);
            return slot && !inputLink(this, slot) && slot.type === link.type;
        })?.key;
        if (!row) {
            row = `j${this.crossroads.next++}`;
            this.crossroads.values.push({ key: row });
        }
        this.pending = { link: link.id, name: `${path.key}:${row}` };
        // Moved on to its own path's slot, it gives the slot it was dropped on its replaced wire back.
        const replaced = this.replaced?.name === input.name && this.pending.name !== input.name ? this.replaced : null;
        this.replaced = null;
        if (replaced) return () => {
            const to = this.inputs.findIndex((input) => input.name === replaced.name);
            if (to >= 0 && !this.isInputConnected(to)) this.graph.getNodeById(replaced.origin)?.connect(replaced.slot, this, to);
        };
    }

    // Inputs grouped by path, each path with a slot per row, then the spare; an output per row. `prune` drops rows
    // nothing is connected to.
    sync(prune = false) {
        if (!this.graph || this.updating) return;
        this.updating = true;
        this.split = this.pairedSplit();
        const pathKeys = this.split ? this.split.crossroads.paths.map((path) => path.key)
            : [...new Set(this.inputs.filter((input) => input.name !== "+").map((input) => input.name.split(":")[0]))];
        const rowOf = (input) => input.name.split(":")[1];
        const used = (key) => this.inputs.some((input) => rowOf(input) === key && inputLink(this, input))
            || this.outputs.some((output, slot) => output.name === key && this.isOutputConnected(slot));
        if (prune) this.crossroads.values = this.crossroads.values.filter((value) => used(value.key));
        const wanted = [...pathKeys.flatMap((path) => this.crossroads.values.map((value) => `${path}:${value.key}`)), "+"];
        for (let i = this.inputs.length - 1; i >= 0; i--) {
            if (!wanted.includes(this.inputs[i].name)) this.removeInput(i);
        }
        for (const name of wanted) if (!this.inputs.some((input) => input.name === name)) this.addInput(name, "*");
        if (this.pending) {
            const target = this.inputs.find((input) => input.name === this.pending.name);
            const held = inputLink(this, target);
            if (held && held.id !== this.pending.link) this.disconnectInput(this.inputs.indexOf(target));
        }
        // Each wire is read while the slots are still in place, then filed under its input's new slot.
        const wires = new Map(this.inputs.map((input) => [input, inputLink(this, input)]).filter(([, link]) => link));
        if (this.pending) {
            const link = this.graph.links.get(this.pending.link);
            for (const [input, held] of wires) if (held === link) wires.delete(input);
            wires.set(this.inputs.find((input) => input.name === this.pending.name), link);
            this.pending = null;
        }
        this.inputs.sort((a, b) => wanted.indexOf(a.name) - wanted.indexOf(b.name));
        // An input slot holds one link, so the moving links pass through free slot numbers on the way.
        const moves = [...wires].map(([input, link]) => [link, this.inputs.indexOf(input)]).filter(([link, slot]) => link.target_slot !== slot);
        moves.forEach(([link], i) => { link.target_slot = this.inputs.length + 1000 + i; });
        for (const [link, slot] of moves) link.target_slot = slot;
        const outputs = this.crossroads.values.map((value) => {
            const row = this.inputs.filter((input) => rowOf(input) === value.key);
            const link = row.map((input) => inputLink(this, input)).find(Boolean);
            const output = this.outputs.find((output) => output.name === value.key);
            const type = link?.type ?? output?.type ?? "*";
            const label = link ? sourceLabel(this.graph, link) : output?.label ?? "value";
            // A Join that can't see its Split (across a subgraph edge) numbers its path groups in order.
            for (const input of row) {
                const key = input.name.split(":")[0];
                const path = this.split?.crossroads.paths.find((path) => path.key === key);
                Object.assign(input, { type, label: `${path ? this.split.pathName(path) : `Path ${pathKeys.indexOf(key) + 1}`} · ${label}` });
            }
            return { name: value.key, type, label };
        });
        Object.assign(this.inputs.at(-1), { type: "*", label: "connect a path" });
        for (const input of this.inputs) hideLabel(input);
        arrangeOutputs(this, outputs);
        this.updating = false;
        grow(this);
        labelBoundary(this);
    }

    // Inputs from a path that isn't selected are dimmed, like the matching Split outputs.
    onDrawForeground(ctx, canvas) {
        if (this.flags.collapsed || canvas?.low_quality) return;
        const selected = this.split?.selectedPath();
        ctx.save();
        ctx.font = this.innerFontStyle;
        ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR;
        this.inputs.forEach((input, slot) => {
            const dim = selected && input.name !== "+" && input.name.split(":")[0] !== selected.key;
            drawLabel(ctx, this, input.label, true, slot, dim ? INACTIVE_ALPHA : 1);
        });
        ctx.restore();
    }
}

// Required inputs left empty are reported like the server's own validation errors, so ComfyUI rings them and lists
// them in its errors panel. It does that only for errors from the request, not from building the prompt, so the
// build remembers them against its workflow and the request raises them before anything is sent.
const missingByWorkflow = new WeakMap();

const nodeDef = (type) => LiteGraph.registered_node_types[type]?.nodeData;

// The nodes a queued run executes: the output nodes, or the selected ones for "Queue Selected Output Nodes", and
// everything they depend on. Like the server, a missing input elsewhere doesn't stop the run.
function needed(output, targets) {
    const pending = targets?.length ? targets.map(String) : Object.keys(output).filter((id) => nodeDef(output[id].class_type)?.output_node);
    const seen = new Set();
    while (pending.length) {
        const id = pending.pop();
        if (seen.has(id) || !output[id]) continue;
        seen.add(id);
        for (const value of Object.values(output[id].inputs)) if (Array.isArray(value) && output[value[0]]) pending.push(String(value[0]));
    }
    return seen;
}

function validationError(missing) {
    const nodeErrors = {};
    for (const { id, classType, name, message } of missing) {
        nodeErrors[id] ??= { errors: [], class_type: classType, dependent_outputs: [] };
        nodeErrors[id].errors.push({ type: "required_input_missing", message: "Required input is missing", details: message, extra_info: { input_name: name } });
    }
    return new PromptExecutionError({ error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "" }, node_errors: nodeErrors }, 400);
}

app.registerExtension({
    name: "ggtools.crossroads",
    registerCustomNodes() {
        LiteGraph.registerNodeType(SPLIT, CrossroadsSplit);
        LiteGraph.registerNodeType(JOIN, CrossroadsJoin);
        CrossroadsSplit.category = "ggtools";
        CrossroadsJoin.category = "ggtools";
    },
    // The frontend builds a bare definition for frontend-only nodes; add the terms people search for.
    beforeRegisterVueAppNodeDefs(defs) {
        const aliases = {
            [SPLIT]: ["Switch", "Router", "Route", "Branch", "Path", "If", "Select", "Bypass", "Mute", "Toggle", "Enable", "Disable"],
            [JOIN]: ["Switch", "Merge", "Route", "Branch", "Path", "Select"],
        };
        for (const def of defs) if (aliases[def.name]) def.search_aliases = aliases[def.name];
    },
    afterConfigureGraph() {
        for (const node of crossroadsNodes(CrossroadsSplit)) node.update();
        for (const node of crossroadsNodes(CrossroadsJoin)) node.sync();
    },
    setup() {
        const api = window.comfyAPI.api.api;
        const queuePrompt = api.queuePrompt;
        api.queuePrompt = async function (number, prompt, options, ...args) {
            const missing = missingByWorkflow.get(prompt?.workflow)?.filter((input) => needed(prompt.output, options?.partialExecutionTargets).has(input.id));
            if (missing?.length) {
                // ComfyUI's notice for these errors has fixed wording, so the path that left them empty is shown here,
                // one line per cause.
                const causes = Map.groupBy(missing, (input) => input.cause);
                const detail = [...causes].map(([cause, inputs]) => `${cause}, and ${inputs.map((input) => `${input.node} (${input.name})`).join(", ")} ${inputs.length > 1 ? "need it" : "needs it"}.`);
                app.extensionManager.toast.add({ severity: "error", summary: "Crossroads", detail: detail.join("\n"), life: 10000 });
                throw validationError(missing);
            }
            return queuePrompt.call(this, number, prompt, options, ...args);
        };
        addPromptStep(CROSSROADS, {
            compile(result) {
                if (!Object.values(result.output).some((node) => node.class_type === SPLIT || node.class_type === JOIN)) return result;
                const isRequired = (type, name) => name in (nodeDef(type)?.input?.required ?? {});
                try {
                    return { ...result, output: compileCrossroads(result.output, result.workflow, isRequired) };
                } catch (error) {
                    if (!(error instanceof MissingInputsError)) throw error;
                    missingByWorkflow.set(result.workflow, error.missing);
                    return { ...result, output: error.output };
                }
            },
        });
    },
});
