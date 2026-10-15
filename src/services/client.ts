// Implements: SPEC-MOD-022 (history and pending permissions on attachment), SPEC-PER-001 (human answers remain bounded).
import type { StandardStreams } from "../platform/io";
import type { ResidentEndpoint } from "./supervisor";
import { residentRequest } from "./transport";
import { authDialog } from "../interactive/auth-dialog";
import { KeyParser } from "../ui/keys";
import { sanitize } from "../ui/text";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export async function attachResident(options: {
  endpoint: ResidentEndpoint;
  id: string;
  streams: StandardStreams;
  signal?: AbortSignal;
}): Promise<void> {
  const terminal = options.streams.terminal;
  if (!terminal || !options.streams.stdinIsTTY || !options.streams.stdoutIsTTY)
    throw Error("Le rattachement exige un terminal interactif.");
  const lifetime = new AbortController(),
    signal = options.signal
      ? AbortSignal.any([options.signal, lifetime.signal])
      : lifetime.signal;
  const route = "/workers/" + options.id;
  const call = (action: string, body: unknown) =>
    residentRequest(
      options.endpoint,
      route + "/" + action,
      body,
      AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    );
  const initial = await call("attach", {}),
    client = initial["client"];
  if (typeof client !== "string") throw Error("Rattachement invalide.");
  let after = typeof initial["after"] === "number" ? initial["after"] : 0,
    draft = "",
    dialog = false,
    heartbeatPending = false,
    partial = false,
    dialogId: string | undefined,
    dialogAbort: AbortController | undefined;
  const handled = new Set<string>();
  let unlisten = () => {};
  const show = (value: string) =>
    terminal.write(sanitize(value).replaceAll("\n", "\r\n"));
  const draw = () => show("\n› " + draft);
  const input = () => {
    const parser = new KeyParser();
    return terminal.onInput((data) => {
      if (dialog || signal.aborted) return;
      for (const event of parser.feed(data)) {
        if (event.kind === "paste") {
          if (draft.length + event.text.length <= 65536) {
            draft += event.text;
            show(event.text);
          }
          continue;
        }
        if (event.kind !== "key") continue;
        if (event.phase === "release") continue;
        if (event.ctrl && event.name === "d") {
          lifetime.abort();
          return;
        }
        if (event.ctrl && event.name === "c") {
          void call("cancel", {}).catch(() => lifetime.abort());
          continue;
        }
        if (event.name === "enter") {
          const text = draft;
          draft = "";
          if (text.trim())
            void call("message", { text }).catch((error) =>
              show("\n" + (error as Error).message),
            );
          draw();
          continue;
        }
        if (event.name === "backspace") {
          if (draft) {
            draft = [...draft].slice(0, -1).join("");
            terminal.write("\b \b");
          }
          continue;
        }
        if (event.text && draft.length + event.text.length <= 65536) {
          draft += event.text;
          show(event.text);
        }
      }
    });
  };
  const restore = () => {
    terminal.write("\u001b[?2004l");
    terminal.setRawMode(false);
  };
  const exit = terminal.onProcessExit(() => {
    lifetime.abort();
    restore();
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    terminal.setRawMode(true);
    terminal.write("\u001b[?2004h");
    unlisten = input();
    show(
      "Session rattachée · Ctrl+D : détacher · Ctrl+C : interrompre le tour\n",
    );
    const displayHistory = (value: unknown) => {
      for (const line of Array.isArray(value) ? value : [])
        if (object(line) && typeof line["text"] === "string")
          show(
            `${line["continued"] === true ? "" : line["role"] === "user" ? "Vous : " : "Agent : "}${line["text"].replace(/^\[accepted-event:[a-f0-9-]+\]\n/, "")}\n`,
          );
    };
    displayHistory(initial["history"]);
    let offset = Array.isArray(initial["history"])
      ? initial["history"].length
      : 0;
    while (offset < Number(initial["historyTotal"] ?? 0) && !signal.aborted) {
      const page = await call("history", { client, offset });
      if (!Array.isArray(page["history"]) || !page["history"].length) break;
      displayHistory(page["history"]);
      offset += page["history"].length;
    }
    draw();
    heartbeat = setInterval(() => {
      if (heartbeatPending || signal.aborted) return;
      heartbeatPending = true;
      void call("events", { client, after })
        .then((value) => {
          if (
            dialogId &&
            Array.isArray(value["approvals"]) &&
            !value["approvals"].some(
              (item) => object(item) && item["id"] === dialogId,
            )
          )
            dialogAbort?.abort();
        })
        .catch(() => lifetime.abort())
        .finally(() => {
          heartbeatPending = false;
        });
    }, 5000);
    const approvals = async (value: unknown) => {
      for (const raw of Array.isArray(value) ? value : []) {
        if (
          !object(raw) ||
          typeof raw["id"] !== "string" ||
          handled.has(raw["id"]) ||
          typeof raw["expiresAt"] !== "number"
        )
          continue;
        const id = raw["id"],
          remaining = raw["expiresAt"] - Date.now();
        handled.add(id);
        if (handled.size > 1000) handled.delete(handled.values().next().value!);
        if (remaining <= 0) continue;
        const params = object(raw["params"]) ? raw["params"] : {};
        dialog = true;
        dialogId = id;
        dialogAbort = new AbortController();
        unlisten();
        let answer: string | boolean | undefined;
        const preview = JSON.stringify(params, null, 2);
        try {
          answer = await authDialog(
            terminal,
            "Autorisation de la session détachée\n" +
              preview.slice(0, 16384) +
              (preview.length > 16384
                ? "\nAperçu tronqué ; refusez pour examiner le fichier avant de recommencer."
                : ""),
            false,
            AbortSignal.any([
              signal,
              dialogAbort.signal,
              AbortSignal.timeout(Math.min(86400000, remaining)),
            ]),
          );
        } finally {
          dialog = false;
          dialogId = undefined;
          dialogAbort = undefined;
          if (!signal.aborted) {
            terminal.setRawMode(true);
            terminal.write("\u001b[?2004h");
            unlisten = input();
            draw();
          }
        }
        if (!signal.aborted) {
          const result = await call("answer", {
            client,
            id,
            approved: answer === true,
          });
          if (result["accepted"] !== true)
            show("\nCette demande est expirée ou déjà résolue.\n");
        }
      }
    };
    await approvals(initial["approvals"]);
    while (!signal.aborted) {
      const update = await call("events", { client, after });
      for (const item of Array.isArray(update["events"])
        ? update["events"]
        : []) {
        if (
          !object(item) ||
          typeof item["sequence"] !== "number" ||
          !object(item["event"])
        )
          continue;
        after = Math.max(after, item["sequence"]);
        const event = item["event"];
        if (
          event["type"] === "assistant" &&
          typeof event["content"] === "string"
        ) {
          if (event["partial"] === true) {
            show(event["content"]);
            partial = true;
          } else {
            if (!partial) show(event["content"]);
            show("\n");
            partial = false;
          }
        } else if (
          event["type"] === "addressed_message" &&
          typeof event["content"] === "string"
        )
          show("\n" + event["content"] + "\n");
        else if (
          event["type"] === "tool_call" &&
          typeof event["toolId"] === "string"
        )
          show("\nOutil : " + event["toolId"] + "\n");
        else if (
          event["type"] === "error" &&
          typeof event["message"] === "string"
        )
          show("\n" + event["message"] + "\n");
      }
      await approvals(update["approvals"]);
      const worker = object(update["worker"]) ? update["worker"] : undefined;
      if (
        worker &&
        ["completed", "stopped", "error"].includes(String(worker["status"]))
      ) {
        show("\nSession : " + String(worker["status"]) + "\n");
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 200);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearInterval(heartbeat);
    unlisten();
    exit();
    restore();
    lifetime.abort();
    await residentRequest(
      options.endpoint,
      route + "/detach",
      { client },
      AbortSignal.timeout(1000),
    ).catch(() => {});
  }
}
