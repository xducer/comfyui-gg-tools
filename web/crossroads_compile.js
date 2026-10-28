import { collectNodes } from "./workflow_nodes.js";

export const SPLIT = "Crossroads Split (ggtools)";
export const JOIN = "Crossroads Join (ggtools)";

// A reference resolves to a link, to a value given directly (a subgraph field arrives as its value), to Nothing when
// nothing arrives (an empty path, an unwired or muted source), or to CUT when it lies on a path that isn't selected.
// Cut nodes leave the prompt; Nothing leaves the receiving input out and remembers why, for the message.
const CUT = Symbol("cut");

class Nothing {
    constructor(cause) { this.cause = cause; }
}

// Path numbers count from 1 and wrap around, so an incrementing Int cycles through the paths.
export function pathByNumber(paths, number) {
    return paths[(((number - 1) % paths.length) + paths.length) % paths.length];
}

// Required inputs the selected paths leave empty, collected so they are all reported at once. `output` is the
// compiled prompt with those inputs left out, for callers that report the problem elsewhere.
export class MissingInputsError extends Error {
    constructor(missing, output) {
        super(missing.map((input) => input.message).join("\n"));
        this.missing = missing;
        this.output = output;
    }
}

// A Split's outputs are named "<path>:<value>", a Join's inputs the same way and its outputs "<value>"; the saved
// workflow has those names, the prompt only slot numbers. `isRequired(classType, inputName)` tells a required input
// from an optional one: values left out of required inputs stop the queue here, naming the cause, instead of at the
// receiving nodes.
export function compileCrossroads(prompt, workflow, isRequired) {
    const splits = collectNodes(workflow, SPLIT);
    const joins = collectNodes(workflow, JOIN);
    const isLink = (value) => Array.isArray(value) && prompt[value[0]] !== undefined;
    const links = (inputs) => Object.values(inputs).filter(isLink);
    const cutNodes = new Map();
    const joined = new Map();
    const pathNumber = (split, key) => splits.get(split).properties.crossroads.paths.findIndex((path) => path.key === key) + 1;

    // The path number must be known before queuing: typed on the node, from a Primitive or a subgraph input, or from a
    // constant such as an Int node (an integer `value` and nothing wired into it).
    function selected(id) {
        const value = prompt[id].inputs.path;
        const source = isLink(value) ? prompt[value[0]] : null;
        const number = source && !links(source.inputs).length ? source.inputs.value : value;
        if (Number.isInteger(number)) return pathByNumber(splits.get(id).properties.crossroads.paths, number).key;
        if (value === undefined) throw new Error(`Crossroads Split #${id}: path gets no value. Check that its source isn't muted or bypassed.`);
        throw new Error(`Crossroads Split #${id}: the path number must come from a constant such as an Int node, not from another node's result.`);
    }

    // A node is cut when any of its inputs is. A node that is cut anyway doesn't stop the queue over an error in
    // another of its inputs (say, a Join whose Split can't pick a path).
    function cut(id) {
        if (!cutNodes.has(id)) {
            let failure = null;
            let isCut = false;
            for (const value of links(prompt[id].inputs)) {
                try {
                    if (resolve(value) === CUT) {
                        isCut = true;
                        break;
                    }
                } catch (error) {
                    failure ??= error;
                }
            }
            if (!isCut && failure) throw failure;
            cutNodes.set(id, isCut);
        }
        return cutNodes.get(id);
    }

    // What a Split value or a Join row passes on: the source of a wire, a value given directly, or Nothing.
    const carried = (source, nothing) => (isLink(source) ? resolve(source) : source === undefined ? new Nothing(nothing) : source);

    function resolve([id, slot]) {
        const record = prompt[id];
        if (record.class_type === JOIN) return join(id, slot);
        if (cut(id)) return CUT;
        if (record.class_type !== SPLIT) return [id, slot];
        const [path, value] = splits.get(id).outputs?.[slot]?.name?.split(":") ?? [];
        if (!value) throw new Error(`Crossroads Split #${id}: reconnect the output in slot ${slot}.`);
        if (path !== selected(id)) return CUT;
        // The frontend leaves out a wire from a muted or bypassed node, so the saved workflow tells the two apart.
        const input = splits.get(id).inputs?.find((input) => input.name === value);
        const why = input?.link != null ? "comes from a muted or bypassed node" : "has no source";
        return carried(record.inputs[value], `The ${input?.label ?? "value"} going into Crossroads Split #${id} ${why}`);
    }

    function join(id, slot) {
        const key = `${id}|${slot}`;
        if (!joined.has(key)) joined.set(key, joinValue(id, slot));
        return joined.get(key);
    }

    // A Join passes on its selected path's input for the value; an unwired one carries nothing. When an outer Split
    // cut the whole crossroads, everything after it is cut too.
    function joinValue(id, slot) {
        const value = joins.get(id)?.outputs?.[slot]?.name;
        if (!value) throw new Error(`Crossroads Join #${id}: reconnect the output in slot ${slot}.`);
        const split = pairedSplit(id);
        if (cut(split)) return CUT;
        const path = selected(split);
        const number = pathNumber(split, path);
        const resolved = carried(prompt[id].inputs[`${path}:${value}`], `Path ${number} of Crossroads Split #${split} delivers nothing to Crossroads Join #${id}`);
        if (resolved === CUT) throw new Error(`Crossroads Join #${id}: the input for path ${number} is wired from a different path. Move it to that path's row.`);
        return resolved;
    }

    // The Split a Join belongs to is the nearest one upstream of its first input that leads to a Split, as the canvas
    // pairs them; a nested crossroads counts as one node, whose inputs are those of its own Split.
    function pairedSplit(id) {
        for (const start of links(prompt[id].inputs)) {
            let level = [start];
            const seen = new Set();
            while (level.length) {
                const next = [];
                for (const [source] of level) {
                    if (seen.has(source)) continue;
                    seen.add(source);
                    const record = prompt[source];
                    if (record.class_type === SPLIT) return source;
                    next.push(...links(record.class_type === JOIN ? prompt[pairedSplit(source)].inputs : record.inputs));
                }
                level = next;
            }
        }
        throw new Error(`Crossroads Join #${id}: no Crossroads Split leads here. Connect it to a Split's paths, or set a muted or bypassed Split back to Always.`);
    }

    const output = {};
    const missingInputs = [];
    for (const [id, record] of Object.entries(prompt)) {
        if (record.class_type === SPLIT || record.class_type === JOIN || cut(id)) continue;
        let inputs = null;
        for (const [name, value] of Object.entries(record.inputs)) {
            if (!isLink(value) || ![SPLIT, JOIN].includes(prompt[value[0]].class_type)) continue;
            inputs ??= { ...record.inputs };
            const resolved = resolve(value);
            if (!(resolved instanceof Nothing)) inputs[name] = resolved;
            else {
                const node = `${record._meta?.title ?? record.class_type} #${id}`;
                if (isRequired(record.class_type, name)) missingInputs.push({ id, classType: record.class_type, name, node, cause: resolved.cause, message: `${resolved.cause}, and ${node} needs its ${name} input.` });
                delete inputs[name];
            }
        }
        output[id] = inputs ? { ...record, inputs } : record;
    }
    if (missingInputs.length) throw new MissingInputsError(missingInputs, output);
    return output;
}
