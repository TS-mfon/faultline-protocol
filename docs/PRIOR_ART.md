# Prior art and positioning

Reviewed 2026-10-17. This is a scoped comparison of published research and first-party product descriptions, not an exhaustive novelty search, legal opinion, benchmark of Faultline, or independent audit of another system. No code from these projects was used.

Faultline combines accepted workflow duties, immutable dependency handoffs, contextual responsibility findings and a capped repair process. Attribution, evidence-based agent diagnosis, escrow and agent arbitration all have prior art. The combination described here is a product direction; it does not establish that Faultline is the first implementation.

## Comparison

| Work | What its sources establish | Relationship to Faultline |
| --- | --- | --- |
| **Who&When** — Zhang et al., ICML 2025 | A dataset and evaluation of methods that identify the agent and decisive step associated with a multi-agent failure. The paper reports substantial difficulty localizing failures. | Relevant evidence that attribution is an existing research problem. Faultline evaluates breaches of accepted duties and resulting contractual remedies; it has not demonstrated better attribution accuracy. |
| **AgentRx** — Barke et al., 2026 | A diagnostic framework that derives constraints, evaluates execution steps, records violations and evidence, and uses a model judge to identify a critical failure and category. | Closely related use of explicit constraints and an auditable evidence record. Faultline's duties are agreed before execution and its outcome can reserve bonds and authorize a separately verified repair. That distinction does not make its judgments scientifically causal or more reliable. |
| **Kleros and Kleros AI** | First-party materials describe agent verification, protected payments, dispute handling, AI triage and escalation. Kleros reports a beta agent-juror court demonstration with a publicly linked dispute. | Direct prior art for agent-facing arbitration and payment recovery. Faultline uses GenLayer judgments and a disclosed single attestor to a Base escrow, with node-level duties, 3:1 allocation and a separate repair judgment. It should not claim to invent agent arbitration or trustless recovery. |

Sources: [Who&When paper and abstract](https://proceedings.mlr.press/v267/zhang25cq.html), [Microsoft Research's AgentRx publication](https://www.microsoft.com/en-us/research/publication/agentrx-diagnosing-ai-agent-failures-from-execution-trajectories/), [Kleros AI's published capabilities](https://ai.kleros.io/), and [Kleros's account of its August 2026 court demonstration](https://blog.kleros.io/kleros-live-stream-26-august-2026-a-dispute-was-filed-during-the-call-and-five-agents-ruled-it-before-it-ended/). The last source is the operator's account; this review did not independently verify its chain receipts.

## Claims supported by this repository

The [protocol](PROTOCOL.md) defines a bounded contractual responsibility model. A dependency alone does not establish liability. Contributory responsibility requires an accepted detection or mitigation duty. Material uncertainty blocks allocation, and successful repair verification is separate from adjudication. The escrow fixes recipients and prices in advance and performs accounting in integer test USDC units.

The [security document](SECURITY.md) explains the bridge's trusted attestor, public evidence and operational limitations. The [release status](STATUS.md) distinguishes local tests and authored replays from deployed consensus and payment evidence. A passing replay is not a measurement of attribution accuracy, successful independent consensus or funds transferred on a network.

## Questions that remain open

- How often do independent judgments agree with expert assessments of the same accepted duties, especially for clean cases, valid excuses, missing detection duties and conflicting evidence?
- Does recording commitments before execution materially improve attribution or repair outcomes over retrospective diagnosis? A shared dataset and controlled comparison are needed.
- How robust are citations and substantive validator comparisons to malicious evidence, incomplete records and model disagreement?
- What are the measured cost, native appeal latency and recovery completion rate across domains? Three showcase scenarios cannot establish general reliability.
- How should private evidence, a stronger cross-chain trust model and independent review be introduced before production use?

Future comparison work should version its datasets, publish unsuccessful attempts, separate model agreement from correctness, and state the contractual policy being evaluated. No result in the current repository resolves these research questions.
