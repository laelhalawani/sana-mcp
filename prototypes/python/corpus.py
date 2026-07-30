# (chunk_text, topic_id). Queries reference topic ids. ASR-garbled product names marked in comments.
C = []
def add(t, tid): C.append((t, tid))
# T1: Fabrix PIM -> ASR "Fabrik"
add("so we looked at Fabrik as the product information management system, they want to migrate the whole catalog there, attributes and variants get synced from the ERP each night", "pim")
add("yeah Fabrik is the one the client picked, we need to check what the licensing looks like and whether the connector supports our attribute model", "pim")
add("the concern with Fabrik versus building it ourselves is the ongoing maintenance, but the catalog team really wants the workflow features", "pim")
# T2: Kubernetes -> "Cooper netties"
add("the cooper netties cluster keeps restarting, we should look at the memory limits on the ingest pods and maybe move to a bigger node pool", "k8s")
add("we are running everything in cooper netties now, the deployment pipeline pushes containers straight from the registry after the tests pass", "k8s")
# T3: Grafana -> "graph on a"
add("the dashboards in graph on a are not showing the p99 latency correctly, someone needs to fix the query on the ingest panel", "obs")
add("alerting is wired to the on call rota, but half the panels are stale because nobody updated the data source after the migration", "obs")
# T4: Salesforce CRM
add("we discussed the CRM rollout, Salesforce licences and how the sales team will handle lead routing next quarter", "crm")
add("the sales ops team wants custom objects for the partner pipeline, that means another admin seat and some apex work", "crm")
# T5: budget
add("budget for next year is basically flat, so any new tooling has to come out of the existing line items", "budget")
add("finance wants a three year total cost of ownership number before they sign off on any new platform spend", "budget")
# T6: hiring
add("we have two open headcount on the platform team, the recruiter is screening but the pipeline is thin for senior people", "hiring")
add("onboarding takes about six weeks before someone is productive, so hiring now still means value only next quarter", "hiring")
# T7: person named Fabrik (distractor for pim)
add("Fabrik said he would send over the notes from the workshop before Friday, he was on holiday last week", "person")
add("Fabrik and Marta are both out next week so the review will slip to the following sprint", "person")
# T8: security
add("the pen test came back with two highs, both are in the legacy auth service that we were going to decommission anyway", "sec")
add("we need SSO with SAML before the enterprise deal closes, the buyer's security team flagged it in the questionnaire", "sec")
# T9: Postgres -> "post grass"
add("the post grass replica is lagging during the nightly batch, we might need to move the reporting queries off the primary", "db")
add("we are on an old major version and the upgrade window is going to need a maintenance notice to customers", "db")
# T10: ecommerce migration
add("the storefront replatforming is the big rock this year, everything else queues behind the catalog and checkout work", "ecom")
add("checkout conversion dropped after the last release, the team thinks it is the address validation step", "ecom")
# T11: data warehouse
add("we load everything into the warehouse with the nightly job, analysts build their models on top of the staging layer", "dwh")
add("the transformation layer is a mess of untested sql, we want to introduce proper testing and lineage", "dwh")
# T12: roadmap
add("the roadmap for h2 has three themes, reliability, the catalog work and the reporting refresh for enterprise accounts", "roadmap")
add("we agreed to cut scope on the reporting piece so the catalog migration can land before the peak season freeze", "roadmap")

QUERIES = [
 ("Fabrics PIM", "pim"),
 ("Fabrix product information management", "pim"),
 ("fabrics vs lumen testing", "pim"),
 ("which PIM tool did we choose for the catalog", "pim"),
 ("kubernetes cluster problems", "k8s"),
 ("grafana dashboards broken", "obs"),
 ("salesforce crm rollout", "crm"),
 ("postgres replication lag", "db"),
 ("hiring plans for the platform team", "hiring"),
 ("security review findings", "sec"),
 ("cost and budget constraints", "budget"),
 ("ecommerce checkout issues", "ecom"),
]
TEXTS = [t for t,_ in C]; TOPICS = [tid for _,tid in C]
