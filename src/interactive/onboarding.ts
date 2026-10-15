// Implements: SPEC-IHM-026/CA-01 (durable checkpoints after each completed welcome step), gap E-198.
export type WelcomeStep =
  | "theme"
  | "connection"
  | "safety"
  | "terminal"
  | "trust"
  | "done";
export async function welcomeSteps(o: {
  step?: WelcomeStep;
  signal: AbortSignal;
  save: (step: WelcomeStep) => Promise<void>;
  theme: () => Promise<boolean>;
  connected: () => Promise<boolean>;
  connect: () => Promise<boolean>;
  safety: () => Promise<boolean>;
  terminal: () => Promise<void>;
}): Promise<boolean> {
  let step = o.step ?? "theme";
  const advance = async (next: WelcomeStep) => {
    o.signal.throwIfAborted();
    await o.save(next);
    step = next;
  };
  if (step === "done" || step === "trust") return true;
  o.signal.throwIfAborted();
  if (step === "theme") {
    if (!(await o.theme())) return false;
    await advance("connection");
  }
  if (step === "connection") {
    if (!(await o.connected()) && !(await o.connect())) return false;
    await advance("safety");
  }
  if (step === "safety") {
    if (!(await o.safety())) return false;
    await advance("terminal");
  }
  if (step === "terminal") {
    await o.terminal();
    await advance("trust");
  }
  return true;
}
