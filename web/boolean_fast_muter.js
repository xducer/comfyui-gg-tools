import { app } from "../../../scripts/app.js";

const { ComfyWidgets } = window.comfyAPI.widgets;
const NODE_TYPE = "Boolean Fast Muter";

function inputNodes(node) {
    const nodes = [];
    for (const input of node.inputs) {
        const link = node.graph.links[input.link];
        const source = link && node.graph.getNodeById(link.origin_id);
        if (source) nodes.push(source);
    }
    return nodes;
}

function isInputAncestor(node, ancestor) {
    const pending = inputNodes(node);
    const visited = new Set();
    while (pending.length) {
        const source = pending.pop();
        if (source === ancestor) return true;
        if (visited.has(source)) continue;
        visited.add(source);
        pending.push(...inputNodes(source));
    }
    return false;
}

function booleanConstant(node) {
    if (!["easy boolean", "PrimitiveBoolean", "PrimitiveNode"].includes(node?.type)) return;
    if (node.inputs.some((input) => input.name === "value" && input.link != null)) return;
    return node.widgets.find((widget) => widget.name === "value")?.value;
}

class BooleanFastMuter extends LGraphNode {
    static title = `${NODE_TYPE} (ggtools)`;

    constructor() {
        super(BooleanFastMuter.title);
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        this.muted = new Set();
        this.addInput("target", "*");
        this.addInput("boolean", "BOOLEAN", { widget: { name: "boolean" } });
        const { widget } = ComfyWidgets.BOOLEAN(this, "boolean", ["BOOLEAN", { default: false }], app);
        widget.callback = () => this.syncState();
        this.addOutput("OPT_CONNECTION", 0);
        this.setSize(this.computeSize());
    }

    onAdded() {
        this.refreshTimer = setInterval(() => {
            if (this.graph && this.updateTargetNames()) this.updateTargetSockets();
            this.syncState();
        }, 100);
    }

    onRemoved() {
        clearInterval(this.refreshTimer);
        // Loading a workflow clears the old graph; only a real removal gives control back.
        if (!app.configuringGraph) this.release();
    }

    onConnectionsChange(type) {
        if (type === LiteGraph.INPUT) this.scheduleTargetSockets();
    }

    onConnectInput(index, type, slot, source) {
        if (source === this.graph.inputNode) return true;
        return source !== this && !isInputAncestor(source, this);
    }

    onConnectOutput(index, type, slot, target) {
        return target !== this && !isInputAncestor(this, target);
    }

    scheduleTargetSockets() {
        if (this.updatingSockets) return;
        this.updatingSockets = true;
        queueMicrotask(() => {
            this.updatingSockets = false;
            this.updateTargetSockets();
            this.syncState();
        });
    }

    onConfigure() {
        if (this.title === NODE_TYPE) this.title = BooleanFastMuter.title;
        this.inputs[1].name = "boolean";
        this.inputs[1].widget = { name: "boolean" };
        this.scheduleTargetSockets();
    }

    updateTargetSockets() {
        if (!this.graph) return;
        // Keep one empty target: the first slot (before the Boolean widget) when it is free, otherwise a spare at the end.
        for (let index = this.inputs.length - 1; index > 1; index--) {
            const spare = index === this.inputs.length - 1 && this.inputs[0].link != null;
            if (this.inputs[index].link == null && !spare) this.removeInput(index);
        }
        this.updateTargetNames();
        if (!this.inputs.some((input, index) => index !== 1 && input.link == null)) this.addInput("target", "*");
        const size = this.computeSize();
        size[0] = Math.max(this.size[0], size[0]);
        this.setSize(size);
        this.graph.setDirtyCanvas(true, true);
    }

    updateTargetNames() {
        let changed = false;
        for (const input of this.inputs.filter((input, index) => index !== 1)) {
            const link = this.graph.links[input.link];
            const target = link && this.graph.getNodeById(link.origin_id);
            const boundary = link?.originIsIoNode ? this.graph.inputs[link.origin_slot] : undefined;
            const name = target?.title || boundary?.label || boundary?.name || "target";
            if (input.name !== name) {
                input.name = name;
                changed = true;
            }
        }
        return changed;
    }

