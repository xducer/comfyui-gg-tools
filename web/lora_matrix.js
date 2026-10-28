import { app } from "../../../scripts/app.js";
import { LORA_MATRIX, compileMatrices, parseStrength } from "./lora_matrix_compile.js";
import { collectNodes } from "./workflow_nodes.js";
import { addPromptStep, LORA_STACK } from "./prompt_steps.js";

let loras = [];
let lastTap = null;
const titleMeasure = document.createElement("canvas").getContext("2d");
// Room along the bottom edge for the group sockets.
const SOCKET_STRIP = 18;
const FRAME_HINT = "drag onto another group to swap their model/clip wires";
// One plate size for every group; group columns are at least this wide (plus their 2 px cell padding).
const PAD_WIDTH = 88;

// Each press already acts; a second press on the same target within 400 ms makes it a double press.
function doublePress(target) {
    const now = performance.now();
    const double = lastTap?.target === target && now - lastTap.time < 400;
    lastTap = double ? null : { target, time: now };
    return double;
}

const loraName = (path) => path.split(/[\\/]/).at(-1).replace(/\.safetensors$/, "");

function loraChoices(def) {
    const spec = def?.input?.required?.lora_name;
    return (Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options) || [];
}

const style = document.createElement("style");
style.textContent = `
.ggtools-lora-matrix { border-collapse: collapse; font: 12px sans-serif; color: var(--input-text); width: 100%; }
.ggtools-lora-matrix td, .ggtools-lora-matrix th { padding: 2px; }
.ggtools-lora-matrix .lora, .ggtools-lora-matrix .group, .ggtools-lora-matrix input { width: 100%; box-sizing: border-box; background: var(--comfy-input-bg); color: var(--input-text); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 4px; font: inherit; }
.ggtools-lora-matrix th input { text-align: center; font-weight: bold; }
.ggtools-lora-matrix th.group-col { min-width: ${PAD_WIDTH + 4}px; }
.ggtools-lora-matrix .group { text-align: center; font-weight: bold; cursor: pointer; user-select: none; white-space: nowrap; }
.ggtools-lora-matrix .wired { display: inline-block; box-sizing: border-box; width: 7px; height: 7px; border-radius: 50%; margin-left: 4px; vertical-align: middle; }
.ggtools-lora-matrix .lora { max-width: 280px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ggtools-lora-matrix .cell { display: flex; min-width: 48px; height: 20px; line-height: 20px; text-align: center; border-radius: 4px; cursor: ew-resize; user-select: none; touch-action: none; border: 1px solid var(--border-color); background: var(--comfy-input-bg); }
.ggtools-lora-matrix .cell.off { opacity: 0.35; text-decoration: line-through; }
.ggtools-lora-matrix .part { flex: 1; }
.ggtools-lora-matrix .part.clip { border-left: 1px solid var(--border-color); }
.ggtools-lora-matrix .part.same { opacity: 0.45; }
.ggtools-lora-matrix .sub { font-weight: normal; font-size: 10px; color: var(--descrip-text); display: flex; }
.ggtools-lora-matrix .sub span { flex: 1; }
.ggtools-lora-matrix .footer { display: flex; gap: 12px; }
.ggtools-lora-matrix .remove { visibility: hidden; }
.ggtools-lora-matrix th:hover .remove, .ggtools-lora-matrix tr:hover > td > .remove { visibility: visible; }
.ggtools-lora-matrix .remove:hover { color: var(--error-text, #ff6b6b); }
.ggtools-lora-matrix .undo { color: var(--descrip-text); }
.ggtools-lora-matrix td.bypassed, .ggtools-lora-matrix th.bypassed .group, .ggtools-lora-matrix tr.muted > td { opacity: 0.35; }
.ggtools-lora-matrix tr.muted .lora { text-decoration: line-through; }
.ggtools-lora-matrix .name { display: flex; align-items: center; }
.ggtools-lora-matrix .grip { cursor: grab; user-select: none; touch-action: none; color: var(--descrip-text); padding: 0 4px 0 0; }
.ggtools-lora-matrix tr.dragging > td { opacity: 0.4; }
.ggtools-lora-matrix tr.drop-above > td { box-shadow: inset 0 2px 0 var(--input-text); }
.ggtools-lora-matrix tr.drop-below > td { box-shadow: inset 0 -2px 0 var(--input-text); }
.ggtools-lora-matrix th.bypassed .group { text-decoration: line-through; }
.ggtools-lora-matrix button { background: none; border: none; color: var(--descrip-text); cursor: pointer; font: inherit; padding: 0 4px; }
.ggtools-lora-matrix button:hover, .ggtools-lora-matrix button.on { color: var(--input-text); }
`;
document.head.append(style);

