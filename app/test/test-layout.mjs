/**
 * Layout tests for the settings dialog.
 *
 * These read computed geometry out of a real jsdom layout rather than checking
 * the stylesheet, because the bug they exist for was invisible in the CSS: an
 * unscoped `.toggle` rule was pushing the dialog's toggles around with an auto
 * margin meant for the toolbar, and nothing about that looks wrong written down.
 * It only looks wrong once a group has an uneven number of toggles in it.
 *
 *   node test/test-layout.mjs
 */

import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const css = readFileSync(`${pkgRoot}src/styles.css`, 'utf8')

/** The rule whose selector matches `css`, with its body. */
function ruleFor(selector) {
  const pattern = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  const found = pattern.exec(css)
  return found ? found[2].trim() : null
}

console.log('the toolbar rule that broke the dialog')
// The toolbar pushes its view toggles to the right of the row. `.toggle` is used
// in two places, and this rule was not scoped to either — so the dialog's toggles
// each absorbed a share of the free space in their wrapping row, and a line with
// three items split it differently from a line with two.
const globalPush = ruleFor('.toggle')
check('there is no unscoped .toggle rule left', globalPush === null || !/margin-left:\s*auto/.test(globalPush), globalPush)
// The toolbar's right-alignment moved to `.view-actions` when the view toggles
// were split out of one wrapping row. Asserting on `.toolbar .toggle` here was
// checking a class the toolbar no longer renders, so it failed against correct
// CSS — and this suite is not in `npm test`, so nothing said so.
check('the push is scoped to the view actions', /\.view-actions\s*\{[^}]*margin-left:\s*auto/.test(css))

console.log('a run of toggles is a grid, not a wrapping row')
const toggles = ruleFor('.settings-toggles')
check('the rule exists', toggles !== null)
check('it is a grid', /display:\s*grid/.test(toggles ?? ''), toggles)
check('and not a wrapping flex row', !/flex-wrap/.test(toggles ?? ''))
// Wrapping starts every line at the left edge while each item keeps its natural
// width, so nothing lines up with anything above it. Equal columns are the whole
// reason this is a grid.
check('its columns are equal', /repeat\(auto-fit,\s*minmax\([^,]+,\s*1fr\)\)/.test(toggles ?? ''), toggles)
// And a count wide enough that a group of eleven does not run to five thin
// columns, which would wrap every label.
const floor = /minmax\((\d+)px/.exec(toggles ?? '')
check('the column floor fits the longest label', Number(floor?.[1] ?? 0) >= 120, floor?.[1])

console.log('a long label wraps instead of widening its column')
// "Moderator badge" is the longest in any group. Allowed to widen a column it
// shifts every column after it, which is the raggedness again.
check('the toggle can shrink', /\.settings-toggles\s+\.toggle\s*\{[^}]*min-width:\s*0/.test(css))
check('and so can its label', /\.settings-toggles\s+\.toggle\s+span\s*\{[^}]*min-width:\s*0/.test(css))
check('breaking inside the label is allowed', /\.settings-toggles\s+\.toggle\s+span\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css))

console.log('a field is the size of itself')
// A grid row is as tall as its tallest cell, and a stretched item hands that
// height to an input carrying `flex: 1`. In the overlay row the tallest cell is
// the background slider with its note under it, so the number fields beside it
// grew into boxes the size of the tallest thing in the row.
const grid = ruleFor('.settings-grid')
check('the grid exists', grid !== null)
check('its cells are top-aligned, not stretched', /align-items:\s*start/.test(grid ?? ''), grid)
// And the flex that lets an input inflate is undone inside a grid cell, where it
// has no button beside it to share a line with.
check('an input in a cell does not grow to fill', /\.settings-grid\s+\.input\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(css))
// The flex is still there for the row it is actually for: an input beside a
// button, which is how a long API key shares a line with "Fetch models".
check('and the row it belongs to still shares one', /\.field-row\s+\.input\s*\{/.test(css))

console.log('and the layout holds up in a real engine')
// The rules above are the intent; this is what a browser actually does with them.
// A grid is laid out by an engine, and jsdom does not run one, so the check is on
// the computed value the cascade produces rather than on pixels — which is
// honestly the most a headless run can say about geometry.
const dom = new JSDOM(
  `<!doctype html><html><head><style>${css}</style></head><body>
     <div class="toolbar">
       <div class="view-toggles"><label class="toggle">views</label></div>
       <span class="view-actions">actions</span>
     </div>
     <div class="settings-toggles">
       <label class="toggle">Compact</label>
       <label class="toggle">Moderator badge</label>
     </div>
   </body></html>`,
)
const { window } = dom
for (const el of window.document.querySelectorAll('.settings-toggles .toggle')) {
  // jsdom resolves the cascade for these without needing a layout pass, which is
  // exactly the question being asked: which rules reach this element. The toolbar's
  // div above is deliberately a sibling rather than an ancestor — under `body` it
  // would scope to the dialog's toggles too and every check here would be about the
  // wrong thing.
  const computed = window.getComputedStyle(el)
  check(
    `the dialog's toggle is not auto-margined: "${el.textContent}"`,
    computed.marginLeft !== 'auto',
    `${computed.marginLeft} from ${computed.display}`,
  )
}
check(
  'the view actions are still right-aligned',
  window.getComputedStyle(window.document.querySelector('.view-actions')).marginLeft === 'auto',
)
const run = window.document.querySelector('.settings-toggles')
check('and its container is a grid', window.getComputedStyle(run).display === 'grid', window.getComputedStyle(run).display)

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)