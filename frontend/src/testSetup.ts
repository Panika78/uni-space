import '@testing-library/jest-dom/vitest'

// jsdom has no native dialog top layer; Chromium tests verify real modality/focus.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
    this.querySelector<HTMLElement>('[autofocus]')?.focus()
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
}