function element(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

// Help is drawn on the node instead of in title attributes: titles give a native tooltip, and other installed
// extensions copy them into tooltips of their own, so the same text appeared twice.
function hinted(node, hint) {
    node.dataset.hint = hint;
    return node;
}

// Two decimals unless the value needs more: 1 -> "1.00", 0.125 -> "0.125".
const format = (n) => (Math.round(n * 100) === n * 100 ? n.toFixed(2) : String(n));
const show = (text) => (text === "" ? "–" : Number.isFinite(Number(text)) ? format(Number(text)) : text);

// A cell's value is "0.80", or "0.80/0.50" when the clip strength differs.
function strengths(cell) {
    const [model = "", clip] = cell.value.split("/").map((part) => part.trim());
    return { model, clip };
}

function setStrengths(cell, model, clip) {
    const differs = clip !== undefined && Number(clip) !== Number(model);
    cell.value = differs ? `${format(Number(model))}/${format(Number(clip))}` : format(Number(model));
}

class LoraMatrix extends LGraphNode {
    static title = LORA_MATRIX;
    static description = "Several LoRA stacks side by side from one LoRA list: each group gets its own model and clip outputs, for comparing LoRA combinations.";

    constructor() {
        super(LORA_MATRIX);
        this.comfyClass = LORA_MATRIX;
        this.isVirtualNode = false;
        this.properties = { matrix: { columns: [{ key: "c0", name: "Group A" }, { key: "c1", name: "Group B" }], rows: [], next: 2 } };
        this.addInput("model", "MODEL");
        this.addInput("clip", "CLIP");
        this.table = element("table", { className: "ggtools-lora-matrix" });
        this.table.onpointerover = (event) => this.showHint(event.target.closest?.("[data-hint]")?.dataset.hint ?? "");
        this.table.onpointerleave = () => this.showHint("");
        // The table is laid out a frame or more after it is shown (leaving compact view, expanding a collapsed
        // node), so fit the node and its sockets when its size changes instead of on the next interaction.
        this.observer = new ResizeObserver(() => this.fit());
        this.observer.observe(this.table);
        const widget = this.addDOMWidget("matrix", "lora_matrix", this.table, {
            serialize: false,
            // Exactly the table plus its margins: ComfyUI would hand a DOM widget the rest of the node, and the
            // socket strip below the table has to stay the node's, so presses on the socket frames reach onMouseDown.
            getMinHeight: () => this.widgetHeight(),
            getMaxHeight: () => this.widgetHeight(),
        });
        widget.serialize = false;
        // Outputs sit under their groups, so the table starts right below the two inputs.
        this.widgets_start_y = 2 * LiteGraph.NODE_SLOT_HEIGHT + 4;
        // Title-bar switch between the matrix and compact view, like the subgraph node's button.
        this.viewButton = this.addTitleButton({ name: "view", text: "", xOffset: -10, yOffset: 0, fontSize: 16 });
        this.update();
    }

    // Outputs are left alone while a workflow loads; afterConfigureGraph syncs them once links exist.
    onConfigure() { this.layout(); }

    onRemoved() { this.observer.disconnect(); }

    // A frame around each group's socket pair. The canvas handles presses on the sockets first (new and moved
    // wires), so a press on the frame beside them reaches onMouseDown and drags the group's wires instead.
    frameAt([x, y]) {
        if (this.compact || y < this.size[1] - SOCKET_STRIP || y > this.size[1]) return null;
        return this.frames?.find((frame) => Math.abs(x - frame.center) <= frame.width / 2)?.key ?? null;
    }

    drawFrames(ctx) {
        if (!this.frames?.length) return;
        const top = this.size[1] - SOCKET_STRIP + 1;
        const height = SOCKET_STRIP - 2;
        ctx.save();
        ctx.lineWidth = 1;
        // Plates like the strength boxes; the canvas draws the sockets after this, on top of them. A six-dot grip
        // at the left end marks them as draggable; hovered, dragged and target plates get a bright outline and a
        // lighter fill. Status shows as contrast, not colour, since users recolour nodes: a group with no wired
        // output fades, a bypassed one is muted. While dragging every plate is a drop target, so all show fully.
        const active = this.dragging ? [this.dragging.from, this.dragging.over] : [this.hovered];
        for (const frame of this.frames) {
            const left = frame.center - frame.width / 2;
            const lit = active.includes(frame.key);
            const bypassed = this.matrix.columns.find((column) => column.key === frame.key)?.bypass;
            ctx.globalAlpha = lit || this.dragging ? 1 : (this.groupWired(frame.key) ? 1 : 0.45) * (bypassed ? 0.7 : 1);
            ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
            ctx.strokeStyle = lit ? LiteGraph.WIDGET_TEXT_COLOR : LiteGraph.WIDGET_OUTLINE_COLOR;
            ctx.beginPath();
            ctx.roundRect(left, top, frame.width, height, 4);
            ctx.fill();
            if (lit) {
                ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
                ctx.fill();
            }
            ctx.stroke();
            ctx.fillStyle = ctx.strokeStyle;
            for (const [dx, dy] of [[7, 4], [11, 4], [7, 8], [11, 8], [7, 12], [11, 12]]) {
                ctx.beginPath();
                ctx.arc(left + dx, top + dy, 1, 0, 2 * Math.PI);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
        if (this.dragging?.moved) {
            const width = this.frames.find((frame) => frame.key === this.dragging.from).width;
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = LiteGraph.WIDGET_TEXT_COLOR;
            ctx.beginPath();
            ctx.roundRect(this.dragging.x - width / 2, top, width, height, 4);
            ctx.stroke();
        }
        ctx.restore();
    }

    onMouseDown(e, pos, canvas) {
        const from = this.frameAt(pos);
        if (!from) return false;
        const { pointer } = canvas;
        this.dragging = { from, x: pos[0], over: null, moved: false };
        pointer.onDragStart = () => { this.dragging.moved = true; };
        pointer.onDrag = (eMove) => {
            this.dragging.x = eMove.canvasX - this.pos[0];
            const over = this.frameAt([this.dragging.x, this.size[1] - SOCKET_STRIP / 2]);
            this.dragging.over = over !== from ? over : null;
            const target = this.matrix.columns.find((column) => column.key === this.dragging.over);
            this.showHint(!target ? "drop on another group's sockets" : this.groupWired(target.key) ? `swap wires with ${target.name}` : `move wires to ${target.name}`);
            this.setDirtyCanvas(true, false);
        };
        pointer.onDragEnd = () => { if (this.dragging.over) this.swapGroupWires(from, this.dragging.over); };
        pointer.finally = () => {
            this.dragging = null;
            this.showHint("");
            this.setDirtyCanvas(true, false);
        };
        return true;
    }

    onMouseMove(e, pos) {
        if (this.dragging) return;
        const hovered = this.frameAt(pos);
        if (hovered !== this.hovered) this.setDirtyCanvas(true, false);
        this.hovered = hovered;
        if (hovered) this.showHint(FRAME_HINT);
        else if (this.hint === FRAME_HINT) this.showHint("");
    }

    onMouseLeave() {
        if (this.dragging) return;
        if (this.hovered) this.setDirtyCanvas(true, false);
        this.hovered = null;
        if (this.hint === FRAME_HINT) this.showHint("");
    }

    groupWired(key) {
        return ["model", "clip"].some((kind) => {
            const slot = this.outputs.findIndex((output) => output.name === `${kind}:${key}`);
            return slot >= 0 && this.isOutputConnected(slot);
        });
    }

    // Model wires trade places with model wires and clip with clip; with nothing on one side, they just move.
    exchangeWires(a, b) {
        const moves = [];
        for (const kind of ["model", "clip"]) {
            const from = this.outputs.findIndex((output) => output.name === `${kind}:${a}`);
            const to = this.outputs.findIndex((output) => output.name === `${kind}:${b}`);
            if (from < 0 || to < 0) continue;
            for (const link of this.outgoingLinks()) {
                if (link.origin_slot === from) moves.push([link, to]);
                else if (link.origin_slot === to) moves.push([link, from]);
            }
        }
        for (const [link, slot] of moves) link.origin_slot = slot;
        this.notifyTargets(moves.map(([link]) => link));
    }

    // Tell each receiving node, as reconnecting by hand would, so nodes that name or type their inputs from the
    // source (such as Pipe To) update now rather than on the next unrelated change.
    notifyTargets(links) {
        for (const link of links) {
            const target = this.graph?.getNodeById(link.target_id);
            target?.onConnectionsChange?.(LiteGraph.INPUT, link.target_slot, true, link, target.inputs?.[link.target_slot]);
        }
    }

    swapGroupWires(a, b) {
        const name = (key) => this.matrix.columns.find((column) => column.key === key).name;
        const label = this.groupWired(b) ? `Swapped wires of ${name(a)} and ${name(b)}` : `Moved wires from ${name(a)} to ${name(b)}`;
        this.exchangeWires(a, b);
        this.undo = { label, restore: () => this.exchangeWires(a, b) };
        this.update();
    }

    showHint(text) {
        if (this.hint === text) return;
        this.hint = text;
        this.setDirtyCanvas(true, false);
    }

    // The hovered element's help, word-wrapped into the free space right of the two inputs, above the table.
    drawHint(ctx) {
        if (!this.hint) return;
        const left = 80;
        const width = this.size[0] - left - 12;
        ctx.save();
        ctx.font = `${LiteGraph.NODE_SUBTEXT_SIZE}px sans-serif`;
        ctx.fillStyle = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const lines = [""];
        for (const word of this.hint.split(" ")) {
            const next = lines.at(-1) ? `${lines.at(-1)} ${word}` : word;
            if (lines.at(-1) && ctx.measureText(next).width > width) lines.push(word);
            else lines[lines.length - 1] = next;
        }
        lines.slice(0, 3).forEach((line, i) => ctx.fillText(line, left, 4 + i * 14));
        ctx.restore();
    }

    fit() {
        if (this.compact) return;
        this.measuredWidth = null;
        this.tableWidth();
        if (this.measuredWidth && this.size[0] < this.measuredWidth) this.setSize([this.measuredWidth, this.size[1]]);
        this.placeOutputs();
        this.graph?.setDirtyCanvas(true, true);
    }

    // Column positions follow the table's layout, which can change on any resize, so place the sockets each frame.
    // The table's width is only certain once it is laid out, so the node also widens here if it ended up narrower.
    onDrawForeground(ctx) {
        this.placeOutputs();
        if (this.compact) return;
        this.drawHint(ctx);
        this.drawFrames(ctx);
        this.tableWidth();
        if (this.measuredWidth && this.size[0] < this.measuredWidth) this.setSize([this.measuredWidth, this.size[1]]);
    }

    // The height follows the table, so resizing only changes the width.
    onResize(size) {
        const height = this.computeSize()[1];
        if (size[1] === height) return;
        // Dragging a top corner moves the top edge; keep the node where it was instead.
        const canvas = app.canvas;
        if (canvas?.resizing_node === this && canvas.pointer?.resizeDirection?.includes("N")) this.pos = [this.pos[0], this.pos[1] + size[1] - height];
        this.size = [size[0], height];
    }

    onConnectionsChange(type, index) {
        if (type === LiteGraph.INPUT && this.inputs[index]?.name === "clip") this.syncOutputs();
        // The group headers show which outputs are wired, and whether their input is connected.
        this.render();
    }

    get matrix() { return this.properties.matrix; }

    widgetHeight() {
        if (this.compact) return 0;
        const { rows, showClip } = this.properties.matrix;
        return (rows.length + (showClip ? 3 : 2)) * 28 + 8 + 2 * (this.widgets?.[0]?.margin ?? 10);
    }

    // The view is kept apart from the LoRA settings: "compact" shows a normal node with the outputs listed on the right.
    get compact() { return this.properties.view === "compact"; }

    setView(view) {
        this.properties.view = view;
        this.layout();
        // A compact node shrinks to its list; an expanded one takes its table's width once that is measured.
        if (this.compact) this.setSize(this.computeSize());
        else if (this.measuredWidth) this.setSize([this.measuredWidth, this.size[1]]);
        this.placeOutputs();
    }

    onTitleButtonClick(button, canvas) {
        if (button.name === "view") this.setView(this.compact ? undefined : "compact");
        else super.onTitleButtonClick(button, canvas);
    }

    // The canvas puts the returned items at the top of the node's menu.
    getExtraMenuOptions() {
        return [
            { content: this.compact ? "Expanded view" : "Compact view", callback: () => this.setView(this.compact ? undefined : "compact") },
            {
                content: "Bypass groups", has_submenu: true,
                submenu: { options: this.matrix.columns.map((column) => ({
                    content: `${column.bypass ? "☐" : "☑"} ${column.name}`,
                    callback: () => { column.bypass = !column.bypass; this.update(); },
                })) },
            },
        ];
    }

    newKey() { return `c${this.matrix.next++}`; }

    // A new group copies the cells of `source`, or starts every LoRA on at 1.00 when there is none.
    addGroup(name, source, index) {
        const column = { key: this.newKey(), name };
        for (const row of this.matrix.rows) row.cells[column.key] = { ...(source ? row.cells[source.key] ?? { value: "", on: false } : { value: "1.00", on: true }) };
        this.matrix.columns.splice(index, 0, column);
        return column;
    }

    // The frontend files links under their origin slot number (output.links is a deprecated view of that).
    outgoingLinks() {
        return [...(this.graph?.links?.values() ?? [])].filter((link) => link.origin_id === this.id);
    }

    // Each group gives a model output, and a clip output while a clip is connected, kept together per group.
    syncOutputs() {
        const clip = this.inputs.find((input) => input.name === "clip")?.link != null;
        const { columns } = this.matrix;
        const wanted = columns.flatMap((column) => [
            { name: `model:${column.key}`, type: "MODEL", label: `${column.name} [model]` },
            ...(clip ? [{ name: `clip:${column.key}`, type: "CLIP", label: `${column.name} [clip]` }] : []),
        ]);
        const keys = columns.map((column) => column.key);
        for (let i = this.outputs.length - 1; i >= 0; i--) {
            const output = this.outputs[i];
            const [kind, key] = output.name.split(":");
            const keep = wanted.some((w) => w.name === output.name) || (kind === "clip" && keys.includes(key) && this.isOutputConnected(i));
            if (!keep) this.removeOutput(i);
        }
        const relabeled = new Set();
        for (const w of wanted) {
            const output = this.outputs.find((output) => output.name === w.name) || this.addOutput(w.name, w.type);
            if (output.label !== w.label) relabeled.add(output);
            output.label = w.label;
        }
        const rank = (output) => {
            const [kind, key] = output.name.split(":");
            return keys.indexOf(key) * 2 + (kind === "clip" ? 1 : 0);
        };
        const before = [...this.outputs];
        const sorted = [...before].sort((a, b) => rank(a) - rank(b));
        if (sorted.some((output, i) => output !== before[i])) {
            // Read each link's output before moving the slots, then file the link under that output's new slot.
            const moves = this.outgoingLinks().map((link) => [link, sorted.indexOf(before[link.origin_slot])]);
            this.outputs.splice(0, this.outputs.length, ...sorted);
            for (const [link, slot] of moves) link.origin_slot = slot;
        }
        // A renamed group renames its outputs; nodes naming their inputs after them (Pipe To) need to know.
        if (relabeled.size) this.notifyTargets(this.outgoingLinks().filter((link) => relabeled.has(this.outputs[link.origin_slot])));
    }

    update() {
        this.syncOutputs();
        this.layout();
    }

    layout() {
        this.table.style.display = this.compact ? "none" : "";
        // PrimeIcons pi-window-maximize / pi-window-minimize.
        this.viewButton.text = this.compact ? "\uE93B" : "\uE93A";
        this.render();
        const [width, height] = this.computeSize();
        // Expanded, only a real measurement widens the node, so a saved width survives loading; fit() widens it
        // once the table has been measured. Compact has no table, so its width (the title) is always known.
        this.setSize([Math.max(this.size[0], this.compact ? width : this.measuredWidth ?? 0), height]);
        this.placeOutputs();
        this.graph?.setDirtyCanvas(true, true);
    }

    // The canvas clamps resizing to computeSize. A DOM widget only reports its height there, and the
    // default height reserves a row per output, which sit on the bottom edge here instead.
    computeSize(out) {
        const size = super.computeSize(out);
        // The default width fits the title but not the title-bar button beside it (about 40 px with its gap).
        titleMeasure.font = this.titleFontStyle;
        size[0] = Math.max(size[0], LiteGraph.NODE_TITLE_HEIGHT + titleMeasure.measureText(this.title).width + 40);
        const widget = this.widgets?.[0];
        if (!widget || this.compact) return size;
        size[0] = Math.max(size[0], this.tableWidth());
        size[1] = this.widgets_start_y + this.widgetHeight() + SOCKET_STRIP;
        return size;
    }

    // Expanded: each group's model and clip sockets sit on the bottom edge under its column, with wires leaving
    // downwards, and no drawn label as the column names the group. Compact: the normal list on the right.
    // The labels themselves stay for Pipe To and saving; only what is drawn changes.
    placeOutputs() {
        for (const output of this.outputs) {
            if (!Object.hasOwn(output, "renderingLabel")) Object.defineProperty(output, "renderingLabel", { get: () => this.drawnLabel(output), configurable: true });
        }
        if (this.compact) {
            let moved = false;
            for (const output of this.outputs) {
                if (output.pos) moved = true;
                output.pos = undefined;
                output.dir = undefined;
            }
            if (moved) this.graph?.setDirtyCanvas(true, true);
            return;
        }
        // A collapsed or hidden table measures 0; keep the sockets where they were until it is laid out again.
        if (this.flags?.collapsed || this.groupHeaders?.some((header) => header.isConnected && !header.offsetWidth)) return;
        const margin = this.widgets?.[0]?.margin ?? 10;
        const y = this.size[1] - SOCKET_STRIP / 2;
        let moved = false;
        this.frames = [];
        this.matrix.columns.forEach((column, i) => {
            const header = this.groupHeaders?.[i];
            const center = header?.isConnected ? margin + header.offsetLeft + header.offsetWidth / 2 : 220 + i * 80 + 40;
            this.frames.push({ key: column.key, center, width: PAD_WIDTH });
            const model = this.outputs.find((output) => output.name === `model:${column.key}`);
            const clip = this.outputs.find((output) => output.name === `clip:${column.key}`);
            for (const [output, x] of [[model, clip ? center - 10 : center], [clip, center + 10]]) {
                if (!output) continue;
                if (output.pos?.[0] !== x || output.pos?.[1] !== y) {
                    output.pos = [x, y];
                    moved = true;
                }
                output.dir = LiteGraph.DOWN;
            }
        });
        if (moved) this.graph?.setDirtyCanvas(true, true);
    }

    drawnLabel(output) {
        if (!this.compact) return "";
        const key = output.name.split(":")[1];
        return this.matrix.columns.find((column) => column.key === key)?.bypass ? `${output.label} (bypassed)` : output.label;
    }

    // Measured once per render. A table that isn't laid out (not on the page yet, or hidden while zoomed out)
    // measures 0 and reports no width: ComfyUI widens every node to computeSize after loading a workflow, so
    // any estimate would undo a saved width. fit() widens the node once the table can be measured.
    tableWidth() {
        const { table } = this;
        if (this.measuredWidth == null && table?.isConnected) {
            const width = table.style.width;
            table.style.width = "min-content";
            const needed = table.offsetWidth;
            table.style.width = width;
            if (needed) this.measuredWidth = needed + 2 * (this.widgets[0].margin ?? 10);
        }
        return this.measuredWidth ?? 0;
    }

    cell(row, column, showClip, change) {
        const cell = (row.cells[column.key] ??= { value: "", on: false });
        const parts = showClip ? [element("span", { className: "part model" }), element("span")] : [element("span", { className: "part" })];
        const view = hinted(element("div", {}, ...parts), "click: on/off · drag left/right: adjust · double-click: type a value");
        const fill = () => {
            const { model, clip } = strengths(cell);
            view.className = `cell${cell.on && cell.value ? "" : " off"}`;
            if (showClip) {
                parts[0].textContent = show(model);
                parts[1].textContent = show(clip ?? model);
                parts[1].className = `part clip${clip === undefined ? " same" : ""}`;
            } else parts[0].textContent = cell.value ? (clip === undefined ? show(model) : `${show(model)}/${show(clip)}`) : "–";
        };
        fill();
        const toggle = () => {
            cell.on = !cell.on;
            if (cell.on && !cell.value) cell.value = "1.00";
            fill();
            this.graph?.setDirtyCanvas(true, true);
        };
        const edit = (part) => {
            const { model, clip } = strengths(cell);
            const input = element("input", { value: part === "clip" ? show(clip ?? model) : part === "model" ? show(model) : cell.value });
            let done = false;
            const commit = (save) => {
                if (done) return;
                done = true;
                const text = input.value.trim();
                const number = Number(text);
                if (save && part === "clip" && model && (!text || Number.isFinite(number))) setStrengths(cell, model, text ? number : undefined);
                else if (save && part === "model" && text && Number.isFinite(number)) {
                    setStrengths(cell, number, clip);
                    cell.on = true;
                } else if (save && part === "value" && parseStrength(text)) {
                    const typed = parseStrength(text);
                    setStrengths(cell, typed.model, text.includes("/") ? typed.clip : undefined);
                    cell.on = true;
                } else if (save && !text && part !== "clip") {
                    cell.value = "";
                    cell.on = false;
                }
                change();
            };
            input.onkeydown = (event) => {
                if (event.key === "Enter") commit(true);
                if (event.key === "Escape") commit(false);
            };
            input.onblur = () => commit(true);
            view.replaceWith(input);
            input.focus?.();
            input.select();
        };

        // Press and release toggles, two quick presses edit, and dragging sets the strength of the half under the pointer.
        let drag = null;
        view.onpointerdown = (event) => {
            if (event.button) return;
            event.stopPropagation();
            const part = !showClip ? "value" : event.target?.className?.includes("clip") ? "clip" : "model";
            const { model, clip } = strengths(cell);
            drag = { x: event.clientX, part, model, clip, start: Number(part === "clip" ? clip ?? model : model), moved: false };
            view.setPointerCapture?.(event.pointerId);
        };
        view.onpointermove = (event) => {
            if (!drag || !drag.model) return;
            const dx = event.clientX - drag.x;
            if (!drag.moved && Math.abs(dx) < 4) return;
            drag.moved = true;
            const value = Math.round((drag.start + dx / 200) * 100) / 100;
            if (drag.part === "clip") setStrengths(cell, drag.model, value);
            else setStrengths(cell, value, drag.clip);
            fill();
        };
        view.onpointerup = () => {
            if (!drag) return;
            const { moved, part } = drag;
            drag = null;
            if (moved) {
                this.graph?.setDirtyCanvas(true, true);
                return;
            }
            const double = doublePress(`cell:${row.key}:${column.key}`);
            toggle();
            if (double) edit(part);
        };
        view.onpointercancel = () => { drag = null; };
        return view;
    }

    // Rows are applied top to bottom, so their order is each group's loading order. The grip drags a row to a
    // new position; a line marks where it lands.
    rowGrip(row, change) {
        const grip = hinted(element("span", { className: "grip", textContent: "⠿" }), "drag up or down to reorder the LoRAs");
        const mark = (tr, cls) => { tr.className = tr.className.replace(/ ?(dragging|drop-above|drop-below)/g, "") + (cls ? ` ${cls}` : ""); };
        let drag = null;
        grip.onpointerdown = (event) => {
            if (event.button) return;
            event.stopPropagation();
            grip.setPointerCapture?.(event.pointerId);
            drag = { from: this.matrix.rows.indexOf(row), to: null };
            mark(this.rowElements[drag.from], "dragging");
        };
        grip.onpointermove = (event) => {
            if (!drag) return;
            // The insertion point is before the first row whose middle is below the pointer.
            const middles = this.rowElements.map((tr) => { const box = tr.getBoundingClientRect(); return box.top + box.height / 2; });
            const before = middles.filter((middle) => middle < event.clientY).length;
            drag.to = before > drag.from ? before - 1 : before;
            this.rowElements.forEach((tr, i) => mark(tr, i === drag.from ? "dragging" : ""));
            if (drag.to !== drag.from) mark(this.rowElements[Math.min(before, this.rowElements.length - 1)], before < this.rowElements.length ? "drop-above" : "drop-below");
        };
        const end = (move) => {
            if (!drag) return;
            const { from, to } = drag;
            drag = null;
            this.rowElements.forEach((tr) => mark(tr, ""));
            if (!move || to == null || to === from) return;
            this.matrix.rows.splice(to, 0, ...this.matrix.rows.splice(from, 1));
            change();
        };
        grip.onpointerup = () => end(true);
        grip.onpointercancel = () => end(false);
        return grip;
    }

    render() {
        const { columns, rows } = this.matrix;
        // Any edit ends the chance to undo the last removal.
        const change = () => {
            this.undo = null;
            this.update();
        };
        let focus = null;
        const header = element("tr", {}, element("th", { textContent: "LoRA" }));
        this.groupHeaders = [];
        this.rowElements = [];
        this.measuredWidth = null;
        for (const column of columns) {
            let name;
            if (this.renaming === column.key) {
                name = element("input", { value: column.name });
                let done = false;
                const commit = (save) => {
                    if (done) return;
                    done = true;
                    this.renaming = null;
                    if (save) column.name = name.value.trim() || column.name;
                    change();
                };
                name.onkeydown = (event) => {
                    if (event.key === "Enter") commit(true);
                    if (event.key === "Escape") commit(false);
                };
                name.onblur = () => commit(true);
                focus = name;
            } else {
                // A dot in the socket colour for each of the group's outputs that is wired: filled while its
                // input is connected, a ring like an unconnected socket while it isn't.
                const wired = ["model", "clip"].flatMap((kind) => {
                    const slot = this.outputs.findIndex((output) => output.name === `${kind}:${column.key}`);
                    if (slot < 0 || !this.isOutputConnected(slot)) return [];
                    const color = LGraphCanvas.link_type_colors?.[this.outputs[slot].type] ?? "#888";
                    const fed = this.inputs.find((input) => input.name === kind)?.link != null;
                    return [hinted(element("span", { className: "wired", style: fed ? `background: ${color}` : `border: 1.5px solid ${color}` }),
                        fed ? `${kind} output connected` : `${kind} output connected, but the ${kind} input isn't`)];
                });
                name = hinted(element("div", { className: "group" }, column.name, ...wired), "click: bypass (passes model and clip through without this group's LoRAs) · double-click: rename · right-click: more");
                name.onpointerdown = (event) => { if (!event.button) event.stopPropagation(); };
                // A redraw sits between the two presses, so the double press is matched on the group, not the element.
                name.onpointerup = (event) => {
                    if (event.button) return;
                    column.bypass = !column.bypass;
                    if (doublePress(`group:${column.key}`)) this.renaming = column.key;
                    this.update();
                };
                name.oncontextmenu = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const bypassLabel = column.bypass ? "Turn group on" : "Bypass group";
                    new LiteGraph.ContextMenu(["Rename group", bypassLabel, "Duplicate group", null, "Remove group"], {
                        event,
                        callback: (choice) => {
                            if (choice === "Rename group") {
                                this.renaming = column.key;
                                this.update();
                            } else if (choice === bypassLabel) {
                                column.bypass = !column.bypass;
                                this.update();
                            } else if (choice === "Duplicate group") {
                                const used = new Set(columns.map((c) => c.name));
                                let copyName = `${column.name} Copy`;
                                for (let n = 2; used.has(copyName); n++) copyName = `${column.name} Copy ${n}`;
                                const copy = this.addGroup(copyName, column, columns.indexOf(column) + 1);
                                Object.assign(copy, { ...column, key: copy.key, name: copy.name });
                                change();
                            } else if (choice === "Remove group") remove.onclick();
                        },
                    });
                };
            }
            const remove = hinted(element("button", { className: "remove", textContent: "×" }), "remove group");
            remove.onclick = () => {
                const index = columns.indexOf(column);
                const cells = Object.fromEntries(rows.map((row) => [row.key, row.cells[column.key]]));
                const links = this.outgoingLinks().map((link) => ({ name: this.outputs[link.origin_slot]?.name, target: link.target_id, slot: link.target_slot }))
                    .filter((link) => link.name?.endsWith(`:${column.key}`));
                this.matrix.columns = columns.filter((c) => c !== column);
                for (const row of rows) delete row.cells[column.key];
                this.undo = {
                    label: `Removed ${column.name}`,
                    restore: () => {
                        this.matrix.columns.splice(Math.min(index, this.matrix.columns.length), 0, column);
                        for (const row of this.matrix.rows) if (cells[row.key]) row.cells[column.key] = cells[row.key];
                        this.syncOutputs();
                        for (const { name, target, slot } of links) {
                            const node = this.graph?.getNodeById(target);
                            const output = this.outputs.findIndex((output) => output.name === name);
                            if (node && output >= 0) this.connect(output, node, slot);
                        }
                    },
                };
                this.update();
            };
            const th = element("th", { className: `group-col${column.bypass ? " bypassed" : ""}` }, element("div", { style: "display:flex" }, name, remove));
            this.groupHeaders.push(th);
            header.append(th);
        }
        const addColumn = hinted(element("button", { textContent: "+" }), "add group (copies the last one)");
        addColumn.onclick = () => {
            const used = new Set(columns.map((c) => c.name));
            const name = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `Group ${letter}`).find((name) => !used.has(name)) || `Group ${columns.length + 1}`;
            this.addGroup(name, columns.at(-1), columns.length);
            change();
        };
        header.append(element("th", {}, addColumn));
        const body = [header];
        const showClip = !!this.matrix.showClip;
        if (showClip) {
            const sub = element("tr", {}, element("th"));
            for (const _ of columns) sub.append(element("th", {}, element("div", { className: "sub" }, element("span", { textContent: "model" }), element("span", { textContent: "clip" }))));
            body.push(sub);
        }

        for (const row of rows) {
            const name = loraName(row.lora);
            const missing = row.lora && !loras.includes(row.lora);
            const lora = hinted(element("div", { className: "lora", textContent: row.lora ? `${name}${missing ? " (missing)" : ""}` : "— pick a LoRA —" }),
                row.lora ? `${row.lora} · click: mute in all groups · double-click: change · right-click: more` : "click: pick a LoRA");
            const pick = (event) => new LiteGraph.ContextMenu(loras, {
                event, className: "dark", scale: Math.max(1, app.canvas?.ds?.scale ?? 1),
                callback: (value) => { row.lora = value; change(); },
            });
            lora.onpointerdown = (event) => { if (!event.button) event.stopPropagation(); };
            // Like a group name: one press mutes the row in every group, a double press opens the picker.
            lora.onpointerup = (event) => {
                if (event.button) return;
                if (!row.lora) return pick(event);
                row.mute = !row.mute;
                const double = doublePress(`row:${row.key}`);
                this.update();
                if (double) pick(event);
            };
            lora.oncontextmenu = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const muteLabel = row.mute ? "Unmute LoRA" : "Mute LoRA";
                new LiteGraph.ContextMenu(["Change LoRA", muteLabel, null, "Remove LoRA"], {
                    event,
                    callback: (choice) => {
                        if (choice === "Change LoRA") pick(event);
                        else if (choice === muteLabel) {
                            row.mute = !row.mute;
                            this.update();
                        } else if (choice === "Remove LoRA") remove.onclick();
                    },
                });
            };
            const tr = element("tr", { className: row.mute ? "muted" : "" }, element("td", {}, element("div", { className: "name" }, this.rowGrip(row, change), lora)));
            this.rowElements.push(tr);
            for (const column of columns) tr.append(element("td", { className: column.bypass ? "bypassed" : "" }, this.cell(row, column, showClip, change)));
            const remove = hinted(element("button", { className: "remove", textContent: "×" }), "remove LoRA");
            remove.onclick = () => {
                const index = rows.indexOf(row);
                this.matrix.rows = rows.filter((r) => r !== row);
                this.undo = { label: `Removed ${loraName(row.lora) || "LoRA"}`, restore: () => this.matrix.rows.splice(Math.min(index, this.matrix.rows.length), 0, row) };
                this.update();
            };
            tr.append(element("td", {}, remove));
            body.push(tr);
        }

        const addRow = element("button", { textContent: "+ LoRA" });
        addRow.onclick = () => {
            rows.push({ key: this.newKey(), lora: "", cells: Object.fromEntries(columns.map((c) => [c.key, { value: "1.00", on: true }])) });
            change();
        };
        const clipToggle = element("button", { className: showClip ? "on" : "", textContent: `${showClip ? "☑" : "☐"} clip strengths` });
        clipToggle.onclick = () => { this.matrix.showClip = !showClip; change(); };
        const footer = element("div", { className: "footer" }, addRow, clipToggle);
        if (this.undo) {
            const undo = element("button", { textContent: "Undo" });
            undo.onclick = () => {
                const { restore } = this.undo;
                this.undo = null;
                restore();
                this.update();
            };
            footer.append(element("span", { className: "undo" }, `${this.undo.label} ·`, undo));
        }
        body.push(element("tr", {}, element("td", { colSpan: columns.length + 2 }, footer)));
        this.table.replaceChildren(...body);
        focus?.focus();
        focus?.select();
    }
}

