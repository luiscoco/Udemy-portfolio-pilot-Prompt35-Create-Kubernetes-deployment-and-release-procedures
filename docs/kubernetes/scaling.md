# Scaling policy (milestone 35)

Decision record: [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md). The API, the
frontend and each worker role are separate Deployments, so each scales on its own signal. Nothing
here is automatic except the API autoscaler and the managed gateway's own HPA.

## Why CPU is not enough

- **SSE.**
  - An open `/api/events` stream is an idle HTTP response. Every 15 s it costs one heartbeat write.
  - It also costs a share of the replica's Redis Stream polling (every 500 ms per user cohort,
    `SSE_LIMITS` in `apps/api/lib/event-hub.ts`) and its bounded per-connection queue.
  - Ten thousand idle streams can sit at a few percent CPU while the replica runs out of memory,
    sockets or Redis round-trips. CPU-only autoscaling would never react.
- **Agent work.**
  - It waits on the model API: a busy agent worker is mostly idle CPU.
  - Its backlog lives in PostgreSQL (`AgentJob` queued rows), not in the pod.
- **Outbox delivery.**
  - Delivery lag shows up as outbox age, not CPU.
- **Ingestion.**
  - Ingestion is a single leased loop: a second replica is a warm standby, not throughput.

## Signals that already exist

| Signal | Where | Meaning |
| --- | --- | --- |
| `pp.sse.connections.active` | OTel metric per API replica (milestone 32) | Open authenticated streams on that replica |
| `pp.queue.age{queue=agent_job}` | OTel histogram, agent worker | Wait from enqueue to claim |
| `pp.queue.age{queue=outbox}` | OTel histogram, outbox dispatcher | Wait from commit to publish |
| `operations.snapshot` log | agent worker, every `OPS_REPORT_INTERVAL_MS` (60 s) | Queue **depth and age** from PostgreSQL: `agentRuns.queued` / `oldestQueuedAgeMs`, `outbox.pending` / `oldestPendingAgeMs` / `dead`, stuck runs, active slots |
| `node apps/worker/dist/admin.js status` | operator CLI (scope `ops:read`, milestone 30) | Queue depth, outbox state, stuck runs |
| container CPU / memory | Container insights (milestone 34 DCR) | Saturation |

The OTel collector is not deployed by these manifests yet (`OTEL_*_EXPORTER=none`; see the
milestone-35 limitations), so the metrics are not exported in AKS today. Until it is, the
`operations.snapshot` log in Container insights is enough. This query shows queue depth and age over
time:

```kusto
ContainerLogV2
| where PodNamespace == "portfolio-pilot" and ContainerName == "worker"
| where LogMessage has "operations.snapshot"
| extend m = parse_json(tostring(LogMessage))
| project TimeGenerated, PodName, queued = toint(m.agentRuns.queued), running = toint(m.agentRuns.running),
          oldestQueuedSec = todouble(m.agentRuns.oldestQueuedAgeMs) / 1000,
          outboxPending = toint(m.outbox.pending), oldestPendingSec = todouble(m.outbox.oldestPendingAgeMs) / 1000,
          outboxDead = toint(m.outbox.dead), stuck = toint(m.stuck)
| order by TimeGenerated desc
```

The field names follow `operationsSnapshot()` in `packages/db/src/operations.ts`. Check them there
before you build alerts.

## Policy by workload

| Workload | Initial | Mechanism | Scale out when | Ceiling (dev cluster) |
| --- | --- | --- | --- | --- |
| web (nginx) | 2 | manual | p95 static latency > 200 ms or CPU > 70% (unlikely) | 3 |
| API | 2 | **HPA** 2–4: CPU 70%, memory 80% of request; scale-down 1 pod / 5 min after a 10 min window | and manually when the **average SSE connections per replica > 500** or **p95 API latency > 1 s** for 10 min | 4 |
| worker-agent | 1 (2 slots) | **manual** | **oldest queued agent run > 30 s** (`agentRuns.oldestQueuedAgeMs`) in 3 consecutive snapshots, or **queued > 2 × total slots** | stop at `AGENT_GLOBAL_CONCURRENCY` (8) ÷ `AGENT_WORKER_CONCURRENCY` (2) = 4 replicas; beyond that, raise the global limit deliberately (budget!) |
| worker-outbox | 1 | **manual** | **oldest pending outbox event > 10 s** (`outbox.oldestPendingAgeMs`) in 3 consecutive snapshots, or **pending > 500**; any `dead` > 0 is an incident, not a scaling signal | 3 (batches are leased, so replicas share work) |
| worker-ingestion | 1 | fixed | never for throughput; a 2nd replica only as a hot standby | 2 |
| gateway proxies | 2 | add-on HPA 2–5 on CPU 80% | — | add-on default |

Notes:

- **API thresholds.**
  - The 500-streams figure is a starting point, not a measurement. Measure it before trusting it: run
    the local stack, open N streams with `scripts/k8s-smoke.mjs`-style clients, and watch replica
    memory against the 1 Gi limit.
  - Idle memory measured on kind is about 140 MiB per replica (no streams).
- **Scale-down and SSE.** Removing an API replica closes its streams. Browsers reconnect with their
  `Last-Event-ID` and lose nothing, but the reconnect burst costs a snapshot and replay read each.
  That is why the HPA scales down by at most one pod every 5 minutes.
- **Agent ceiling is a cost control.** The global concurrency limit and the daily USD budget (milestone
  26) cap spending no matter how many pods exist. Adding replicas past the global limit only adds idle
  pods.
- **Manual scaling commands.**
  ```bash
  kubectl -n portfolio-pilot scale deployment/worker-agent --replicas=2
  kubectl -n portfolio-pilot scale deployment/worker-outbox --replicas=2
  ```
  - `kubectl scale` changes only the live object. The next release re-applies the manifests, but the
    worker Deployments set `replicas`, so a release resets a manual scale.
  - Record the decision by changing `replicas` in `deploy/kubernetes/base/workers.yaml` (or an
    overlay patch), not only in the cluster.
- **Next step (not done).**
  - Once these thresholds have been observed under real load, replace the manual worker policy with
    KEDA on the AKS add-on, using a PostgreSQL scaler on `AgentJob`/`OutboxEvent` counts.
  - It needs its own identity with read access to those two tables (ADR 0027).
