// Approved C/D v2 presence contract; this file never generates a profile in the checkout.
import { expect, test } from "bun:test";
import { BUILD_OPTIONS, resolveBuildOptions } from "../src/extension-points/build-options";

export const ALL_PROFILE_OPTIONS = ["model_fast_output", "engine_tool_summaries", "engine_control_channel", "browser_user_control", "storage_encryption"] as const;
export const INTERNAL_PRESENCE_OPTIONS = ["context_file_listing", "hosted_agent_management", "merge_request_fix", "session_metadata_backfill", "diagnostics_context_inspection", "diagnostics_tool_call_inspection", "diagnostics_environment_inspection", "session_handoff", "feedback_issue_report", "onboarding_restart", "diagnostics_performance_report", "feedback_positive_report", "remote_failure_injection", "session_publish", "session_summary", "diagnostics_session_version", "remote_task_suggestions", "skill_filler_text", "skill_session_rescue", "ui_frustration_detection", "ui_dev_bar", "ui_internal_notices", "config_feature_overrides", "diagnostics_build_inventory"] as const;
const approved = [...ALL_PROFILE_OPTIONS, ...INTERNAL_PRESENCE_OPTIONS, "state_capture", "permission_test"];

test("TECH — approved C/D v2 options preserve all four presence profiles and existing identifiers", () => {
  expect(approved).toHaveLength(31);
  expect(new Set(approved).size).toBe(31);
  for (const profile of ["public", "internal", "development", "test"] as const) {
    const values = resolveBuildOptions(profile) as Record<string, boolean>;
    for (const name of ALL_PROFILE_OPTIONS) expect({ profile, name, value: values[name] }).toEqual({ profile, name, value: true });
    for (const name of INTERNAL_PRESENCE_OPTIONS) expect({ profile, name, value: values[name] }).toEqual({ profile, name, value: profile !== "public" });
    expect(values.state_capture).toBe(profile === "internal");
    expect(values.permission_test).toBe(profile === "test");
  }
  for (const name of approved) expect(Object.hasOwn(BUILD_OPTIONS, name)).toBe(true);
});

test("TECH — build overrides cannot put the approved restricted options into forbidden profiles", () => {
  for (const name of [...INTERNAL_PRESENCE_OPTIONS, "state_capture", "permission_test"]) expect(() => resolveBuildOptions("public", { [name]: true })).toThrow();
  for (const profile of ["development", "test"]) expect(() => resolveBuildOptions(profile, { state_capture: true })).toThrow();
  for (const profile of ["internal", "development"]) expect(() => resolveBuildOptions(profile, { permission_test: true })).toThrow();
  for (const profile of ["public", "internal", "development", "test"]) {
    const values = resolveBuildOptions(profile, Object.fromEntries(approved.map(name => [name, false]))) as Record<string, boolean>;
    for (const name of approved) expect(values[name]).toBe(false);
  }
});
