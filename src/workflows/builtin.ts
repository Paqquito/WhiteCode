// Implements: SPEC-PLA-004 (CA-01/02, public definitions and model text resources).
import review from "../../prompts/workflows/review-multi.md" with { type: "text" };
import migration from "../../prompts/workflows/batch-migrate.md" with { type: "text" };
import investigation from "../../prompts/workflows/bug-investigate.md" with { type: "text" };
import { parseWorkflow } from "./definitions";
export const builtinWorkflows = () => [review, migration, investigation].map(parseWorkflow);
