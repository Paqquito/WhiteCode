import { interactive, KEY, sleep } from "../helpers/interactive";
import { workspace, loadIdentity } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { Identity } from "../../src/identity/identity";
import { officialName } from "../../src/extensions/official";
import { reviewYear } from "../../src/interactive/year-review";
function check(v: unknown, m: string): asserts v {
  if (!v) throw Error(m);
}
const original = loadIdentity(),
  identity = new Identity({
    ...original.resolved,
    values: {
      ...original.resolved.values,
      SERVICE_MARKETPLACE: {
        value: "https://official.example.test/catalog",
        origin: "provided",
      },
    },
  }),
  year = reviewYear(new Date()),
  months = [new Date().getMonth() + 1];
const stopMissing = new AbortController(),
  stopWatch = new AbortController(),
  stopDisabled = new AbortController();
const ws = workspace(),
  p = new ScriptedProvider([]),
  missing = interactive([], ws, {
    identity,
    signal: stopMissing.signal,
    provider: p,
    userConfig: { ui: { yearInReview: { enabled: true, months } } },
  });
try {
  await missing.idle();
  missing.type("/year-review generate\r");
  await missing.waitFor((t) =>
    t.includes("Installer l’extension officielle year-review"),
  );
  check(!p.requests.length, "Generation before installation consent");
  await sleep(380);
  missing.type("n");
  await missing.waitFor((t) => t.includes("Installation non confirmée"));
  check(!p.requests.length, "Declined installation generated");
} finally {
  stopMissing.abort();
  await missing.done;
  console.log("YEAR_INSTALL_CHECKED");
}
const cached = workspace(),
  name = officialName(identity),
  root = `home/config/extensions/${name}/year-review/1.0.0`;
cached.write(
  root + "/extension.json",
  JSON.stringify({
    name: "year-review",
    version: "1.0.0",
    description: "Official yearly terminal animation.",
  }),
);
cached.write(
  root + "/skills/year-review/definition.md",
  "---\nname: year-review\ndescription: Create a terminal animation from local annual statistics.\n---\nUse only the supplied annual totals.\n",
);
cached.write(
  `home/config/year-review/${year}.json`,
  JSON.stringify({
    year,
    frames: [
      { text: "FIRST_CACHED_FRAME " + year, durationMs: 80 },
      { text: "LAST_CACHED_FRAME " + year, durationMs: 80 },
    ],
  }),
);
const noGeneration = new ScriptedProvider([]),
  watch = interactive([], cached, {
    identity,
    signal: stopWatch.signal,
    provider: noGeneration,
    userConfig: {
      ui: { yearInReview: { enabled: true, months } },
      extensions: { enabled: { ["year-review@" + name]: true } },
    },
  });
try {
  await watch.idle();
  watch.type("/year-review watch\r");
  await watch.waitFor((t) => t.includes("FIRST_CACHED_FRAME"));
  await watch.waitFor((t) => t.includes("LAST_CACHED_FRAME"));
  check(!noGeneration.requests.length, "Watching generated again");
} finally {
  stopWatch.abort();
  await watch.done;
  console.log("YEAR_WATCH_CHECKED");
}
const disabled = interactive([], workspace(), {
  identity,
  signal: stopDisabled.signal,
  provider: new ScriptedProvider([]),
  userConfig: { ui: { yearInReview: { enabled: false, months } } },
});
try {
  await disabled.idle();
  disabled.type("/year-review\r");
  await disabled.waitFor((t) => t.includes("Commande inconnue"));
  check(
    !disabled.all().join("\n").includes("Installer l’extension officielle"),
    "Inactive promotion",
  );
} finally {
  stopDisabled.abort();
  await disabled.done;
}
const animationPath = cached.configHome + `/year-review/${year}.json`,
  newAnimation = {
    year,
    frames: [{ text: "GENERATED_REVIEW_FRAME " + year, durationMs: 80 }],
  },
  stopGeneration = new AbortController();
const generator = new ScriptedProvider([
  (request) => {
    check(
      JSON.stringify(request.history).includes(
        "Use only the supplied annual totals.",
      ),
      "Official skill was not loaded",
    );
    check(
      JSON.stringify(request.history).includes("Local annual statistics"),
      "Local statistics missing",
    );
    return {
      toolCalls: [{ name: "read_file", input: { path: animationPath } }],
    };
  },
  {
    toolCalls: [
      {
        name: "write_file",
        input: { path: animationPath, content: JSON.stringify(newAnimation) },
      },
    ],
  },
  { text: "Annual animation saved." },
]);
const generate = interactive([], cached, {
  identity,
  signal: stopGeneration.signal,
  provider: generator,
  userConfig: {
    ui: { yearInReview: { enabled: true, months } },
    permissions: { allowRules: ["read_file"] },
    extensions: { enabled: { ["year-review@" + name]: true } },
  },
});
try {
  await generate.idle();
  generate.type("/year-review generate\r");
  await generate.waitFor((t) => t.includes("Autorisation requise"));
  await sleep(380);
  generate.type("1");
  await generate.waitFor((t) => t.includes("Annual animation saved."));
  await generate.waitFor((t) => t.includes("GENERATED_REVIEW_FRAME"));
  check(
    generator.requests.length === 3,
    "Generation did not complete its ordinary file tool turn",
  );
} finally {
  stopGeneration.abort();
  await generate.done;
}
console.log("YEAR_REVIEW_PROBE_PASSED");
