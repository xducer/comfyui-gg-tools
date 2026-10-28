import { app } from "../../../scripts/app.js";

// The pack's nodes leave the queued prompt through these steps. The frontend loads the pack's scripts in parallel,
// so one hook runs them in a fixed order however they load: the pipes first, so the later steps see the real
// sources behind a Pipe From, then the LoRA Multi-Stack, then Crossroads, which cuts whole paths.
export const PIPES = 1;
export const LORA_STACK = 2;
export const CROSSROADS = 3;

const steps = [];

// `compile(result, prepared)` returns the new graphToPrompt result; `prepare(graph)`, if given, runs before the
// prompt is built and its return value is passed on.
export function addPromptStep(order, step) {
    if (!steps.length) {
        const graphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function (graph = this.rootGraph || this.graph, ...args) {
            const prepared = steps.map(({ step }) => step.prepare?.(graph));
            let result = await graphToPrompt.call(this, graph, ...args);
            steps.forEach(({ step }, i) => { result = step.compile(result, prepared[i]); });
            return result;
        };
    }
    steps.push({ order, step });
    steps.sort((a, b) => a.order - b.order);
}
