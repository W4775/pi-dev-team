export const IMPLEMENTOR_LAYERS = ["database", "backend", "frontend", "general"] as const;
export type ImplementorLayer = (typeof IMPLEMENTOR_LAYERS)[number];

export const ISOLATED_ROLES = [
  "plan_critic",
  "design_critic",
  "planner_orchestrator",
  "scout",
  "orchestrator",
  "database",
  "backend",
  "frontend",
  "general",
  "reviewer",
  "tester",
  "linter",
  "commit_message",
] as const;
export type IsolatedRole = (typeof ISOLATED_ROLES)[number];

export const INTERACTIVE_ROLES = ["planner", "designer"] as const;
export type InteractiveRole = (typeof INTERACTIVE_ROLES)[number];

export type RoleName = InteractiveRole | IsolatedRole;

export type UiSurface = "web" | "native" | "terminal" | "none";

export type Stage =
  | "idle"
  | "scout_orchestrate"
  | "scout"
  | "planner"
  | "plan_critic"
  | "plan_review"
  | "mockup_opt_in"
  | "designer"
  | "design_critic"
  | "build_it_pause"
  | "orchestrate"
  | "implement"
  | "reviewer"
  | "fix_review"
  | "tester"
  | "fix_test"
  | "linter"
  | "fix_lint"
  | "commit_message"
  | "done"
  | "error";

export type PauseReason =
  | "plan_review"
  | "plan_rewrite"
  | "mockup_opt_in"
  | "build_it"
  | "design_reject_max"
  | "fix_review_max"
  | "fix_test_max"
  | "fix_lint_max";

export type FindingAxis = "standards" | "spec";
export type FindingSeverity = "block" | "note";

export type Finding = {
  axis: FindingAxis;
  severity: FindingSeverity;
  text: string;
  files?: string[];
};

/** One buildable unit: a directory with its own language and toolchain. */
export type ServiceInfo = {
  name: string;
  /** Repository-relative root. Empty string means the repo itself. */
  root: string;
  layer: ImplementorLayer;
  languages: string[];
  paths: string[];
  skills: string[];
  test: string[];
  lint: string[];
  source: "detected" | "config" | "merged";
};

export type ServiceConfig = {
  name: string;
  root?: string;
  layer?: ImplementorLayer;
  languages?: string[];
  paths?: string[];
  skills?: string[];
  test?: string[];
  lint?: string[];
};

export type StackDetection = {
  frontend?: string;
  /** First backend match, for prompts that want a single label. */
  backend?: string;
  /** Every backend match. A repo may run several at once. */
  backends: string[];
  database: string[];
  tester: string[];
  extra: string[];
  uiSurface: UiSurface;
  matchedIds: string[];
  services: ServiceInfo[];
};

export type ResolvedSkill = {
  name: string;
  dir: string;
  source: "override" | "installed" | "cache" | "unresolved";
  catalogId?: string;
  error?: string;
};

export const WORK_ITEM_STATUSES = ["pending", "running", "done", "failed"] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export type WorkItem = {
  id: string;
  layer: ImplementorLayer;
  service?: string;
  title: string;
  details?: string;
  files: string[];
  dependsOn: string[];
  status: WorkItemStatus;
  attempts: number;
  summary?: string;
  error?: string;
};

/** Read-only recon for the planner. Paths are where to look, not a write allowlist. */
export type ScoutItem = {
  id: string;
  title: string;
  details?: string;
  files: string[];
  service?: string;
  status: WorkItemStatus;
  attempts: number;
  findings?: string;
  error?: string;
};

export type ChildAssignment = {
  id: string;
  title: string;
  details?: string;
  files: string[];
  service?: string;
  layer?: ImplementorLayer;
  list: "work" | "scout";
};

export type CritiqueItem = {
  id: string;
  title: string;
  text: string;
  decision?: "accept" | "reject";
  userNote?: string;
};

export type PlanCritique = {
  notes: string;
  replacedScope: boolean;
  items?: CritiqueItem[];
  reviewed?: boolean;
};

