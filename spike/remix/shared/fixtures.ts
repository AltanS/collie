// 20 real terminal captures from Collie's own fixture set (read-only, byte-faithful ANSI text).
// Each one is a lazy chunk, so the route that shows it loads it like a bridge read would.
const loaders = import.meta.glob<string>(
  [
    '../../../web/src/fixtures/panes/omp--v18-4-approval-write-long.txt',
    '../../../web/src/fixtures/panes/omp--v18-4-ask-multi.txt',
    '../../../web/src/fixtures/panes/omp--v18-4-ask-multi-checked.txt',
    '../../../web/src/fixtures/panes/grok--plan-approval.txt',
    '../../../web/src/fixtures/panes/grok--plan-tab-prompt.txt',
    '../../../web/src/fixtures/panes/oc--draft-tree-glyphs.txt',
    '../../../web/src/fixtures/panes/oc--command-palette-query.txt',
    '../../../web/src/fixtures/panes/oc--question--single--overlay.txt',
    '../../../web/src/fixtures/panes/codex--draft-wrapped.txt',
    '../../../web/src/fixtures/panes/codex--ask-notes-focused.txt',
    '../../../web/src/fixtures/panes/codex--ask-wizard-q2.txt',
    '../../../web/src/fixtures/panes/claude--menu-effort-slider--w80-ultracode.txt',
    '../../../web/src/fixtures/panes/claude--workflow-view.txt',
    '../../../web/src/fixtures/panes/claude--menu-effort-slider.txt',
    '../../../web/src/fixtures/panes/claude-lab--menu-config-panel--w82.txt',
    '../../../web/src/fixtures/panes/claude-lab--menu-model-picker--w82.txt',
    '../../../web/src/fixtures/panes/muse--tasks-popup-approval.txt',
    '../../../web/src/fixtures/panes/muse--quoted-dialogs-bare.txt',
    '../../../web/src/fixtures/panes/agy--plan-approval.txt',
    '../../../web/src/fixtures/panes/agy--permission-edit.txt',
  ],
  { query: '?raw', import: 'default' },
)

export interface FakePane {
  id: string
  name: string
  harness: string
  load: () => Promise<string>
}

export const panes: FakePane[] = Object.keys(loaders).map((key, i) => {
  let name = key.split('/').pop()!.replace(/\.txt$/, '')
  return { id: String(i + 1), name, harness: name.split('--')[0]!, load: loaders[key]! }
})

export function findPane(id: string): FakePane | undefined {
  return panes.find((p) => p.id === id)
}
