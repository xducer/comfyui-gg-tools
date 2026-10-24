# GGTools for ComfyUI

Frontend-only nodes for keeping large ComfyUI workflows tidy and switchable. No Python packages or extra requirements.

| Node | What it does |
| --- | --- |
| **Pipe To / Pipe From (ggtools)** | Send connections anywhere in the workflow, including into and out of subgraphs, without wires. |
| **Boolean Fast Muter (ggtools)** | Switch a connection, or a group of source nodes, on and off with a Boolean. |

Both are under **Add Node → ggtools**.

## Pipe To and Pipe From

![Load Checkpoint feeds model and clip into Pipe To. With no wire between them, a Pipe From set to that pipe sends model to a KSampler and clip to a CLIP Text Encode.](assets/pipes_example_01.png)

1. Connect anything to **Pipe To (ggtools)**. Each connection becomes a named entry, and a spare `connect anything` input appears for the next one.
2. Add **Pipe From (ggtools)** anywhere, on the main canvas or inside a subgraph, and pick the Pipe To in its `pipe` dropdown, for example `Pipe #12 — Main canvas`.
3. Connect the outputs you need.

Entries are named automatically, and renames show up straight away:

| Source | Entry name |
| --- | --- |
| A named output, such as Get Image Size | `width`, `height` |
| A KJNodes Get or Set node | its variable, such as `Image_BG` |
| A source that also feeds another node's input or a Set node | that input's name or the Set variable, such as `positive` or `Clip_Base` |
| Anything else | the type, such as `model`, `clip`, then `model_2` for a second one |

If you rename the node, your title leads and the source's own name follows in brackets, unless the title already contains it: `Background size [width]`, `Genode for Clip [Clip_Base]`, `Encode Load Image [latent]`. Renaming an output slot or a subgraph input names the value directly.

![Load Checkpoint and a LoRA node renamed Detail Lora both feed Pipe To, which shows model, Detail Lora [model] and Detail Lora [clip]. The Pipe From sends model to one Basic Guider and Detail Lora [model] to another.](assets/pipes_example_02.png)

Same-type values stay apart by name, so each one goes exactly where you connect it.

- Any connection type works, and several Pipe To and Pipe From nodes can share a workflow. A new Pipe From selects the Pipe To automatically when there is only one.
- Inside a subgraph, **This instance** reads the Pipe To in the same copy of the subgraph, so each copy of a reused subgraph sends its own values.
- Pipes keep working through copy and paste, cut and paste, Convert to Subgraph and unpacking. A Pipe To copied together with its Pipe From becomes a new, independent pair.
- Switching a Pipe From to another pipe keeps the connections whose name and type exist on the new pipe. Anything else, including an entry removed from the Pipe To, is marked `(missing)` rather than silently fed a different value.

When you queue, each used output becomes an ordinary link to the original source, and the pipe nodes never reach the server. Unused outputs are ignored. If a muted or bypassed source leaves an entry empty, the receiving input is left unconnected, as if it were wired directly. A used output whose pipe was deleted stops the queue with an error naming the Pipe From.

## Boolean Fast Muter

![Two copies of the same setup. With false, Load Image runs and its image passes through the muter to VAE Encode. With true, Load Image is muted and the connection is left out.](assets/bypass_example_01.png)

Connect a source node's output to `target`, then connect `OPT_CONNECTION` to the input it should feed.

| `boolean` | Result |
| --- | --- |
| `false` (default) | The source runs and its output passes through. |
| `true` | The source is muted and the connection is left out of the queued prompt. |

- Use the toggle on the node, or connect a Boolean constant or primitive. Values calculated during execution are not supported.
- Connect several targets to switch them together. `OPT_CONNECTION` forwards the first connected target. Targets can sit behind reroutes, collectors or combiners.
- Several muters can control the same node, including muters connected to another muter's `target`. The node stays muted while any of them is `true`.
- Disconnecting a target, deleting the muter or bypassing it re-enables what it muted.
- A left-out connection is absent, not `None`. Optional inputs take their no-input path and widget inputs fall back to their own value. A required input still fails with `Required input is missing`.

### Controlling a subgraph from outside

![Inside a subgraph, an input passes through Boolean Fast Muter. A Boolean subgraph input drives the muter, so the parent subgraph node shows the toggle on the main canvas.](assets/readme/hero.svg)

Put the muter inside the subgraph, route the incoming data through it, and wire a Boolean subgraph input to its `boolean` socket. The toggle then appears on the parent subgraph node, and each copy of the subgraph can have its own value. Use one muter per subgraph input you want to switch independently.

## Install

The repository is private. Clone it with an account that has access:

```sh
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/xducer/comfyui-ggtools.git
```

Restart ComfyUI and refresh the browser. To update, run `git pull --ff-only` in `custom_nodes/comfyui-ggtools`, then restart and refresh.

## Notes

- The nodes act in the browser when it builds the prompt. **Export (API)** includes their effect, but an exported prompt does not change if you toggle afterwards, and prompts already queued are unaffected.
- Boolean Fast Muter is inspired by [Fast Muter from rgthree-comfy](https://github.com/rgthree/rgthree-comfy).
