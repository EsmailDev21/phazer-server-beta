/**
 * Every ceiling of the automation DSL in one place. The validator enforces the "shape" ones now;
 * the "runtime" ones are what the rule runner (step 5.2) must honour, kept here so they are
 * decided once and tested against the same numbers.
 */
export const AUTOMATION_LIMITS = {
  // ---- shape (enforced by the validator and, for sizes, by CHECKs in the migration) ----
  maxActions: 10,
  maxConditions: 20,
  maxListItems: 50,
  maxRuleBytes: 64 * 1024,
  maxJsonDepth: 12,
  maxNameLength: 120,
  maxCommentLength: 2000,
  maxSubtaskTitleLength: 200,
  maxDescriptionLength: 5000,
  maxEstimate: 1000,
  /** TASK_OVERDUE only looks back this far, so a new rule does not fire for every old late task */
  overdueLookbackDays: 7,
  /** SCHEDULE: a missed slot (the worker was down) is still run if it is this recent */
  scheduleCatchUpHours: 2,
  maxMessageLength: 500,
  maxStringValue: 500,
  maxIssues: 50,
  /** per workspace; a rule is cheap to store but each enabled one is evaluated per event */
  maxAutomationsPerWorkspace: 100,
  maxEnabledPerWorkspace: 50,
  rawDefinitionBytes: 256 * 1024,

  // ---- runtime (step 5.2) ----
  /** a rule firing because another rule's action changed a task: 0 = a person/adapter, 3 = the cap */
  maxChainDepth: 3,
  /** runs of ONE rule per minute before it is paused with a visible reason */
  maxRunsPerRulePerMinute: 30,
  /** tasks one DUE_APPROACHING sweep may fire for, per rule, per tick */
  maxDueFiresPerTick: 200,
} as const;
