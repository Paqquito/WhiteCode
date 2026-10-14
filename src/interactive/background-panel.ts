// Implements: SPEC-IHM-028 (CA-01/02, EF-01/02), gap E-148.
// Supports: SPEC-AGT-024 (CA-01, monitor event count and latest event), gap E-166.
// Implements: SPEC-AGT-023 (CA-01, workflow → steps → agents), gap E-169.
import type { BackgroundTasks, BackgroundTask } from "../engine/background";
import type { InteractiveApp } from "./app";
import { maskSecrets } from "../shared/secrets";

const state = (task: BackgroundTask) => ({ running: "en cours", completed: "terminée", failed: "en échec", stopped: "arrêtée", timed_out: "délai dépassé", rate_limited: "débit dépassé" })[task.status];
const label = (task: BackgroundTask) => `${task.id} — ${task.kind === "agent" ? "agent" : task.kind === "monitor" ? "surveillance" : task.kind === "workflow" ? "flux" : "commande"} — ${state(task)} — ${maskSecrets(task.description)}`;
const detail = (task: BackgroundTask) => `${task.kind === "monitor" ? `${task.eventCount ?? 0} événements${task.lastEvent ? ` · ${maskSecrets(task.lastEvent).slice(0, 200)}` : ""} · ` : ""}${Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)} s${task.activity ? ` · ${task.activity} · ${task.toolCalls ?? 0} outils · ${task.tokens ?? 0} jetons` : ""}${task.summary ? `\n${maskSecrets(task.summary)}` : ""}${task.workflowSteps?.map(step => `\n  ├ ${step.id}: ${step.state}${step.agents.map(agent => `\n  │  └ ${agent.id}: ${agent.status}`).join("")}`).join("") ?? ""}`;

/** Dialogs are passive: an incoming permission request takes priority and closes the panel. */
export async function openBackgroundPanel(app: InteractiveApp, background: BackgroundTasks): Promise<void> {
  if (background.tasks.length === 0) { app.notice("info", "Aucune tâche de fond."); return; }
  const options: Array<{ label: string; description: string }> = [];
  const refresh = () => {
    options.splice(0, options.length, ...background.tasks.map(task => ({ label: label(task), description: detail(task) })));
    app.refresh();
  };
  refresh();
  const unsubscribe = background.onChange(refresh), timer = setInterval(refresh, 250);
  let selected;
  try { selected = await app.choose("Tâches de fond — choisir", options, { other: false, interruptible: true }); }
  finally { clearInterval(timer); unsubscribe(); }
  if (selected.kind !== "options") return;
  const task = background.get(selected.labels[0]!.split(" ")[0]!);
  if (!task) return;
  const actions = [
    { label: "Fermer le détail", description: maskSecrets(background.tail(task.id, 2000)) || "Aucune sortie." },
    ...(task.status === "running" ? [{ label: "Arrêter la tâche", description: "Arrête aussi ses processus descendants." }] : []),
  ];
  const update = () => {
    actions[0]!.description = `${state(task)} · ${detail(task)}\n${maskSecrets(background.tail(task.id, 2000)) || "Aucune sortie."}`;
    actions.splice(2, actions.length, ...(task.workflowSteps?.flatMap(step => step.agents.filter(agent => agent.status === "running").map(agent => ({ label: `Arrêter l’agent ${agent.id}`, description: `Étape ${step.id} ; arrête aussi ses descendants.` }))) ?? [])); app.refresh();
  };
  update();
  const stopUpdates = background.onChange(update), detailTimer = setInterval(update, 250);
  let action;
  try { action = await app.choose(`Détail de ${task.id}`, actions, { other: false, interruptible: true }); }
  finally { clearInterval(detailTimer); stopUpdates(); }
  if (action.kind !== "options" || task.status !== "running") return;
  if (action.labels[0]?.startsWith("Arrêter l’agent ")) {
    const id = action.labels[0].slice("Arrêter l’agent ".length);
    if (!(await app.confirm(`Arrêter l’agent ${id} et ses descendants ?`, "arrêter", "continuer", true))) return;
    const stopped = await background.stopWorkflowAgent(task.id, id); app.notice("info", stopped ? `Agent ${id} arrêté.` : `Agent ${id} déjà terminé.`); return;
  }
  if (action.labels[0] !== "Arrêter la tâche") return;
  if (!(await app.confirm(`Arrêter la tâche ${task.id} et ses processus descendants ?`, "arrêter", "continuer", true))) return;
  const stopped = await background.stop(task.id);
  app.notice("info", stopped ? `Tâche ${task.id} arrêtée.` : `Tâche ${task.id} déjà terminée.`);
}
