import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { RANDOM_PROMPT, MAX_SEED, compileRandomPrompts, joinedText, pickLines, roll } from "./random_prompt_compile.js";
import { collectNodes } from "./workflow_nodes.js";
import { addPromptStep, RANDOM } from "./prompt_steps.js";

// Lists are text files in the user's ComfyUI folder (user/default/ggtools/lists), each line one entry, read through
// ComfyUI's own user-data routes.
const LIST_DIR = "ggtools/lists";
const LIST_HINT = "user/default/ggtools/lists";
// File -> time it was changed; null until the folder has been read once.
let files = null;
const lists = new Map();
const linesOf = (file) => lists.get(file)?.lines;

async function findLists() {
    const response = await api.fetchApi(`/userdata?dir=${encodeURIComponent(LIST_DIR)}&recurse=true&full_info=true`);
    const found = response.ok ? await response.json() : [];
    files = new Map(found.filter((file) => /\.(txt|md)$/i.test(file.path)).map((file) => [file.path, file.modified]).sort());
}

// Reads the wanted lists that are new or were edited since they were last read.
async function loadLists(wanted) {
    await findLists();
    await Promise.all([...new Set(wanted)].filter((file) => files.has(file) && lists.get(file)?.modified !== files.get(file)).map(async (file) => {
        const response = await api.fetchApi(`/userdata/${encodeURIComponent(`${LIST_DIR}/${file}`)}`);
        if (!response.ok) return;
        const lines = (await response.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        lists.set(file, { modified: files.get(file), lines });
    }));
    for (const file of lists.keys()) if (!files.has(file)) lists.delete(file);
}

const newSeed = () => Math.floor(Math.random() * MAX_SEED);
const SEPARATORS = [[". ", "period"], [", ", "comma"], [" ", "space"], ["\n", "new line"]];

const ROW = 28;
const PREVIEW = 60;
const FOOTER = 24;
const HINT = 18;

let lastTap = null;
// Each press already acts; a second press on the same target within 400 ms makes it a double press.
function doublePress(target) {
    const now = performance.now();
    const double = lastTap?.target === target && now - lastTap.time < 400;
    lastTap = double ? null : { target, time: now };
    return double;
}

const style = document.createElement("style");
style.textContent = `
.ggtools-random { font: 12px sans-serif; color: var(--input-text); }
.ggtools-random .row { display: grid; grid-template-columns: 110px minmax(0, 1fr) 20px 20px 16px; gap: 4px; align-items: center; height: ${ROW - 4}px; margin: 0 14px 4px 0; }
.ggtools-random .name, .ggtools-random .text, .ggtools-random .preview, .ggtools-random input { box-sizing: border-box; background: var(--comfy-input-bg); color: var(--input-text); border: 1px solid var(--border-color); border-radius: 4px; padding: 2px 4px; font: inherit; }
.ggtools-random .name, .ggtools-random .text, .ggtools-random input { width: 100%; height: ${ROW - 4}px; line-height: ${ROW - 10}px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ggtools-random .name { font-weight: bold; cursor: pointer; user-select: none; }
.ggtools-random .seed { display: flex; padding: 2px 0; }
.ggtools-random .seed .number { flex: 1; text-align: center; cursor: ew-resize; user-select: none; touch-action: none; overflow: hidden; text-overflow: ellipsis; }
.ggtools-random .seed .step { padding: 0 6px; cursor: pointer; user-select: none; color: var(--descrip-text); font-size: 10px; }
.ggtools-random .seed .step:hover { color: var(--input-text); }
.ggtools-random .label { color: var(--descrip-text); padding: 0 5px; }
.ggtools-random .row.off .name { text-decoration: line-through; }
.ggtools-random .row.off .name, .ggtools-random .row.off .text { opacity: 0.35; }
.ggtools-random .row.frozen .text { border-color: var(--input-text); }
.ggtools-random .preview { margin: 0 14px 4px 0; overflow-y: auto; white-space: pre-wrap; color: var(--descrip-text); }
.ggtools-random .footer { display: flex; gap: 12px; height: ${FOOTER}px; align-items: center; }
.ggtools-random .hint { height: ${HINT}px; line-height: ${HINT}px; color: var(--descrip-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ggtools-random button { background: none; border: none; color: var(--descrip-text); cursor: pointer; font: inherit; padding: 0; }
.ggtools-random button:hover, .ggtools-random button.on { color: var(--input-text); }
.ggtools-random .row button { opacity: 0.45; }
.ggtools-random .row button:hover, .ggtools-random .row button.on { opacity: 1; }
.ggtools-random .remove { visibility: hidden; }
.ggtools-random .row:hover .remove { visibility: visible; }
.ggtools-random .remove:hover { color: var(--error-text, #ff6b6b); }
`;
document.head.append(style);

function element(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

// Help shows in the node's own hint line: title attributes give a native tooltip that other extensions copy.
function hinted(node, hint) {
    node.dataset.hint = hint;
    return node;
}

function editor(value, commit) {
    const input = element("input", { value });
    let done = false;
    const end = (save) => {
        if (done) return;
        done = true;
        commit(save ? input.value.trim() : null);
    };
    input.onkeydown = (event) => {
        if (event.key === "Enter") end(true);
        if (event.key === "Escape") end(false);
    };
    input.onblur = () => end(true);
    return input;
}

class RandomPrompt extends LGraphNode {
    static title = RANDOM_PROMPT;
    static description = "A random seed and a random line from each of your text lists, joined into one prompt. Freeze a list, the seed or everything to keep using what the last run used.";

    constructor() {
        super(RANDOM_PROMPT);
        this.comfyClass = RANDOM_PROMPT;
        this.isVirtualNode = false;
        this.properties = { random: { rows: [], seed: newSeed(), seedFrozen: false, separator: ". ", next: 0 } };
        this.addInput("clip", "CLIP");
        this.addInput("text", "STRING");
        this.addOutput("text", "STRING");
        this.addOutput("seed", "INT");
        this.panel = element("div", { className: "ggtools-random" });
        this.panel.onpointerover = (event) => this.showHint(event.target.closest?.("[data-hint]")?.dataset.hint ?? "");
        this.panel.onpointerleave = () => this.showHint("");
        const widget = this.addDOMWidget("random", "random_prompt", this.panel, {
            serialize: false,
            getMinHeight: () => this.widgetHeight(),
            getMaxHeight: () => this.widgetHeight(),
        });
        widget.serialize = false;
        // The output sockets sit at the end of their rows, so the panel starts right below the two inputs.
        this.widgets_start_y = 2 * LiteGraph.NODE_SLOT_HEIGHT + 4;
        this.size = [460, 0];
        this.update();
    }

    // Outputs are left alone while a workflow loads or a paste restores its wires; afterConfigureGraph and
    // onConnectionsChange sync them once the links exist (as in the LoRA Multi-Stack).
    configure(info) {
        this.configuring = true;
        try { super.configure(info); } finally { this.configuring = false; }
    }

    onConfigure() { this.layout(); }

    onConnectionsChange(type, index) {
        if (this.configuring) return;
        if (type === LiteGraph.INPUT) this.update();
    }

    linked(name) { return this.inputs.find((input) => input.name === name)?.link != null; }

    get state() { return this.properties.random; }

    // The rows have fixed heights; a taller node gives the extra height to the preview.
    get previewHeight() { return this.properties.previewHeight ?? PREVIEW; }

    widgetHeight(preview = this.previewHeight) {
        return (this.state.rows.length + 1) * ROW + preview + FOOTER + HINT + 2 * (this.widgets?.[0]?.margin ?? 10);
    }

    // The smallest size; the canvas clamps resizing to it.
    computeSize(out) {
        const size = super.computeSize(out);
        size[0] = Math.max(size[0], 380);
        size[1] = this.widgets_start_y + this.widgetHeight(PREVIEW);
        return size;
    }

    onResize(size) {
        // Adding the first outputs sizes the node before its panel exists.
        if (!this.widgets?.length) return;
        const preview = Math.max(PREVIEW, Math.round(size[1] - this.widgets_start_y - this.widgetHeight(0)));
        size[1] = this.widgets_start_y + this.widgetHeight(preview);
        if (preview === this.previewHeight) return;
        this.properties.previewHeight = preview;
        if (this.preview) this.preview.style.height = `${preview - 4}px`;
    }

    showHint(text) {
        if (this.hintLine) this.hintLine.textContent = text;
    }

    // Each list's socket sits at the right end of its row, the seed's on the seed row, and the joined text's beside
    // the preview, with the conditioning's under it; the rows name them, so no label is drawn. The labels stay for Pipe To and saving.
    placeOutputs() {
        if (this.flags?.collapsed) return;
        const widget = this.widgets[0];
        const top = (widget.y ?? this.widgets_start_y) + (widget.margin ?? 10);
        const { rows } = this.state;
        const y = (name) => {
            const middle = top + (rows.length + 1) * ROW + (this.previewHeight - 4) / 2;
            const both = this.outputs.some((output) => output.name === "conditioning");
            if (name === "text") return middle - (both ? 10 : 0);
            if (name === "conditioning") return middle + 10;
            const index = name === "seed" ? rows.length : rows.findIndex((row) => `row:${row.key}` === name);
            return top + index * ROW + (ROW - 4) / 2;
        };
        for (const output of this.outputs) {
            if (!Object.hasOwn(output, "renderingLabel")) Object.defineProperty(output, "renderingLabel", { get: () => "", configurable: true });
            output.pos = [this.size[0] - 10, y(output.name)];
        }
    }

    onDrawForeground() { this.placeOutputs(); }

    // One output per list, named after it; a renamed list tells the nodes that name their inputs after it (Pipe To).
    syncOutputs() {
        const { rows } = this.state;
        // The conditioning output is there while a clip is connected, and stays while something still uses it.
        if (this.linked("clip") && !this.outputs.some((output) => output.name === "conditioning")) this.addOutput("conditioning", "CONDITIONING");
        for (let i = this.outputs.length - 1; i >= 2; i--) {
            const keep = this.outputs[i].name === "conditioning" ? this.linked("clip") || this.isOutputConnected(i) : rows.some((row) => `row:${row.key}` === this.outputs[i].name);
            if (!keep) this.removeOutput(i);
        }
        const renamed = new Set();
        for (const row of rows) {
            const output = this.outputs.find((output) => output.name === `row:${row.key}`) || this.addOutput(`row:${row.key}`, "STRING");
            if (output.label !== row.name) renamed.add(output);
            output.label = row.name;
        }
        if (!renamed.size) return;
        for (const link of this.graph?.links?.values() ?? []) {
            if (link.origin_id !== this.id || !renamed.has(this.outputs[link.origin_slot])) continue;
            const target = this.graph.getNodeById(link.target_id);
            target?.onConnectionsChange?.(LiteGraph.INPUT, link.target_slot, true, link, target.inputs?.[link.target_slot]);
        }
    }

    update() {
        this.syncOutputs();
        this.layout();
    }

    layout() {
        this.render();
        this.setSize([this.size[0], this.widgets_start_y + this.widgetHeight()]);
        this.placeOutputs();
        this.graph?.setDirtyCanvas(true, true);
    }

    // Rolls what isn't frozen, as each queued run does.
    roll() {
        const missing = this.state.rows.find((row) => row.file && row.on && !row.frozen && !linesOf(row.file)?.length);
        if (missing) throw new Error(`Random Prompt Picker #${this.id}: the list "${missing.file}" has no lines or isn't in ${LIST_HINT}. Freeze or switch off ${missing.name}, or choose another list.`);
        roll(this.state, linesOf, newSeed());
        this.update();
    }

    async reroll() {
        await loadLists(this.state.rows.map((row) => row.file));
        try { this.roll(); } catch (error) { this.showHint(error.message); }
    }

    // A seed set by hand (typing, the arrows or dragging) is frozen, or the next run would replace it. The text is
    // left alone: the seed and the lists are frozen separately.
    setSeed(seed) {
        Object.assign(this.state, { seed: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, seed)), seedFrozen: true });
        this.update();
    }

    // Brings back the lines the seed picked when it was rolled, and freezes everything so the next run uses them.
    async useSeedLines() {
        await loadLists(this.state.rows.map((row) => row.file));
        pickLines(this.state, linesOf, this.state.seed);
        this.freezeAll(true);
    }

    freezeAll(frozen) {
        this.state.seedFrozen = frozen;
        for (const row of this.state.rows) if (row.file) row.frozen = frozen;
        this.update();
    }

    async pickList(event, choose) {
        await findLists();
        const names = [...files.keys()];
        new LiteGraph.ContextMenu(names.length ? names : [{ content: `No lists yet: put .txt or .md files in ComfyUI/${LIST_HINT}. Each line of a file is one entry.`, disabled: true }], {
            event, className: "dark", scale: Math.max(1, app.canvas?.ds?.scale ?? 1),
            callback: (file) => choose(file),
        });
    }

    async setList(row, file) {
        row.file = file;
        await loadLists([file]);
        const lines = linesOf(file);
        if (lines?.length) row.text = lines[Math.floor(Math.random() * lines.length)];
        this.update();
    }

    addList(event) {
        // The menu opens under the node, clear of the footer's other buttons.
        const below = this.panel.getBoundingClientRect().bottom + 10 * (app.canvas?.ds?.scale ?? 1) + 14;
        this.pickList(new MouseEvent("click", { clientX: event.clientX, clientY: below }), (file) => {
            const base = file.split("/").at(-1).replace(/\.(txt|md)$/i, "");
            const row = { key: `r${this.state.next++}`, name: base[0].toUpperCase() + base.slice(1), file, on: true, frozen: false, text: "" };
            this.state.rows.push(row);
            this.setList(row, file);
        });
    }

    // A row of text you type yourself, such as the fixed part of a prompt: never rolled, so it has no lock.
    addText() {
        const row = { key: `r${this.state.next++}`, name: "Text", file: "", on: true, text: "" };
        this.state.rows.push(row);
        this.editing = row.key;
        this.update();
    }

    lock(frozen, toggle, what) {
        const button = hinted(element("button", { className: frozen ? "on" : "" }, element("i", { className: `pi ${frozen ? "pi-lock" : "pi-lock-open"}` })),
            frozen ? `frozen: ${what} stays as it is · click to unfreeze` : `click to freeze: keep ${what} as it is`);
        button.onclick = toggle;
        return button;
    }

    listRow(row) {
        const { rows } = this.state;
        const missing = row.file && files && !files.has(row.file);
        let name;
        if (this.renaming === row.key) {
            name = editor(row.name, (value) => {
                this.renaming = null;
                if (value) row.name = value;
                this.update();
            });
            this.focus = name;
        } else {
            name = hinted(element("div", { className: "name", textContent: `${row.name}${missing ? " (missing)" : ""}` }),
                `${row.file ? `${row.file}${missing ? ` isn't in ${LIST_HINT}` : ""}` : "your own text"} · click: on/off · double-click: rename · right-click: more`);
            name.onpointerdown = (event) => { if (!event.button) event.stopPropagation(); };
            // A redraw sits between the two presses, so the double press is matched on the row, not the element.
            name.onpointerup = (event) => {
                if (event.button) return;
                row.on = !row.on;
                if (doublePress(`name:${this.id}:${row.key}`)) this.renaming = row.key;
                this.update();
            };
            name.oncontextmenu = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const power = row.on ? "Switch off" : "Switch on";
                const move = (by) => {
                    const index = rows.indexOf(row);
                    rows.splice(Math.max(0, Math.min(rows.length - 1, index + by)), 0, ...rows.splice(index, 1));
                    this.update();
                };
                new LiteGraph.ContextMenu(["Rename", "Choose list", power, null, "Move up", "Move down", null, "Remove"], {
                    event,
                    callback: (choice) => {
                        if (choice === "Rename") {
                            this.renaming = row.key;
                            this.update();
                        } else if (choice === "Choose list") this.pickList(event, (file) => this.setList(row, file));
                        else if (choice === power) {
                            row.on = !row.on;
                            this.update();
                        } else if (choice === "Move up") move(-1);
                        else if (choice === "Move down") move(1);
                        else if (choice === "Remove") remove.onclick();
                    },
                });
            };
        }

        let text;
        if (this.editing === row.key) {
            // Text typed over a list's line is frozen, or the next run would replace it.
            text = editor(row.text, (value) => {
                this.editing = null;
                if (value != null && value !== row.text) Object.assign(row, { text: value, ...(row.file && { frozen: true }) });
                this.update();
            });
            this.focus = text;
        } else {
            text = hinted(element("div", { className: "text", textContent: row.text || "—" }), `${row.text || "nothing picked yet"} · double-click: type your own`);
            text.onpointerdown = (event) => { if (!event.button) event.stopPropagation(); };
            text.ondblclick = () => {
                this.editing = row.key;
                this.update();
            };
        }

        const again = hinted(element("button", {}, element("i", { className: "pi pi-refresh" })), row.frozen ? "frozen: unfreeze to pick another line" : "pick another line");
        again.onclick = async () => {
            if (row.frozen) return;
            await this.setList(row, row.file);
        };
        const remove = hinted(element("button", { className: "remove", textContent: "×" }), "remove list");
        remove.onclick = () => {
            this.state.rows = rows.filter((other) => other !== row);
            this.update();
        };
        const freeze = this.lock(row.frozen, () => { row.frozen = !row.frozen; this.update(); }, "this line");
        if (!row.file) return element("div", { className: `row${row.on ? "" : " off"}` }, name, text, element("span"), element("span"), remove);
        return element("div", { className: `row${row.on ? "" : " off"}${row.frozen ? " frozen" : ""}` }, name, text, again, freeze, remove);
    }

    seedRow() {
        const state = this.state;
        let value;
        if (this.editing === "seed") {
            value = editor(String(state.seed), (typed) => {
                this.editing = null;
                if (typed && /^\d+$/.test(typed) && Number.isSafeInteger(Number(typed))) this.setSeed(Number(typed));
                else this.update();
            });
            this.focus = value;
        } else {
            // Like ComfyUI's own number field: arrows step by one, dragging left or right changes it.
            const number = element("span", { className: "number", textContent: String(state.seed) });
            const step = (by) => element("span", { className: "step", textContent: by < 0 ? "◀" : "▶", onclick: () => this.setSeed(state.seed + by) });
            value = hinted(element("div", { className: "text seed" }, step(-1), number, step(1)),
                "arrows, drag left/right or double-click to type: sets and freezes the seed · the text stays as it is");
            let drag = null;
            value.onpointerdown = (event) => {
                if (event.button) return;
                event.stopPropagation();
                if (event.target !== number) return;
                drag = { x: event.clientX, start: state.seed, seed: state.seed, moved: false };
                number.setPointerCapture?.(event.pointerId);
            };
            number.onpointermove = (event) => {
                if (!drag) return;
                const dx = event.clientX - drag.x;
                if (!drag.moved && Math.abs(dx) < 4) return;
                drag.moved = true;
                // The row is redrawn when the drag ends; redrawing now would drop the element being dragged.
                drag.seed = Math.max(0, drag.start + Math.round(dx / 3));
                number.textContent = String(drag.seed);
            };
            number.onpointerup = number.onpointercancel = () => {
                const dragged = drag;
                drag = null;
                if (dragged?.moved) this.setSeed(dragged.seed);
            };
            number.ondblclick = () => {
                this.editing = "seed";
                this.update();
            };
        }
        const freeze = this.lock(state.seedFrozen, () => { state.seedFrozen = !state.seedFrozen; this.update(); }, "the seed");
        return element("div", { className: `row${state.seedFrozen ? " frozen" : ""}` }, element("div", { className: "label", textContent: "seed" }), value, element("span"), freeze, element("span"));
    }

    render() {
        const state = this.state;
        this.focus = null;
        const rows = state.rows.map((row) => this.listRow(row));
        const preview = this.preview = hinted(element("div", { className: "preview", style: `height: ${this.previewHeight - 4}px`, textContent: `${this.linked("text") ? `(text input)${state.separator}` : ""}${joinedText(state)}` || `Add a list: a .txt or .md file in ComfyUI/${LIST_HINT}. Each line of the file is one entry, however long; a line break starts the next.` }),
            "the text output: the text input if connected, then the rows that are on, joined (right-click the node to change what joins them)");
        const addText = hinted(element("button", { textContent: "+ text" }), "add a row of your own text, such as the fixed part of a prompt");
        addText.onclick = () => this.addText();

        const addList = hinted(element("button", { textContent: "+ list" }), `add a list from ComfyUI/${LIST_HINT}`);
        addList.onclick = (event) => this.addList(event);
        const again = hinted(element("button", { textContent: "Re-roll" }), "pick a new seed and new lines now, except what is frozen · every queued run does this too");
        again.onclick = () => this.reroll();
        const frozen = [state.seedFrozen, ...state.rows.filter((row) => row.file).map((row) => row.frozen)];
        const all = frozen.every(Boolean);
        const freeze = hinted(element("button", { className: all ? "on" : "", textContent: `${all ? "☑" : frozen.some(Boolean) ? "◪" : "☐"} freeze all` }),
            all ? "everything is frozen · click to unfreeze all" : "freeze the seed and every list");
        freeze.onclick = () => this.freezeAll(!all);

        this.hintLine = element("div", { className: "hint" });
        this.panel.replaceChildren(...rows, this.seedRow(), preview, element("div", { className: "footer" }, addList, addText, again, freeze), this.hintLine);
        this.focus?.focus();
        this.focus?.select();
    }

    getExtraMenuOptions() {
        return [{ content: "Pick the lines of this seed", callback: () => this.useSeedLines() }, {
            content: "Join lines with", has_submenu: true,
            submenu: { options: SEPARATORS.map(([separator, name]) => ({
                content: `${this.state.separator === separator ? "☑" : "☐"} ${name}`,
                callback: () => { this.state.separator = separator; this.update(); },
            })) },
        }];
    }
}

