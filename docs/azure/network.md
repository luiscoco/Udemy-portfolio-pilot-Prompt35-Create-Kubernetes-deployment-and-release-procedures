# Azure network design (milestone 34)

Source: [infra/azure/modules/network.bicep](../../infra/azure/modules/network.bicep). Nothing here is
deployed until someone runs the commands in [provisioning.md](provisioning.md).

## Layout

| Range | Purpose |
| --- | --- |
| VNet `10.40.0.0/16` | One VNet per environment |
| `snet-aks-nodes` `10.40.0.0/22` | AKS nodes (Azure CNI Overlay; 1,019 node IPs) — egress through the NAT gateway |
| `snet-private-endpoints` `10.40.8.0/24` | Private endpoints for PostgreSQL, Redis, Key Vault and Blob |
| Pod overlay `10.244.0.0/16` | Pod IPs; not routable in the VNet (traffic leaving the node is SNATed to the node IP) |
| Services `10.41.0.0/16`, DNS `10.41.0.10` | Kubernetes ClusterIP range; must not overlap the VNet or peered networks |

All four ranges are parameters. Change them before the first deployment if the VNet will ever be
peered with networks that use them.

## Data paths are private

| Service | Public access | Private path | Private DNS zone |
| --- | --- | --- | --- |
| PostgreSQL Flexible Server | `Disabled` | private endpoint, subresource `postgresqlServer` | `privatelink.postgres.database.azure.com` |
| Azure Managed Redis | `Disabled` | private endpoint, subresource `redisEnterprise`, TLS port 10000 | `privatelink.redis.azure.net` |
| Key Vault | firewall: deny, only `operatorIpRanges` (disabled entirely when empty) | private endpoint, subresource `vault` | `privatelink.vaultcore.azure.net` |
| Blob Storage | `Disabled`, shared keys disabled | private endpoint, subresource `blob` | `privatelink.blob.core.windows.net` |
| Container Registry | public endpoint (Basic SKU) | none — Premium is required for private endpoints | — |

The zone names and subresources are the recommended values in Microsoft's
[private endpoint DNS table](https://learn.microsoft.com/azure/private-link/private-endpoint-dns).

### DNS

- Each zone is linked to the VNet (no auto-registration). Each private endpoint has a DNS zone
  group, so Azure maintains the A record.
- Applications keep using the normal public host names, for example
  `psql-pp-dev-xxxxxx.postgres.database.azure.com` and `amr-pp-dev-xxxxxx.eastus2.redis.azure.net`.
  Inside the VNet, the public CNAME chain resolves to the private IP. From the internet, the same
  name resolves but the connection is refused because public access is disabled.
- Pods use CoreDNS, which forwards to Azure DNS (168.63.129.16), which consults the linked zones.
- Only these four zones are private. Every other name (Anthropic, Alpaca, Entra, ACR) resolves
  publicly as usual.

### Network security group on the private-endpoint subnet

- Inbound from `snet-aks-nodes` to TCP 5432 (PostgreSQL), 10000 (Redis) and 443 (Key Vault, Blob)
  is allowed.
- Any other inbound traffic from the VNet is denied (priority 4000).
- `privateEndpointNetworkPolicies: Enabled` makes the NSG apply to private endpoint traffic.
- Pod-level rules (only the API and workers may reach the data services) are Kubernetes
  NetworkPolicies enforced by Cilium ([milestone 35](../kubernetes/networking.md#networkpolicy-cilium-on-aks)).

## Outbound (egress) path

Nodes leave through a **Standard NAT gateway** with one **static public IP**. This IP is a
deployment output (`natPublicIp`), so providers that support IP allow-lists can pin it. The idle
timeout is 10 minutes; long model streams keep sending bytes, so this only reaps idle flows. The
subnet sets `defaultOutboundAccess: false`, so there is no implicit outbound path.

Required outbound destinations (HTTPS 443 unless noted):

| Destination | Used by | Why |
| --- | --- | --- |
| `api.anthropic.com` | agent worker (and the API if it runs model calls) | Claude Agent SDK model API |
| `data.alpaca.markets` | ingestion worker | Quotes and news (`packages/providers`) |
| `login.microsoftonline.com` | every workload identity | Exchange of federated tokens for Entra access tokens |
| `<acr>.azurecr.io`, `<region>.data.azurecr.io` | kubelet | Image pulls (public ACR endpoint) |
| `<appinsights ingestion endpoint>` (from the connection string) | OTel collector (milestone 35) | Telemetry export |
| AKS required destinations (for example `mcr.microsoft.com`, `management.azure.com`, the API server FQDN; full list on the linked page) | nodes and add-ons | [AKS outbound network rules](https://learn.microsoft.com/azure/aks/outbound-rules-control-egress) |
| `docker.io` registry endpoints | bootstrap pod only (`postgres:17.6-alpine`) | One-off database bootstrap; mirror the image into ACR to avoid this |

The NAT gateway does not filter by host name. FQDN-level egress control needs either Azure
Firewall (with a `userDefinedRouting` outbound type; a fixed hourly charge far above this dev
budget, so price it in the calculator first) or Cilium FQDN policies through Advanced Container Networking Services (a paid add-on).
For dev, egress is restricted per pod by CIDR and port with Cilium NetworkPolicy in milestone 35,
and by host name only inside the application (fixed provider endpoints, no redirects; milestone 29).

## API server

- The API server is public, but with **Entra-only authentication**: Azure RBAC is used and local
  accounts are disabled, so there is no static admin kubeconfig.
- `aksAuthorizedIpRanges` restricts which source IPs may connect. In a non-private cluster, node
  traffic to the API server leaves through the outbound type, so the template adds the NAT IP
  automatically ([AKS NAT gateway](https://learn.microsoft.com/azure/aks/nat-gateway)).
- GitHub-hosted runners have no fixed IPs. Releases in milestone 35 must either leave the range
  open (Entra RBAC still applies), use `az aks command invoke`, or use a self-hosted runner.
- A private cluster or API server VNet integration is the production option. It needs a jump host
  or self-hosted runner, so it is out of scope for dev.

## Public host and ingress

- The template creates **no public ingress**. Milestone 35 chose the AKS application routing
  add-on's Gateway API implementation (`approuting-istio`, [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md)).
  It is enabled with `az aks update --enable-gateway-api --enable-app-routing-istio`. The Gateway
  then creates a Standard load balancer and public IP in the node resource group.
- SSE timeouts, routing and pod-level policies: [docs/kubernetes/networking.md](../kubernetes/networking.md).
- The public DNS name for the single HTTPS origin (`AUTH_BASE_URL`) is a manual choice
  ([manual-choices.md](manual-choices.md)).
