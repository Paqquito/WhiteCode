// Implements: SPEC-INT-020 (CA-01/02, focus and inactivity), SPEC-OUT-036 (CA-01/02, bounded agent notifications).
// Supports: gap E-162 (local channels and session quota).
export interface NotificationReply { readonly sent: boolean; readonly reason?: string }
export interface NotificationSettings { readonly channel: string; readonly agentChannel?: string; readonly agentEnabled: boolean; readonly maxPerHour: number; readonly idleMs: number }
export class SessionNotifications {
  #focused: boolean | undefined;
  #activity: number;
  #waiting = false;
  #announced = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #sent: number[] = [];
  constructor(readonly options: { readonly settings: () => NotificationSettings; readonly send: (message: string, channel: string, signal?: AbortSignal) => Promise<boolean>; readonly now?: () => number; readonly unattended?: boolean }) {
    this.#activity = this.#now; if (options.unattended) this.#focused = false;
  }
  get #now(): number { return (this.options.now ?? Date.now)(); }
  focus(focused: boolean): void { this.#focused = focused; if (focused) this.activity(); else if (this.#waiting) void this.#permission(); }
  activity(): void { this.#activity = this.#now; if (this.#waiting && this.#focused === undefined) this.#schedule(); }
  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.#permission(); }, Math.max(1, this.#activity + this.options.settings().idleMs - this.#now));
  }
  waiting(waiting: boolean): void {
    this.#waiting = waiting;
    if (!waiting) { this.#announced = false; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }
    else void this.#permission();
  }
  async #permission(): Promise<void> {
    if (this.#closed || !this.#waiting || this.#announced || this.#focused === true) return;
    if (this.#focused === undefined && this.#now - this.#activity < this.options.settings().idleMs) { this.#schedule(); return; }
    this.#announced = true;
    try { const channel = this.options.settings().channel; if (!["disabled", "désactivé"].includes(channel)) await this.options.send("Une autorisation attend votre décision.", channel); } catch { /* unavailable channels never break the pending decision */ }
  }
  async notify(message: string, signal?: AbortSignal): Promise<NotificationReply> {
    signal?.throwIfAborted(); const settings = this.options.settings();
    if (this.#closed || !settings.agentEnabled || ["disabled", "désactivé"].includes(settings.channel)) return { sent: false, reason: "disabled" };
    if (this.#focused === true || this.#focused === undefined && this.#now - this.#activity < settings.idleMs) return { sent: false, reason: "user has focus" };
    const now = this.#now;
    while (this.#sent.length && this.#sent[0]! <= now - 3_600_000) this.#sent.shift();
    if (this.#sent.length >= settings.maxPerHour) return { sent: false, reason: "hourly limit" };
    this.#sent.push(now);
    try { return await this.options.send(message, settings.agentChannel ?? settings.channel, signal) ? { sent: true } : { sent: false, reason: "channel unavailable" }; }
    catch { return { sent: false, reason: "channel unavailable" }; }
  }
  close(): void { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }
}
