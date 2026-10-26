/**
 * Debounced trigger: waits a set delay after a message settles before asking
 * the picker. Every swipe, edit, regeneration or new message restarts it, so
 * only the message that sticks around fires the toys.
 */
export class Scheduler {
    /**
     * @param {object} opts
     * @param {() => number} opts.getDelayMs
     * @param {(messageId: number) => void} opts.onFire
     * @param {(fn: Function, ms: number) => any} [opts.setTimer]
     * @param {(handle: any) => void} [opts.clearTimer]
     */
    constructor({ getDelayMs, onFire, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle) }) {
        this.getDelayMs = getDelayMs;
        this.onFire = onFire;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.timer = null;
        this.messageId = null;
    }

    get pending() {
        return this.timer !== null;
    }

    schedule(messageId) {
        this.cancel();
        this.messageId = messageId;
        this.timer = this.setTimer(() => {
            this.timer = null;
            this.onFire(messageId);
        }, Math.max(0, this.getDelayMs()));
    }

    cancel() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
        this.messageId = null;
    }
}
