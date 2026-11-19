# Changelog

## 0.5.0 (2026-11-19)

- New **Random Prompt Picker**: a random seed and a random line from each of your text lists (files in `ComfyUI/user/default/ggtools/lists`), joined into one prompt. Freeze a list, the seed or everything to keep using what the last run used. Optional `clip` input for a `conditioning` output, and a `text` input for existing prompt text.
- Fixed: a Pipe To fed by a Crossroads Join named the entry `j0`, `j1` when the Join's value was named after its type (`image`, `mask`). It now shows the value's name. Entries in open workflows correct themselves on load.

## 0.4.2 (2026-11-19)

- Fixed: loading a workflow from a saved image (drag and drop) stopped with "Loading aborted … Cannot read properties of undefined (reading 'widget')" when it contained a Crossroads Split. The same workflow saved as a file loaded fine.
- README: how to switch which LoRA Multi-Stack group feeds the rest of the workflow by dragging one group's socket plate onto another.

## 0.4.1 (2026-11-05)

- Fixed: with frontend 1.57, a LoRA Multi-Stack pasted with Ctrl+V lost its clip outputs and the wires after the first output.
- Tested with ComfyUI 0.37 to 0.43 and frontend 1.53 to 1.57.
- The pack has an icon in the Comfy Registry and ComfyUI Manager.
- Internal change so the Comfy Registry's automated checks pass. 0.2.0 and 0.4.0 are flagged there, so Manager may have offered an older version until this release.

## 0.4.0 (2026-10-28)

- New **Crossroads Split** and **Crossroads Join**: choose by number which of several paths runs, and switch optional inputs off.
- **Boolean Fast Muter is removed**; Crossroads replaces it. Workflows that use it need rebuilding with Crossroads.
- LoRA Multi-Stack: drag a row's ⠿ grip to reorder the LoRAs.

## 0.3.0 (2026-10-27)

- LoRA Multi-Stack: each group's model and clip sockets sit on a plate under the group. Drag a plate onto another group to swap their wires.

## 0.2.0 (2026-10-27)

- New **LoRA Multi-Stack**: several LoRA stacks side by side from one LoRA list.
- Search terms and descriptions for the nodes in the node search and library.

## 0.1.0 (2026-10-26)

- First release: Pipe To, Pipe From and Boolean Fast Muter.