    getInputLink(slot) {
        if (slot === 0 && this.bypassesOutput()) return null;
        const input = this.inputs[slot];
        return input?.link != null ? this.graph.links[input.link] : null;
    }

    resolveVirtualOutput(slot) {
        if (slot !== 0 || !this.graph || this.bypassesOutput()) return;
        const input = this.inputs.find((input, index) => index !== 1 && input.link != null);
        const link = input && this.graph.links[input.link];
        const node = link && this.graph.getNodeById(link.origin_id);
        if (node) return { node, slot: link.origin_slot };
    }

    bypassesOutput() {
        if (!this.graph || this.graph.rootGraph !== this.graph || this.mode === 2 || this.mode === 4) return false;
        return this.getRootBoolean() === true;
    }

    getRootBoolean(strict = false) {
        const controlLink = this.getInputLink(1);
        if (!controlLink) return this.widgets.find((widget) => widget.name === "boolean").value;
        const value = booleanConstant(this.graph.getNodeById(controlLink.origin_id));
        if (typeof value === "boolean") return value;
        if (strict) throw new Error("Boolean Fast Muter (ggtools): connect a Boolean constant with a local value toggle.");
    }

    controlledNodes() {
        const controlLink = this.getInputLink(1);
        const control = controlLink && this.graph.getNodeById(controlLink.origin_id);
        const pending = [];
        for (const [index, input] of this.inputs.entries()) {
            if (index === 1) continue;
            const link = this.graph.links[input.link];
            const node = link && this.graph.getNodeById(link.origin_id);
            if (node) pending.push(node);
        }
        const visited = new Set();
        const targets = [];
        while (pending.length) {
            const node = pending.pop();
            if (node === this || node === control || visited.has(node)) continue;
            visited.add(node);
            const type = node.type || "";
            if (type.includes("Reroute") || type.includes("Node Collector") || type.includes("Node Combiner")) {
                pending.push(...inputNodes(node));
            } else {
                targets.push(node);
            }
        }
        return targets;
    }

    syncState(strict = false) {
        if (!this.graph || app.configuringGraph) return;
        if (this.mode === 2 || this.mode === 4) return this.release();
        if (this.graph.rootGraph !== this.graph) {
            this.updateOutputType();
            return;
        }
        const widget = this.widgets.find((widget) => widget.name === "boolean");
        const value = this.getRootBoolean(strict);
        if (value === undefined) return;
        let changed = widget.value !== value;
        if (changed) widget.value = value;
        const targets = this.controlledNodes();
        const mode = value ? 2 : 0;
        for (const target of targets) {
            if (target.mode !== mode) {
                target.mode = mode;
                changed = true;
            }
        }
        if (this.release(targets)) changed = true;
        if (value) this.muted = new Set(targets);
        this.updateOutputType();
        if (changed) this.graph.setDirtyCanvas(true, true);
    }

    // Unmute nodes this muter muted but no longer controls, unless the user changed them since.
    release(keep = []) {
        let changed = false;
        for (const node of this.muted) {
            if (keep.includes(node) || node.mode !== 2) continue;
            node.mode = 0;
            changed = true;
        }
        this.muted.clear();
        if (changed) this.graph?.setDirtyCanvas(true, true);
        return changed;
    }

