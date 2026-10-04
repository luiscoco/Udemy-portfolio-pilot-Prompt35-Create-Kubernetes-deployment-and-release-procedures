# Cost-estimate worksheet — dev environment (milestone 34)

**This is an estimate, not a quote.**

- **Prices:** USD retail pay-as-you-go, region `eastus2`, read from the public
  [Azure Retail Prices API](https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview)
  on **2026-10-03**.
- **Excluded:** taxes, credits, reservations, savings plans and enterprise agreements.
- **Hours:** a month is 730 hours.
- **Re-check before deploying:** re-run the queries (below), then compare the result with the
  [pricing calculator](https://azure.microsoft.com/pricing/calculator/) and your first invoice.
- **Not Azure:** Claude API usage is billed by Anthropic and is not included.

## Monthly estimate (parameters in `infra/azure/parameters/dev.bicepparam`)

| # | Item | Meter (retail) | Unit price | Quantity assumption | Monthly USD |
| --- | --- | --- | --- | --- | --- |
| 1 | AKS control plane, Free tier | — | 0 | 1 cluster (see note A) | 0.00 |
| 2 | AKS nodes `Standard_D2s_v6` (Linux; Dsv6 family, see provisioning step 2 for quota) | Virtual Machines, D2s v6 | 0.101 /h | 2 nodes × 730 h (autoscaler minimum) | 147.46 |
| 3 | Node OS disks, Premium SSD P6 (64 GiB) | P6 LRS Disk | 9.2801 /month | 2 | 18.56 |
| 4 | NAT gateway | Standard Gateway | 0.045 /h | 730 h | 32.85 |
| 5 | NAT data processed | Standard Data Processed | 0.045 /GB | 20 GB (provider polling, model calls, image pulls) | 0.90 |
| 6 | NAT static public IP | Standard IPv4 Static Public IP | 0.005 /h | 730 h | 3.65 |
| 7 | PostgreSQL Flexible Server Burstable B2s | B2S | 0.068 /h | 730 h | 49.64 |
| 8 | PostgreSQL storage | Storage Data Stored | 0.115 /GB-month | 32 GB | 3.68 |
| 9 | PostgreSQL backup storage | Backup Storage LRS | 0.095 /GB-month | 0 GB billable (assumes backups stay within the free allowance equal to provisioned storage; verify) | 0.00 |
| 10 | Azure Managed Redis Balanced B0, HA disabled | B0 Cache Instance | 0.016 /h | 730 h (see note B) | 11.68 |
| 11 | Container Registry Basic | Basic Registry Unit | 0.1666 /day | 30.4 days (see note C) | 5.06 |
| 12 | Key Vault Standard operations | Operations | 0.03 /10K | 400K (CSI polls every 2 min across ~9 mounted secrets, plus app start-up) | 1.20 |
| 13 | Private endpoints | Standard Private Endpoint | 0.01 /h | 4 × 730 h (see note D) | 29.20 |
| 14 | Private endpoint data processed | Standard Data Processed – Ingress | 0.01 /GB | 10 GB | 0.10 |
| 15 | Private DNS zones | Private Zone | 0.50 /zone-month | 4 zones (queries negligible) | 2.00 |
| 16 | Log Analytics ingestion (Container insights, audit logs, App Insights) | Analytics Logs Data Ingestion | 2.76 /GB | 10 GB (cap: 1 GB/day ⇒ at most 30 GB = 82.80) | 27.60 |
| 17 | Log Analytics retention | Analytics Logs Data Retention | 0.12 /GB-month | 30 days only (assumed included) | 0.00 |
| 18 | Blob Storage, Hot LRS | Hot LRS Data Stored / operations | 0.0184 /GB; 0.05 /10K writes | 1 GB; ~10K writes | 0.07 |
| | **Total (expected)** | | | | **333.65** |
| | Upper bound: node autoscaling to 3 (+73.73, +9.28 disk) and log cap reached (+55.20) | | | | **472** |
| | Possible AKS meter (note A) | FreeTierInfrastructureCost Uptime SLA | 0.05 /h | 730 h | +36.50 |

The dev budget parameter is **USD 400/month**. It sends alerts at 80% and 100% of actual spend
and at a 100% forecast. **A budget only notifies; it never stops resources.**

### Notes and open questions

- **A. AKS Free tier.**
  - The pricing page says the Free tier control plane is free.
  - However, the Retail Prices API lists a new meter, `FreeTierInfrastructureCost Uptime SLA`,
    at USD 0.05/h, effective 2026-10-01.
  - How it applies could not be confirmed. Treat the extra USD 36.50 as possible until the first
    invoice shows otherwise.
  - The Standard tier (uptime SLA) is USD 0.10/h (73.00/month); recommended for production.
- **B. Azure Managed Redis.** The B0 price above is the listed instance meter. Whether enabling
  high availability doubles it is not stated by the meter; check the calculator before setting
  `redisHighAvailability=Enabled`. HA cannot be disabled again.
- **C. Container Registry.** Basic has no private endpoint. Premium (1.6666/day ≈ 50.70/month)
  is needed to make it private.
- **D. Private endpoints.** The API returned the USD 0.01/h `Standard Private Endpoint` meter for
  other regions but no `eastus2` row in this query, so the same rate is assumed. Re-check it.
- **Not included:**
  - Internet egress beyond the free allowance.
  - The milestone-35 ingress load balancer and public IP (another ≈3.65/month for the IP plus
    load balancer charges).
  - Microsoft Defender plans.
  - Azure Firewall.
  - Geo-redundant backup (doubles backup storage and is fixed at server creation).

## Cost levers for dev

| Action | Effect | Caveat |
| --- | --- | --- |
| `az aks stop -g <rg> -n <aks>` when idle | Stops node VM charges (disks, NAT, private endpoints, Redis keep billing) | Restart with `az aks start` |
| `az postgres flexible-server stop -g <rg> -n <server>` | Stops compute charges; storage still billed | Azure restarts it automatically after 7 days |
| Lower `logDailyCapGb` | Caps the largest variable line | Logs are dropped for the rest of the day once the cap is hit |
| Delete the resource group when the course section ends | Stops everything | Read the data-retention warnings in [provisioning.md](provisioning.md#cleanup) |

## Re-running the price queries

```bash
q() { curl -s -G 'https://prices.azure.com/api/retail/prices' \
  --data-urlencode 'api-version=2023-01-01-preview' --data-urlencode "\$filter=$1" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const i of JSON.parse(s).Items.filter(i=>i.type==="Consumption"))console.log([i.productName,i.skuName,i.meterName,i.unitOfMeasure,i.retailPrice].join(" | "))})'; }
R=eastus2
q "armRegionName eq '$R' and armSkuName eq 'Standard_D2s_v6' and priceType eq 'Consumption'"
q "serviceName eq 'Azure Kubernetes Service' and armRegionName eq '$R'"
q "serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '$R'" | grep -E 'B2S|Storage Data Stored|Backup Storage LRS'
q "serviceName eq 'Redis Cache' and armRegionName eq '$R' and contains(productName,'Managed Redis')" | grep -E '\| B0 \||\| B1 \|'
q "serviceName eq 'Container Registry' and armRegionName eq '$R'"
q "serviceName eq 'NAT Gateway'"
q "productName eq 'Virtual Network Private Link'" | grep -i 'private endpoint'
q "serviceName eq 'Log Analytics' and armRegionName eq '$R'"
```