export type RunState = {
  version: 1;
  sessionId: string;
  jobId: string;
  task: string;
  stage: Stage;
  pauseReason?: PauseReason;
  /** User stopped this step. The pipeline must not auto-advance until continue or skip. */
  halted?: boolean;
  pipelineLocked: boolean;
  currentRole?: RoleName;
  interactiveRole?: InteractiveRole;
  implementorQueue: ImplementorLayer[];
  implementorIndex: number;
  /** Layer currently under review (or being fixed after that review). */
  reviewLayer?: ImplementorLayer;
  /** Remaining services for the current implementor layer, when the repo is polyglot. */
  serviceQueue: string[];
  serviceIndex: number;
  currentService?: string;
  workItems?: WorkItem[];
  scoutItems?: ScoutItem[];
  scoutNotes?: string;
  wantMockup?: boolean;
  stack?: StackDetection;
  resolvedSkills?: Record<string, ResolvedSkill[]>;
  spec?: string;
  layersNeeded?: string[];
  filesToChange?: Partial<Record<ImplementorLayer, string[]>>;
  uiSurface?: UiSurface;
  cwd?: string;
  planCritique?: PlanCritique;
  originalSpec?: string;
  originalLayersNeeded?: string[];
  planRewriteResolved?: boolean;
  designTokens?: string;
  uiPrimitives?: string;
  designPlan?: string;
  mockupPath?: string;
  mockupVersion?: number;
  designCritiqueNotes?: string;
  designRejectCount: number;
  databaseNotes?: string;
  backendNotes?: string;
  frontendNotes?: string;
  generalNotes?: string;
  openQuestions?: string;
  reviewFindings?: Finding[];
  testResults?: string;
  testFailed?: boolean;
  lintResults?: string;
  lintErrors?: boolean;
  commitMessageDraft?: string;
  currentStatus?: string;
  nextAgent?: string;
  gitBaseline?: string;
  dirtyAtStart?: boolean;
  fixRound: { review: number; test: number; lint: number };
  lastError?: string;
  pendingHandoff?: { action: HandoffAction; summary?: string };
  createdAt: string;
  updatedAt: string;
};

export type SkillSource = {
  name: string;
  repo: string;
  ref: string;
  path: string;
};

export type StackMatch = {
  deps?: string[];
  files?: string[];
  missingFiles?: string[];
  csprojContains?: string[];
  prismaProvider?: string;
  envContains?: string[];
  composeImages?: string[];
  plannerHint?: string;
};

export type StackEntry = {
  id: string;
  layer: "frontend" | "backend" | "database" | "tester";
  uiSurface?: UiSurface;
  additive?: boolean;
  requires?: string;
  match: StackMatch;
  skills: SkillSource[];
};

export type Catalog = {
  maxSkillsPerChild: number;
  stacks: StackEntry[];
};

export type ProjectConfig = {
  skills?: {
    frontend?: string[];
    backend?: string[];
    database?: string[];
    extra?: string[];
  };
  paths?: Partial<Record<ImplementorLayer, string[]>>;
  /** Declared services, merged over whatever the manifest scan found. */
  services?: ServiceConfig[];
  bash?: {
    test?: string[];
    lint?: string[];
  };
  /** Abort a child after this many tool calls. 0 uses the role default (200 for implementors/reviewer, 40 for scouts, 80 otherwise). */
  maxToolCalls?: number;
  /** Seconds between optional progress toasts. 0 (default) turns them off; live work goes to the working line. */
  progressEvery?: number;
  /** How many implementor subagents may run at once within one layer. */
  parallel?: number;
  /** Seconds with no child output before abort. 0 disables. Default 480 (8 min). */
  childIdle?: number;
  /** Abort if this many consecutive tool calls have the same label. 0 disables. Default 8. */
  repeatToolAbort?: number;
};

export const DEFAULT_TEST_BASH = [
  "npm test",
  "pnpm test",
  "yarn test",
  "pytest",
  "go test",
  "cargo test",
  "dotnet test",
];

export const DEFAULT_LINT_BASH = [
  "npm run lint",
  "pnpm lint",
  "eslint",
  "ruff",
  "cargo clippy",
  "dotnet format",
];

export const MAX_FIX_ROUNDS = 3;
export const MAX_DESIGN_REJECTS = 2;
export const MAX_SERVICES = 12;
export const DEFAULT_MAX_TOOL_CALLS = 80;
/** Implementors, reviewer, tester, and linter need room to read, edit, and re-check. */
export const DEFAULT_BUILD_TOOL_CALLS = 200;
export const SCOUT_MAX_TOOL_CALLS = 40;
export const MAX_TOOL_CALLS_CAP = 400;
export const DEFAULT_PROGRESS_EVERY_MS = 0;
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 6;
export const MAX_WORK_ITEM_ATTEMPTS = 2;
export const MAX_SCOUTS = 6;
export const DEFAULT_CHILD_IDLE_MS = 480_000;
export const DEFAULT_REPEAT_TOOL_ABORT = 8;

export const HANDOFF_ACTIONS = [
  "plan_ready",
  "critic_approve",
  "critic_revise",
  "design_ready",
  "scout_planned",
  "scout_done",
  "work_planned",
  "implementor_done",
  "qa_pass",
  "qa_fail",
  "commit_drafted",
] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];