function matrixNodes() {
    const root = app.rootGraph || app.graph;
    return [root, ...(root?.subgraphs?.values?.() ?? [])].flatMap((graph) => graph?.nodes ?? []).filter((node) => node instanceof LoraMatrix);
}

app.registerExtension({
    name: "ggtools.lora_matrix",
    beforeRegisterNodeDef(_, def) {
        if (def.name === "LoraLoaderModelOnly") loras = loraChoices(def);
    },
    registerCustomNodes() {
        LiteGraph.registerNodeType(LORA_MATRIX, LoraMatrix);
        LoraMatrix.category = "ggtools";
    },
    // The frontend builds a bare definition for frontend-only nodes; add the terms people search for.
    beforeRegisterVueAppNodeDefs(defs) {
        const def = defs.find((def) => def.name === LORA_MATRIX);
        if (def) def.search_aliases = ["LoRA Loader", "Multi LoRA", "LoRA Stack", "LoRA Mixer", "LoRA Matrix", "LoRA Branch", "LoRA Compare"];
    },
    refreshComboInNodes(defs) {
        loras = loraChoices(defs.LoraLoaderModelOnly);
        for (const node of matrixNodes()) node.render();
    },
    afterConfigureGraph() {
        for (const node of matrixNodes()) node.update();
    },
    setup() {
        addPromptStep(LORA_STACK, {
            compile(result) {
                const matrices = collectNodes(result.workflow, LORA_MATRIX);
                return matrices.size ? { ...result, output: compileMatrices(result.output, matrices) } : result;
            },
        });
    },
});
