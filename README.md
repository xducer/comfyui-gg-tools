<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="GGTools for ComfyUI: a parent toggle controls a connection inside a subgraph. False includes the connection; true bypasses it.">
</p>

# GGTools for ComfyUI

Practical custom nodes for controlling ComfyUI workflows. **Boolean Fast Muter (ggtools)** adds Boolean control to data connections and groups of target nodes.

## Boolean Fast Muter (ggtools)

Enable or bypass a connection without rewiring your workflow. Use the local toggle, connect a Boolean control, or expose the toggle on a parent subgraph node.

The node preserves the source's connection type and output socket without converting its data. Common connection types include:

| Data | Connection types |
| --- | --- |
| Models and encoders | `MODEL`, `CLIP`, `VAE` |
| Conditioning | `CONDITIONING` |
| Latents and audio | `LATENT`, `AUDIO` |
| Images and masks | `IMAGE`, `MASK` |
| Scalar values | `INT`, `FLOAT`, `BOOLEAN`, `STRING` |

| Control | Result |
| --- | --- |
| `true` | Bypass is active: the controlled connection is omitted from the execution prompt. |
| `false` | No bypass: data passes through from the first connected target. |

New nodes default to `false`. `OPT_CONNECTION` forwards the first connected target; additional targets share the same Boolean control. It is one output, not a selector or merger for multiple values.

Outside subgraphs, target nodes update while you edit the workflow, within about 100 ms. Inside subgraphs, routing is resolved separately for each instance when the prompt is serialized. An unresolved connection type stays generic.

### Example: optional image input

This example uses an image connection; the same control applies to the other connection types above.

![Boolean Fast Muter comparison: false passes the image in the top example; true mutes the Background Image node in the bottom example.](assets/bypass-example.png)

**Top — `false`:** the source stays enabled and supplies the image. **Bottom — `true`:** the source is muted, and its connection is omitted from the queued prompt.

### Optional inputs and default values

Bypassing removes a connection when ComfyUI builds the execution prompt. This gives the receiving node an absent connection, rather than a connected source returning `None`.

What happens next depends on the receiving input:

- **Optional socket:** the receiving node can use its no-input path.
- **Widget-backed input:** it may fall back to its local value, such as a number, text, or Boolean setting.
- **Required socket without a fallback:** it still needs a value. Bypassing a required model, latent, or other input can cause `Required input is missing`.

Connection-type compatibility does not make a required input optional.

## Install

Clone into your ComfyUI `custom_nodes` directory using a GitHub account with access to this private repository:

```sh
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/xducer/comfyui-ggtools.git
```

Restart ComfyUI and refresh the browser. No extra Python packages or `pip install` step are needed.

## Connect

1. Add **Boolean Fast Muter (ggtools)** from `ggtools`.
2. Connect the output you want to control to a `target` socket. A spare socket appears for additional targets.
3. Use the `boolean` toggle or connect a Boolean control to its input socket.
4. Connect `OPT_CONNECTION` to a compatible receiving input. Outside subgraphs, the controlled source can also remain connected directly to its consumers.

Disconnecting the external Boolean returns control to the local toggle. Multiple targets can be controlled together through reroutes, collectors, or combiners. Outside subgraphs, muting a source affects all its outputs; each muter still closes its own output when its Boolean is `true`, even if another controller enables the source.

### Controlling subgraph inputs from the outside

Keep the routing inside a reusable subgraph and expose its control on the main canvas:

1. Place **Boolean Fast Muter (ggtools)** inside the subgraph.
2. Connect the incoming data to `target`, then connect `OPT_CONNECTION` to the inputs you want to control.
3. Add a Boolean input to the subgraph, for example **Bypass reference ?**, and wire it to the muter's `boolean` socket. The parent subgraph node exposes the toggle.
4. Toggle it from the main canvas: `true` omits the controlled connection; `false` includes it when queuing.

The data must pass through the muter's output; connecting only the Boolean does not control a data path. Incoming data is gated within that instance, so other uses of the parent source stay connected. Multiple instances of the same subgraph can use different toggle values.

### Supported use

- Works as a standalone frontend extension.
- The local toggle, built-in Boolean constants, Boolean primitives, and exposed parent subgraph toggles are supported. Values calculated during execution are not supported.
- Target connections can pass through reroutes, collectors, or combiners; their upstream nodes are controlled together.
- Targeting a nested subgraph also suppresses its descendants, including output nodes, within that instance. Disabling the outer bypass preserves inner controls.
- Already queued prompts are unaffected. API-only submissions do not run this frontend node.

## Update

```sh
cd /path/to/ComfyUI/custom_nodes/comfyui-ggtools
git pull --ff-only
```

Restart ComfyUI and refresh the browser after updating.

<details>
<summary>Implementation details</summary>

The pack registers its frontend files through `__init__.py`. Node behavior lives in `web/boolean_fast_muter.js`; Python runtime dependencies are empty in `pyproject.toml`, so there is no `requirements.txt`.

</details>

## Credits

Inspired by [Fast Muter from rgthree-comfy](https://github.com/rgthree/rgthree-comfy).
