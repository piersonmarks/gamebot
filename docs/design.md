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
│   ├── Scheduler uses multiple signals, cooldowns, and explicit budgets
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

The event-driven coordinator is the single writer of authority. Adapters translate game mechanics into observations, feasible actions, verifier outcomes, and scheduler signals. Fast and slow model implementations can change without changing the adapter's game rules. Reasoning results can be discarded when the goal, directive, or their relevant assumptions have changed. Action validation is repeated against a fresh observation before dispatch.

Operational details remain deliberately small in v0: one process, one session per runtime, local file memory, and registered deterministic skill executors. A restart restores intent and observes the game again; it does not replay queued commands or resume a skill's instruction pointer. Long-running motor work and interrupt delivery while that work is active are a subsequent milestone.

The first real adapter and provider selection are still open integration work. They should be chosen from verified available game interfaces and model endpoints, rather than guessed from the architecture handoff. RCT2 remains in the target set.
