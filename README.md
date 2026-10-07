# Lorebook Check

[한국어 가이드](README.ko.md)

Find SillyTavern lorebook entries that are switched on but never actually reach the prompt.
It scans every lorebook and shows **outlets with no macro, closed markers, and settings that can never fire** on one screen,
with buttons sized for a phone.

## Install

Extensions (puzzle icon) → **Install Extension** → paste this repository URL → **Install**.
Open it from the wand menu → **Lorebook Check** (shown as 로어북 점검), or with `/lorebookcheck`.

## What it finds

The top shows the current Chat Completion preset and a summary. Tick **only lorebooks attached to this chat**
to limit the scan to global, character, chat and persona lorebooks.

- **Outlet not injected** — the entry's position is Outlet but the preset has no `{{outlet::name}}`, so it is dropped even when it fires.
  Macros that differ only in case or spacing are pointed out.
- **Exit closed**
  - Outlet: `{{outlet::name}}` only appears in disabled prompts.
  - ↑Char / ↓Char: the World Info (before) / (after) marker is disabled in the preset.
  - ↑EM / ↓EM: the Chat Examples marker is disabled, or **Never include examples** is on.
  - ↑AN / ↓AN: this chat's Author's Note frequency is 0.
- **Never fires**
  - No keys on a non-constant entry (entries with `@@activate` or vector activation are skipped).
  - Empty content.
  - Probability enabled at 0%.
  - A `/…/` key that is not a valid regex, so it is matched as literal text (the broken keys are listed).
  - Outlet position with an empty outlet name.
- **Empty exit** — the preset has `{{outlet::name}}` but no enabled entry uses that name.
- **Note** — Author's Note frequency above 1, so ↑AN/↓AN entries only go in on those turns.
- **Connected outlets** — fine, collapsed.

Each entry shows its lorebook, position and where it is attached. The ✏️ button opens the lorebook editor and highlights the entry.

## Notes

- Preset checks use the **Chat Completion** preset. A notice appears when another API is selected.
- The extension only reads lorebooks, presets and chats, and stores nothing. Removing it leaves no data behind.