function randomNodes() {
    const root = app.rootGraph || app.graph;
    return [root, ...(root?.subgraphs?.values?.() ?? [])].flatMap((graph) => graph?.nodes ?? []).filter((node) => node instanceof RandomPrompt);
}

async function refreshLists() {
    await findLists();
    for (const node of randomNodes()) node.render();
}

app.registerExtension({
    name: "ggtools.random_prompt",
    registerCustomNodes() {
        LiteGraph.registerNodeType(RANDOM_PROMPT, RandomPrompt);
        RandomPrompt.category = "ggtools";
    },
    // The frontend builds a bare definition for frontend-only nodes; add the terms people search for.
    beforeRegisterVueAppNodeDefs(defs) {
        const def = defs.find((def) => def.name === RANDOM_PROMPT);
        if (def) def.search_aliases = ["Random Text", "Random Line", "Random Seed", "Wildcard", "Prompt List", "Text List", "Freeze Seed", "Global Seed"];
    },
    refreshComboInNodes() { refreshLists(); },
    afterConfigureGraph() {
        for (const node of randomNodes()) node.update();
    },
    setup() {
        refreshLists();
        addPromptStep(RANDOM, {
            // Each run rolls first, so the node shows, and the workflow saved in the image holds, what the run used.
            async prepare() {
                const nodes = randomNodes().filter((node) => node.mode === LiteGraph.ALWAYS);
                if (!nodes.length) return;
                await loadLists(nodes.flatMap((node) => node.state.rows.map((row) => row.file)));
                for (const node of nodes) node.roll();
            },
            compile(result) {
                const nodes = collectNodes(result.workflow, RANDOM_PROMPT);
                return nodes.size ? { ...result, output: compileRandomPrompts(result.output, nodes) } : result;
            },
        });
    },
});