    updateOutputType() {
        const targetInput = this.inputs.find((input, index) => index !== 1 && input.link != null);
        const targetLink = targetInput && this.graph.links[targetInput.link];
        const target = targetLink && this.graph.getNodeById(targetLink.origin_id);
        const targetType = target?.outputs?.[targetLink.origin_slot]?.type ||
            (targetLink?.originIsIoNode ? this.graph.inputs[targetLink.origin_slot]?.type : undefined);
        // LiteGraph's numeric wildcard stops downstream type inference from walking into the Boolean control.
        const outputType = targetType && targetType !== "*" ? targetType : 0;
        const output = this.outputs[0];
        if (output.type !== outputType) {
            output.type = outputType;
            output.label = outputType || "*";
            for (const linkId of output.links || []) {
                const link = this.graph.links[linkId];
                if (link) {
                    link.type = outputType;
                    this.graph.getNodeById(link.target_id)?.onConnectionsChainChange?.();
                }
            }
            this.graph.setDirtyCanvas(true, true);
        }
    }

    getSubgraphBoolean(executable, visited = new Set()) {
        const control = executable.resolveInput(1, new Set(visited));
        let value = this.widgets.find((widget) => widget.name === "boolean").value;
        if (executable.inputs[1].linkId != null) {
            value = control?.widgetInfo?.value;
            let owner = executable;
            let slot = 1;
            while (typeof value !== "boolean" && owner) {
                const link = owner.graph.getLink(owner.inputs[slot].linkId);
                if (!link) break;
                if (link.originIsIoNode && owner.subgraphNode) {
                    slot = link.origin_slot;
                    owner = owner.nodesByExecutionId.get(owner.subgraphNodePath.join(":"));
                } else {
                    value = booleanConstant(owner.graph.getNodeById(link.origin_id));
                    break;
                }
            }
            if (typeof value !== "boolean") {
                throw new Error("Boolean Fast Muter (ggtools): the Boolean control must have a value before execution.");
            }
        }
        return value;
    }

    resolveSubgraphOutput(executable, slot, type, visited) {
        if (this.getSubgraphBoolean(executable, visited) || slot !== 0) return;
        const targetSlot = executable.inputs.findIndex((input, index) => index !== 1 && input.linkId != null);
        if (targetSlot !== -1) return executable.resolveInput(targetSlot, visited, type);
    }

    applyToGraph() {
        if (isInputAncestor(this, this)) throw new Error("Boolean Fast Muter (ggtools): remove the connection loop before queuing.");
        this.syncState(true);
    }
}

app.registerExtension({
    name: "local.BooleanFastMuter",
    nodeCreated(node) {
        if (!node.isSubgraphNode()) return;
        const getInnerNodes = node.getInnerNodes;
        node.getInnerNodes = function (nodesByExecutionId, ...args) {
            const executableNodes = getInnerNodes.call(this, nodesByExecutionId, ...args);
            // Subgraph definitions are shared; apply control only to instance DTOs.
            for (const executable of executableNodes) {
                if (!(executable.node instanceof BooleanFastMuter) || executable.subgraphNode !== this) continue;
                for (const node of executable.node.controlledNodes()) {
                    const targetId = [...executable.subgraphNodePath, node.id].join(":");
                    for (const target of nodesByExecutionId.values()) {
                        if (target.id !== targetId && !target.id.startsWith(targetId + ":")) continue;
                        const previousMode = Object.getOwnPropertyDescriptor(target, "mode")?.get;
                        Object.defineProperty(target, "mode", {
                            configurable: true,
                            get() {
                                if (executable.mode !== 2 && executable.mode !== 4) {
                                    if (executable.node.getSubgraphBoolean(executable)) return 2;
                                    if (this.id === targetId) return 0;
                                }
                                return previousMode ? previousMode.call(this) : this.node.mode;
                            },
                        });
                    }
                }
                const resolveOutput = executable.resolveOutput;
                executable.resolveOutput = function (slot, type, visited) {
                    if (this.mode === 2 || this.mode === 4) return resolveOutput.call(this, slot, type, visited);
                    return this.node.resolveSubgraphOutput(this, slot, type, visited);
                };
            }
            return executableNodes;
        };
    },
    registerCustomNodes() {
        LiteGraph.registerNodeType(NODE_TYPE, BooleanFastMuter);
        BooleanFastMuter.category = "ggtools";
    },
});
