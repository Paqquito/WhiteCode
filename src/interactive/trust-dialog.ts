// Implements: SPEC-PER-016 (§ 5.3 steps 2 to 4, FA-03, EF-03)
// The trust question, asked on the terminal before the session is composed, so that nothing of the project runs before
// the answer (EF-01). It lists the active elements of the project; the safe answer is the default.

import type { Terminal } from "../platform/terminal";
import { KeyParser } from "../ui/keys";

export type TrustAnswer = "trust" | "restricted" | "quit";

const CHOICES: ReadonlyArray<{ readonly answer: TrustAnswer; readonly label: string }> = [
  { answer: "restricted", label: "Continuer en mode restreint, sans aucun élément actif du projet" },
  { answer: "trust", label: "Faire confiance à ce dossier et charger ses éléments" },
  { answer: "quit", label: "Quitter" },
];

export function askTrust(terminal: Terminal, folder: string, inventory: readonly string[], broad: boolean): Promise<TrustAnswer> {
  return new Promise((resolve) => {
    const parser = new KeyParser();
    let selected = 0;
    let lines = 0;
    const draw = () => {
      // The previous drawing is erased, then written again in place.
      if (lines > 0) terminal.write(`\u001b[${lines}F\u001b[J`);
      const out = [
        `Ce dossier n'a pas encore été évalué : ${folder}`,
        ...(broad ? ["Attention : il s'agit de votre dossier personnel ou d'une racine ; lui faire confiance couvre tout ce qu'il contient."] : []),
        "Il contient des éléments capables d'exécuter du code ou d'élargir les permissions :",
        ...inventory.map((l) => `  · ${l}`),
        "",
        ...CHOICES.map((c, i) => `${i === selected ? "❯" : " "} ${i + 1}. ${c.label}`),
        "(flèches et Entrée, ou 1, 2, 3)",
      ];
      terminal.write(`${out.join("\r\n")}\r\n`);
      lines = out.length;
    };
    terminal.setRawMode(true);
    const finish = (answer: TrustAnswer) => {
      unsubscribe();
      terminal.setRawMode(false);
      resolve(answer);
    };
    const unsubscribe = terminal.onInput((data) => {
      for (const e of parser.feed(data)) {
        if (e.kind !== "key") continue;
        if(e.phase==="release")continue;
        if (e.ctrl && (e.name === "c" || e.name === "d")) return finish("quit");
        if (e.name === "up") selected = (selected + CHOICES.length - 1) % CHOICES.length;
        else if (e.name === "down") selected = (selected + 1) % CHOICES.length;
        else if (e.name === "enter") return finish(CHOICES[selected]!.answer);
        else if (e.name === "escape") return finish("restricted");
        else if (/^[1-3]$/.test(e.name)) return finish(CHOICES[Number(e.name) - 1]!.answer);
        else continue;
        draw();
      }
    });
    draw();
  });
}
