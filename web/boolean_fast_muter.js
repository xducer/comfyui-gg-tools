import { app } from "../../../scripts/app.js";

const { ComfyWidgets } = window.comfyAPI.widgets;
const NODE_TYPE = "Boolean Fast Muter";

class BooleanFastMuter extends LGraphNode {
    static title = NODE_TYPE;
    static category = "ggtools";

    constructor() {
        super(BooleanFastMuter.title);
        this.isVirtualNode = true;
        this.serialize_widgets = true;
        this.addInput("target", "*");
        this.addInput("boolean", "BOOLEAN", { widget: { name: "boolean" } });
        const { widget } = ComfyWidgets.BOOLEAN(this, "boolean", ["BOOLEAN", { default: true }], app);
        widget.callback = () => this.syncState();
        this.addOutput("OPT_CONNECTION", 0);
        this.setSize(this.computeSize());
    }

    onAdded() {
        this.refreshTimer = setInterval(() => this.syncState(), 100);
    }

    onRemoved() {
        clearInterval(this.refreshTimer);
    }

    onConnectionsChange(type) {
        if (type === LiteGraph.INPUT) this.scheduleTargetSockets();
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
        this.inputs[1].name = "boolean";
        this.inputs[1].widget = { name: "boolean" };
        if (!this.outputs?.some((output) => output.name === "OPT_CONNECTION")) {
            this.addOutput("OPT_CONNECTION", 0);
        }
        this.scheduleTargetSockets();
    }

    updateTargetSockets() {
        if (!this.graph) return;
        const targets = this.inputs.filter((input, index) => index !== 1);
        for (const input of targets.slice(0, -1).reverse()) {
            if (input.link == null) {
                const index = this.inputs.indexOf(input);
                // Keep the first target slot before the Boolean widget.
                if (index !== 0) this.removeInput(index);
            }
        }
        for (const input of this.inputs.filter((input, index) => index !== 1)) {
            const link = this.graph.links[input.link];
            const target = link && this.graph.getNodeById(link.origin_id);
            input.name = target?.title || "target";
        }
        const lastTarget = this.inputs.filter((input, index) => index !== 1).at(-1);
        if (lastTarget.link != null) this.addInput("target", "*");
        const size = this.computeSize();
        size[0] = Math.max(this.size[0], size[0]);
        this.setSize(size);
        this.graph.setDirtyCanvas(true, true);
    }

    getInputLink(slot) {
        const input = this.inputs[slot];
        return input?.link != null ? this.graph.links[input.link] : null;
    }

    resolveVirtualOutput(slot) {
        if (slot !== 0 || !this.graph) return;
        const input = this.inputs.find((input, index) => index !== 1 && input.link != null);
        const link = input && this.graph.links[input.link];
        const node = link && this.graph.getNodeById(link.origin_id);
        if (node) return { node, slot: link.origin_slot };
    }

    syncState(strict = false) {
        if (!this.graph || app.configuringGraph || this.mode === 2 || this.mode === 4) return;
        const widget = this.widgets.find((widget) => widget.name === "boolean");
        const controlLink = this.getInputLink(1);
        const source = controlLink && this.graph.getNodeById(controlLink.origin_id);
        let value = widget.value;
        if (controlLink) {
            value = source?.widgets?.find((widget) => widget.name === "value")?.value;
            if (source?.type !== "easy boolean" || source.inputs?.some((input) => input.name === "value" && input.link != null) || typeof value !== "boolean") {
                if (strict) throw new Error("Boolean Fast Muter: connect boolean directly to an Easy Use Boolean with a local value toggle.");
                return;
            }
        }
        let changed = widget.value !== value;
        if (changed) widget.value = value;
        for (const [index, input] of this.inputs.entries()) {
            if (index === 1) continue;
            const link = this.graph.links[input.link];
            const target = link && this.graph.getNodeById(link.origin_id);
            if (target && target !== source && target !== this) {
                const mode = value ? 0 : 2;
                if (target.mode !== mode) {
                    target.mode = mode;
                    changed = true;
                }
            }
        }
        const targetOutput = this.resolveVirtualOutput(0);
        const targetType = targetOutput?.node.outputs?.[targetOutput.slot]?.type;
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
            changed = true;
        }
        if (changed) this.graph.setDirtyCanvas(true, true);
    }

    applyToGraph() {
        this.syncState(true);
    }
}

app.registerExtension({
    name: "local.BooleanFastMuter",
    beforeConfigureGraph(graphData) {
        for (const node of graphData.nodes || []) {
            if (node.type !== NODE_TYPE || node.inputs?.[0]?.name !== "enabled") continue;
            [node.inputs[0], node.inputs[1]] = [node.inputs[1], node.inputs[0]];
            node.inputs[1].name = "boolean";
            node.inputs[1].widget = { name: "boolean" };
            for (const link of graphData.links || []) {
                if (Array.isArray(link)) {
                    if (link[3] === node.id && link[4] < 2) link[4] = 1 - link[4];
                } else if (link.target_id === node.id && link.target_slot < 2) {
                    link.target_slot = 1 - link.target_slot;
                }
            }
        }
    },
    registerCustomNodes() {
        LiteGraph.registerNodeType(NODE_TYPE, BooleanFastMuter);
        BooleanFastMuter.category = "ggtools";
    },
});
