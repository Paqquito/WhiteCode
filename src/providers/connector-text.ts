// Implements: SPEC-MOT-035 (bounded, type-consistent signed connector blocks under an explicit v1 contract).
export interface ConnectorTextBlock {
  readonly type: "connector_text";
  readonly text: string;
  readonly summary?: string;
  readonly signature: string;
  readonly connector?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Opaque signatures are retained, not interpreted as an authorization or executed. */
export class ConnectorTextStream {
  readonly #pending = new Map<number, { text: string; summary?: string; signature?: string; connector?: string; completed?: boolean; invalid?: boolean }>();
  #bytes = 0;
  incidents = 0;
  fragment(value: unknown): void {
    if (!object(value) || !Number.isSafeInteger(value.index) || Number(value.index) < 0 || Number(value.index) >= 64) { this.incidents++; return; }
    const index = Number(value.index), state = this.#pending.get(index) ?? { text: "" };
    this.#pending.set(index, state);
    if (state.invalid) return;
    const reject = () => { state.invalid = true; state.text = ""; state.signature = undefined; this.incidents++; };
    if (state.completed || value.type !== "connector_text" || Object.keys(value).some(key => !["index", "type", "text", "summary", "signature", "connector", "complete"].includes(key)) || value.complete !== undefined && value.complete !== true) { reject(); return; }
    for (const key of ["text", "summary", "signature", "connector"] as const) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "string" || (key === "signature" && (!value[key].length || value[key].length > 16384)) || (key === "connector" && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value[key]))) { reject(); return; }
      this.#bytes += Buffer.byteLength(value[key]);
      if (this.#bytes > 1024 * 1024) { reject(); return; }
      if (key === "text") state.text += value[key];
      else if (state[key] !== undefined) { reject(); return; }
      else state[key] = value[key];
    }
    if (value.complete === true) {
      if (!state.signature) { reject(); return; }
      state.completed = true;
    }
  }
  finish(): readonly ConnectorTextBlock[] {
    const blocks: ConnectorTextBlock[] = [];
    for (const [, state] of [...this.#pending].sort(([a], [b]) => a - b)) {
      if (state.invalid) continue;
      if (!state.completed || !state.signature) { this.incidents++; continue; }
      blocks.push({ type: "connector_text", text: state.text, ...(state.summary === undefined ? {} : { summary: state.summary }), signature: state.signature, ...(state.connector === undefined ? {} : { connector: state.connector }) });
    }
    return blocks;
  }
}

/** Presentation reads are validated separately; the provider-native signed record remains untouched. */
export function connectorTextBlocks(content: unknown): readonly ConnectorTextBlock[] {
  if (!object(content) || !Array.isArray(content.connector_text_blocks) || content.connector_text_blocks.length > 64) return [];
  const stream = new ConnectorTextStream();
  content.connector_text_blocks.forEach((block, index) => { if (object(block)) stream.fragment({ ...block, index, complete: true }); });
  return stream.finish();
}
