# Gamebot design tree

This records the design agreed before implementation. The handoff document was input to the discussion, not an instruction to implement all of its suggested interfaces. The current code is the first runnable slice described in the README.

```text
Gamebot
├── Product
│   ├── First user: the operator
│   ├── Next use: comparing game-playing architectures
│   └── RCT2 is a target game, not a required first adapter
├── Runtime
│   ├── Game-native typed state and actions inside a small shared envelope
│   ├── One coordinator owns goal, directive, revisions, and execution handoff
│   ├── User goal is authoritative; models may revise subordinate policy
│   ├── One active execution owner and one resolved directive
│   ├── Replace implementations at session setup
│   ├── Models reason asynchronously from fresh runtime-owned context
│   └── Check proposal basis and current assumptions before activation
├── Decision layers
│   ├── Deterministic skills may continue without reflex calls
│   ├── Reflex initially selects only offered candidates
│   ├── Tactician and strategist are optional and usually dormant
│   ├── Model-authored observation conditions wake Sol for strategy or learning decisions
│   └── Tool calls gather evidence; proposals use the same activation path
├── Skills
│   ├── Agent Skills SKILL.md is the discovery/instruction format
│   ├── Injector, decision, and execution are separate
│   ├── Instruction-only skills guide existing reasoning
│   ├── Registered executors support progress, cancellation, and outcome
│   ├── Interrupted execution ends by default; resumption is opt-in
│   └── New executable skills require evaluation before promotion
├── Memory
│   ├── Separate working context, recorded episodes, and durable lessons
│   ├── Versioned, validated snapshots; research runs pin one
│   ├── Scope by game/version and world/save
│   ├── Cross-game promotion is explicit
│   └── Recording, retrieval, and consolidation are replaceable
└── Evaluation
    ├── Compare reflex, tactical, and full configurations
    ├── Report gameplay, cost, and latency separately
    ├── Track component versions and memory snapshots
    └── Diagnose from traces; establish performance in actual game runs
```

The event-driven coordinator is the single writer of authority. Adapters translate game mechanics into observations, feasible actions, verifier outcomes, and observation signals. Fast and slow model implementations can change without changing the adapter's game rules. Reasoning results can be discarded when the goal, directive, or their relevant assumptions have changed. Action validation is repeated against a fresh observation before dispatch.

Operational details remain deliberately small in v0: one process, one session per runtime, local file memory, and registered deterministic skill executors. The planned restart behavior restores intent and observes the game again; persistence of live authority is not wired into the current session runtime. It will not replay queued commands or resume a skill's instruction pointer. The coordinator now advances one skill action per step, reobserves before dispatch, and cancels active skills on interruption or run end.

The model seam now uses Vercel AI SDK. The runtime receives a reflex or reasoner implementation, while the AI SDK adapter receives the chosen model at session setup. A Gateway model ID or direct provider model can be swapped without changing the coordinator or game adapter. The local demo remains deterministic by default; actual model calls require explicit configuration.

The demo selects relevant Agent Skills instructions for each model wake and includes them in the prompt. Selection remains separate from executable registration. Evaluation settles background reasoning and trace writes before reading final metrics; reaching a game goal still advances an active skill to its terminal outcome when the step budget permits.

The first external game adapter and provider selection are still open integration work. They should be chosen from verified available game interfaces and model endpoints, rather than guessed from the architecture handoff. RCT2 remains in the target set.

Chess, Snake, and Pac-Man have separate `@gamebot/chess`, `@gamebot/snake`, and `@gamebot/pacman` bridge packages. The bridges depend on `@gamebot/core`; their game rules are not included in core. The chess bridge uses `chess.js`. Snake's seeded game, real-time clock, and browser window live in the independent `snake-game` package, which has no GameBot dependency and can run by itself. The optional Snake bridge only observes state, sends directions, and adds display annotations. Pac-Man follows the same seam: `pacman-game` owns its maze, ghosts, clock, and window, while `@gamebot/pacman` is an optional controller. Both bridges reuse the core local-game session transport. These are initial integration fixtures, not evidence that a particular model or hierarchy plays either game well.

Each game bridge owns an initially empty `tools/` area for reviewed game-specific implementations. Its runner creates a writable `.gamebot/games/<game>/tools/` area for agent-authored drafts. A tool can use that bridge's native state to compute evidence or propose candidates, so the core runtime does not need a universal game-state schema. Drafts are inert until the bridge explicitly registers a reviewed implementation. Tool use must remain distinct from skill execution and game action authority; evaluation should record which tool version a run used when callable tools are added.


## AI-first research extension

The 2048, Snake, and Pac-Man runners use a shared three-tier player. The strategist establishes the initial approach and delegation before play; the tactician maintains a separate immediate objective; the reflex/JEV role chooses legal candidates through AI, generated code, or explicit hybrid delegation. A model-authored observer watches decisions and outcomes without inference. It wakes Sol on model-defined conditions; Sol decides whether to continue, involve Astra, or request a learning revision. Jev only answers judgments. Game signals and terminal outcomes provide evidence; the harness has no automatic review intervals or timers. These runners await model-requested reviews; the existing asynchronous reasoner interface remains available for other integrations.

Research evaluates whole player artifacts, including prompts and executable programs. The strongest configured model diagnoses sampled gameplay and proposes alternatives, with prior experiment findings retained across runs. Rules, goals, legality, execution limits and success evaluation belong to the harness and game package. Code runs in QuickJS rather than the host process. Fresh training/validation comparisons and a final audit gate publication. Ordinary play is AI-first and requires explicit `--policy` selection to load saved research. See [the learning guide](learning.md) for the implemented interface and limits.
