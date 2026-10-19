/** Scratch probe: debug the handle input → connect button path. */
import { fakeTransport, flush, installDom, loadApp } from '../test/dom.mjs'

process.env.NODE_ENV = 'development'
const { entry } = await loadApp()
const { App, setTransport } = await import(entry)

const harness = installDom()
const media = harness.dom.window.HTMLMediaElement.prototype
media.play = () => Promise.resolve()
media.pause = () => {}
globalThis.IntersectionObserver ??= class {
  constructor(callback) { this.callback = callback }
  observe(target) { this.callback([{ isIntersecting: true, target }]) }
  unobserve() {} disconnect() {}
}
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = React

const fake = fakeTransport({
  webhook_config_get: { enabled: false, url: '', token: '' },
  webhook_test: 'Sent.',
  speak: 'QUFBQQ==',
})
setTransport(fake.transport)

const root = createRoot(harness.container)
await act(async () => { root.render(React.createElement(App)) })
await flush()

const doc = harness.dom.window.document
const $ = (s) => doc.querySelector(s)
const $$ = (s) => [...doc.querySelectorAll(s)]

const el = $('input.handle-input')
console.log('input found:', Boolean(el), el?.outerHTML?.slice(0, 300))
const setter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLInputElement.prototype, 'value').set
await act(async () => {
  setter.call(el, '@mybasic.indonesia')
  el.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
})
await flush()
console.log('value after type:', el.value)
const btn = $('.room-row .btn-primary')
console.log('button disabled:', btn?.disabled, btn?.textContent)
console.log('room-row html:', $('.room-row')?.outerHTML?.slice(0, 1200))
console.log('commands:', JSON.stringify(fake.commands.map((c) => c.command)))
harness.restore()
