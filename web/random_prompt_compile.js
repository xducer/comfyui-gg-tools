export const RANDOM_PROMPT = "Random Prompt Picker (ggtools)";

// ComfyUI's own seed fields randomize up to this.
export const MAX_SEED = 2 ** 50;

// The line a seed gives a list. Each list is picked on its own from the seed and its file name (`nth` tells two
// rows of the same file apart), so switching another list on or off, or reordering the lists, leaves it alone.
export function pickIndex(seed, file, nth, length) {
    let hash = 2166136261;
    for (const char of `${seed}|${file}|${nth}`) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return ((hash ^ (hash >>> 16)) >>> 0) % length;
}

// Gives each list that is on and not frozen the line `seed` picks; `linesOf(file)` returns a list's lines.
export function pickLines(state, linesOf, seed) {
    const seen = new Map();
    for (const row of state.rows) {
        const nth = seen.get(row.file) ?? 0;
        seen.set(row.file, nth + 1);
        const lines = row.on && !row.frozen && linesOf(row.file);
        if (lines?.length) row.text = lines[pickIndex(seed, row.file, nth, lines.length)];
    }
}

// One roll: `number` picks the lines and becomes the seed, unless the seed is frozen. The seed and the lists are
// frozen separately, so either can stay while the other changes.
export function roll(state, linesOf, number) {
    if (!state.seedFrozen) state.seed = number;
    pickLines(state, linesOf, number);
}

// A period or comma joiner takes the place of the punctuation a part already ends with, so none is doubled.
const TRAILING = "[\\s.,;:]+$";
const punctuates = (separator) => /^[.,]/.test(separator);

function join(parts, separator) {
    if (!punctuates(separator) || !parts.length) return parts.join(separator);
    const trailing = new RegExp(TRAILING);
    return parts.map((part, i) => (i < parts.length - 1 ? part.replace(trailing, "") : part)).reduce((joined, part) => joined + (/[!?]$/.test(joined) ? " " : separator) + part);
}

export const joinedText = (state) => join(state.rows.filter((row) => row.on && row.text).map((row) => row.text), state.separator);

// Each wire from a Random Prompt Picker becomes the value itself, and the node leaves the prompt. Text wired into the node
// is only known on the server, so ComfyUI's own Regex Replace and Concatenate Text put it in front there; the conditioning output is
// ComfyUI's own CLIP Text Encode of the result.
export function compileRandomPrompts(prompt, nodes) {
    const added = {};
    const follow = (link) => (Array.isArray(link) && prompt[link[0]]?.class_type === RANDOM_PROMPT ? value(String(link[0]), link[1]) : link);

    function text(id) {
        const state = nodes.get(id).properties.random;
        const joined = joinedText(state);
        const before = follow(prompt[id].inputs.text);
        if (before === undefined || before === "") return joined;
        if (!joined) return before;
        if (!Array.isArray(before)) return join([before, joined], state.separator);
        let first = before;
        if (punctuates(state.separator)) {
            added[`${id}.before`] = { class_type: "RegexReplace", inputs: { string: before, regex_pattern: TRAILING, replace: "" }, _meta: { title: "Random Prompt Picker: text input" } };
            first = [`${id}.before`, 0];
        }
        added[`${id}.text`] = { class_type: "StringConcatenate", inputs: { string_a: first, string_b: joined, delimiter: state.separator }, _meta: { title: "Random Prompt Picker: text" } };
        return [`${id}.text`, 0];
    }

    function value(id, slot) {
        const node = nodes.get(id);
        const state = node.properties.random;
        const name = node.outputs?.[slot]?.name;
        if (name === "text") return text(id);
        if (name === "seed") return state.seed;
        if (name === "conditioning") {
            const clip = follow(prompt[id].inputs.clip);
            if (!clip) throw new Error(`Random Prompt Picker #${id}: connect a clip to use its conditioning output.`);
            added[`${id}.conditioning`] = { class_type: "CLIPTextEncode", inputs: { clip, text: text(id) }, _meta: { title: "Random Prompt Picker: conditioning" } };
            return [`${id}.conditioning`, 0];
        }
        const row = state.rows.find((row) => `row:${row.key}` === name);
        if (!row) throw new Error(`Random Prompt Picker #${id}: reconnect the output in slot ${slot}.`);
        return row.on ? row.text : "";
    }

    const output = {};
    for (const [id, node] of Object.entries(prompt)) {
        if (node.class_type === RANDOM_PROMPT) continue;
        let inputs = null;
        for (const [name, link] of Object.entries(node.inputs)) {
            const resolved = follow(link);
            if (resolved === link) continue;
            inputs ??= { ...node.inputs };
            inputs[name] = resolved;
        }
        output[id] = inputs ? { ...node, inputs } : node;
    }
    return Object.assign(output, added);
}
