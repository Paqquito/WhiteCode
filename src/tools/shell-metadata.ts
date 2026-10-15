// Supports: SPEC-OUT-008/009 (working directory), SPEC-SES-001 (no clear temporary state), gap E-181.
/** A random per-invocation marker carries the working directory over the existing output pipe. */
export class ShellMetadataStream {
  #buffer = "";
  #discard = false;
  readonly #prefix: string;
  constructor(
    nonce: string,
    readonly receive: (path: string) => void,
  ) {
    this.#prefix = "\x1e" + nonce + ":";
  }
  push(text: string, final = false): string {
    this.#buffer += text;
    let shown = "";
    for (;;) {
      if (this.#discard) {
        const end = this.#buffer.indexOf("\x1f");
        if (end < 0) {
          this.#buffer = "";
          return shown;
        }
        this.#buffer = this.#buffer.slice(end + 1);
        this.#discard = false;
      }
      const at = this.#buffer.indexOf(this.#prefix);
      if (at < 0) {
        let keep = 0;
        if (!final)
          for (
            let n = 1;
            n < this.#prefix.length && n <= this.#buffer.length;
            n++
          )
            if (this.#prefix.startsWith(this.#buffer.slice(-n))) keep = n;
        shown += this.#buffer.slice(0, this.#buffer.length - keep);
        this.#buffer = keep ? this.#buffer.slice(-keep) : "";
        return shown;
      }
      shown += this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at);
      const end = this.#buffer.indexOf("\x1f", this.#prefix.length);
      if (end >= 0) {
        const path = this.#buffer.slice(this.#prefix.length, end);
        if (path.length <= 8192 && !path.includes("\0")) this.receive(path);
        this.#buffer = this.#buffer.slice(end + 1);
        continue;
      }
      if (final) {
        this.#buffer = "";
        return shown;
      }
      if (this.#buffer.length > 8192 + this.#prefix.length) {
        this.#buffer = "";
        this.#discard = true;
      }
      return shown;
    }
  }
}
