import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { Host } from "./helpers/control";
import { workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import {
  FileDeliveryReceiver,
  fileCardHtml,
  type DeliveredFile,
} from "../src/control/file-delivery";
import {
  openBrowserPipe,
  browserExecutable,
} from "../src/platform/browser-pipe";
import { imageInfo } from "../src/tools/image-header";
const demands = [
  "approval_request",
  "confirm_escalation",
  "notify",
  "deliver_file",
];
test("SPEC-OUT-035/CA-01 — the negotiated client displays the delivered image and its caption in a real isolated browser", async () => {
  const ws = workspace(),
    png = await QRCode.toBuffer("Local artifact acceptance", { width: 96 }),
    path = join(ws.project, "diagram.png");
  writeFileSync(path, png);
  const executable = browserExecutable(productEnv(ws));
  if (!executable)
    throw Error("Native browser required for image delivery verification.");
  let card = "",
    rendered = false;
  const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response('<!doctype html><meta charset="utf-8">' + card, {
          headers: {
            "content-type": "text/html",
            "content-security-policy":
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          },
        }),
    }),
    browser = openBrowserPipe({
      executable,
      headless: true,
      env: productEnv(ws),
      event: () => {},
    });
  const receiver = new FileDeliveryReceiver(async (file) => {
    expect(file.bytes.equals(png)).toBe(true);
    card = fileCardHtml(file);
    const context = await browser.send("Target.createBrowserContext", {
        disposeOnDetach: true,
      }),
      target = await browser.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context.browserContextId,
      }),
      attached = await browser.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      }),
      session = attached.sessionId as string;
    await browser.send("Page.enable", {}, session);
    await browser.send(
      "Page.navigate",
      { url: `http://127.0.0.1:${server.port}/` },
      session,
    );
    let observed: any;
    for (let i = 0; i < 100; i++) {
      const value = await browser.send(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({ready:!!document.querySelector('img')?.complete,width:document.querySelector('img')?.naturalWidth,caption:document.querySelector('figcaption')?.textContent,images:document.images.length})",
          returnByValue: true,
        },
        session,
      );
      observed = JSON.parse(value.result.value);
      if (observed.ready && observed.width) break;
      await Bun.sleep(10);
    }
    expect(observed).toEqual({
      ready: true,
      width: 96,
      caption: "Diagram <local> & verified",
      images: 1,
    });
    const screenshot = await browser.send(
      "Page.captureScreenshot",
      { format: "png" },
      session,
    );
    expect(
      imageInfo(Buffer.from(screenshot.data, "base64"))?.width,
    ).toBeGreaterThan(0);
    rendered = true;
    await browser.send("Target.disposeBrowserContext", {
      browserContextId: context.browserContextId,
    });
  });
  const p = new ScriptedProvider([
      (request) => {
        expect(request.tools.some((t) => t.name === "deliver_file")).toBe(true);
        return {
          toolCalls: [
            {
              name: "deliver_file",
              input: {
                files: ["diagram.png"],
                status: "normal",
                mode: "render",
                caption: "Diagram <local> & verified",
              },
            },
          ],
        };
      },
      { text: "Image delivered." },
    ]),
    h = new Host(ws, {
      provider: p,
      init: { demands },
      answers: { deliver_file: (value) => receiver.receive(value) },
    });
  try {
    h.user("Deliver the diagram.");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Image delivered."),
      20000,
    );
    expect(rendered).toBe(true);
    expect(JSON.stringify(p.requests[1]!.history)).toContain(
      "1/1 file(s) delivered",
    );
  } finally {
    h.feed.end();
    await h.finish();
    receiver.close();
    await browser.close();
    server.stop(true);
  }
}, 30000);
test("SPEC-OUT-035/CA-02 — an existing multi-chunk file is delivered intact while a second absent file is reported separately", async () => {
  const ws = workspace(),
    content = "Report line\n".repeat(12000),
    path = ws.write("project/report.txt", content),
    received: DeliveredFile[] = [],
    receiver = new FileDeliveryReceiver(async (f) => {
      received.push(f);
    }),
    p = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "deliver_file",
            input: {
              files: [path, "missing.txt"],
              status: "proactive",
              mode: "attach",
              caption: "Generated report",
            },
          },
        ],
      },
      { text: "Available report sent; missing file reported." },
    ]),
    h = new Host(ws, {
      provider: p,
      argv: ["--toolset=deliver_file"],
      init: { demands },
      answers: { deliver_file: (v) => receiver.receive(v) },
    });
  try {
    h.user("Send both reports.");
    await h.waitFor((m) => m.type === "turn_completed");
    expect(received).toHaveLength(1);
    expect(received[0]!.bytes.toString()).toBe(content);
    expect(received[0]!.status).toBe("proactive");
    const history = JSON.stringify(p.requests[1]!.history);
    expect(history).toContain("1/2 file(s) delivered");
    expect(history).toContain("File not found: missing.txt");
    expect(
      h
        .demands("deliver_file")
        .filter((m) => (m["params"] as any)?.phase === "chunk").length,
    ).toBeGreaterThan(1);
    expect(fileCardHtml(received[0]!)).toContain('download="report.txt"');
  } finally {
    h.feed.end();
    await h.finish();
    receiver.close();
  }
}, 15000);
test("TECH — read denials, sensitive content and hosts without artifact support do not upload file bytes", async () => {
  for (const denied of [false, true]) {
    const ws = workspace(),
      path = ws.write(
        "project/private.txt",
        "password=fictional-sensitive-value\n",
      ),
      receiver = new FileDeliveryReceiver(async () => {
        throw Error("must not publish");
      }),
      p = new ScriptedProvider([
        {
          toolCalls: [
            {
              name: "deliver_file",
              input: { files: [path], status: "normal" },
            },
          ],
        },
        { text: "Delivery refused." },
      ]),
      h = new Host(ws, {
        provider: p,
        init: { demands },
        answers: { deliver_file: (v) => receiver.receive(v) },
        userConfig: denied ? { permissions: { denyRules: ["read_file"] } } : {},
      });
    try {
      h.user("Deliver file.");
      await h.waitFor((m) => m.type === "turn_completed");
      expect(h.demands("deliver_file")).toHaveLength(0);
    } finally {
      h.feed.end();
      await h.finish();
      receiver.close();
    }
  }
  const p = new ScriptedProvider([{ text: "No artifact client" }]),
    h = new Host(workspace(), { provider: p });
  try {
    h.user("Hello");
    await h.waitFor((m) => m.type === "turn_completed");
    expect(p.requests[0]!.tools.some((t) => t.name === "deliver_file")).toBe(
      false,
    );
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
test("TECH — a client rejects reordered chunks and digest mismatches and escapes captions before creating a card", async () => {
  const files: DeliveredFile[] = [],
    receiver = new FileDeliveryReceiver(async (f) => {
      files.push(f);
    }),
    id = randomUUID(),
    bytes = Buffer.from("file"),
    start = {
      phase: "start",
      id,
      name: "file.bin",
      caption: '<script>alert("x")</script>',
      status: "normal",
      mode: "attach",
      mediaType: "application/octet-stream",
      size: bytes.length,
      digest: createHash("sha256").update("different").digest("hex"),
    };
  expect(await receiver.receive(start)).toEqual({ accepted: true });
  expect(
    await receiver.receive({
      phase: "chunk",
      id,
      offset: 1,
      dataBase64: bytes.toString("base64"),
    }),
  ).toEqual({ accepted: false });
  await receiver.receive({
    phase: "chunk",
    id,
    offset: 0,
    dataBase64: bytes.toString("base64"),
  });
  expect(await receiver.receive({ phase: "complete", id })).toEqual({
    delivered: false,
  });
  expect(files).toEqual([]);
  expect(
    fileCardHtml({
      id,
      name: "x.html",
      caption: '<script>alert("x")</script>',
      status: "normal",
      mode: "attach",
      mediaType: "text/html",
      bytes,
    }),
  ).not.toContain("<script>");
  const oversized = await QRCode.toBuffer("Oversized header", { width: 32 });
  oversized.writeUInt32BE(9000, 16);
  const preview = {
    ...start,
    id: randomUUID(),
    name: "oversized.png",
    mode: "render",
    mediaType: "image/png",
    size: oversized.length,
    digest: createHash("sha256").update(oversized).digest("hex"),
  };
  expect(await receiver.receive(preview)).toEqual({ accepted: true });
  await receiver.receive({
    phase: "chunk",
    id: preview.id,
    offset: 0,
    dataBase64: oversized.toString("base64"),
  });
  expect(await receiver.receive({ phase: "complete", id: preview.id })).toEqual(
    { delivered: false },
  );
  expect(
    fileCardHtml({
      id: preview.id,
      name: "oversized.png",
      caption: "Oversized preview",
      status: "normal",
      mode: "render",
      mediaType: "image/png",
      bytes: oversized,
    }),
  ).not.toContain("<img");
  receiver.close();
  expect(await receiver.receive({ ...start, id: randomUUID() })).toEqual({
    accepted: false,
  });
});
