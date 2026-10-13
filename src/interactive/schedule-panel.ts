// Implements: SPEC-PLA-005 (CA-02, list, actions and passive state), gap E-152.
import type { InteractiveApp } from "./app";
import type { BackgroundTasks } from "../engine/background";
import type { Scheduler } from "../schedule/engine";
import { openBackgroundPanel } from "./background-panel";
import { maskSecrets } from "../shared/secrets";
import { describeCron } from "../schedule/cron";
export async function openTaskPanel(app: InteractiveApp, background: BackgroundTasks, schedule?: Scheduler): Promise<void> {
  if (!schedule?.list().length) return openBackgroundPanel(app, background);
  if (background.tasks.length) { const group = await app.choose("Tâches — catégorie", [{ label: "Consignes planifiées" }, { label: "Tâches de fond" }], { other: false, interruptible: true }); if (group.kind !== "options") return; if (group.labels[0] === "Tâches de fond") return openBackgroundPanel(app, background); }
  const rows: Array<{ label: string; description: string }> = [];
  const update = () => { rows.splice(0, rows.length, ...schedule.list().map(t => ({ label: `${t.id} — ${t.recurring ? "récurrent" : "unique"} — ${t.durable ? "projet" : "session"}`, description: `${t.cron} · ${describeCron(t.cron)} · prochaine : ${t.nextLocal}\n${maskSecrets(t.prompt)}` }))); app.refresh(); };
  update(); const timer = setInterval(update, 250); let selected;
  try { selected = await app.choose("Consignes planifiées — choisir", rows, { other: false, interruptible: true }); } finally { clearInterval(timer); }
  if (selected.kind !== "options") return;
  const trigger = schedule.list().find(t => t.id === selected.labels[0]?.split(" ")[0]); if (!trigger) return;
  const passive = trigger.durable && !schedule.leader;
  const action = await app.choose(passive ? "Session passive — lecture seule" : "Consigne planifiée — action", [{ label: "Fermer", description: `${trigger.cron} · ${trigger.nextLocal}` }, ...(!passive ? [{ label: "Supprimer" }, { label: "Exécuter maintenant" }] : [])], { other: false, interruptible: true });
  if (action.kind !== "options" || action.labels[0] === "Fermer") return;
  try { if (action.labels[0] === "Supprimer") { schedule.delete(trigger.id); app.notice("info", "Consigne planifiée supprimée."); } else schedule.runNow(trigger.id); } catch { app.notice("warning", "Action planifiée indisponible ; actualisez la liste."); }
}
