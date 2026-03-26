import { afterEach } from 'vitest';

const PAUSED_STATE = Symbol('paused-state');

if (typeof HTMLMediaElement !== 'undefined') {
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get() {
      return (this as HTMLMediaElement & { [PAUSED_STATE]?: boolean })[PAUSED_STATE] ?? true;
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    value() {
      (this as HTMLMediaElement & { [PAUSED_STATE]?: boolean })[PAUSED_STATE] = true;
      return undefined;
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value() {
      (this as HTMLMediaElement & { [PAUSED_STATE]?: boolean })[PAUSED_STATE] = true;
      return undefined;
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value() {
      (this as HTMLMediaElement & { [PAUSED_STATE]?: boolean })[PAUSED_STATE] = false;
      return Promise.resolve();
    },
  });
}

if (typeof HTMLDialogElement !== 'undefined') {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', 'true');
    },
  });

  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});
