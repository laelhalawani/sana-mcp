from model2vec import StaticModel
import numpy as np, sys, os, time

name = sys.argv[1] if len(sys.argv)>1 else "minishlab/potion-retrieval-32M"
t=time.time(); m = StaticModel.from_pretrained(name); print(f"loaded {name} in {time.time()-t:.1f}s", file=sys.stderr)
print("dim:", m.dim, "vocab:", m.embedding.shape, "dtype:", m.embedding.dtype, file=sys.stderr)

chunks = {
 "TARGET(Fabrik, PIM ctx)": "so we looked at Fabrik as the product information management system, they want to migrate the whole catalog there, attributes and variants get synced from the ERP, and the marketing team would maintain the descriptions in it",
 "TARGET2(Fabrik only)": "yeah Fabrik is the one the client picked, we need to check what the licensing looks like and whether the connector supports our attribute model",
 "PIM generic": "the product information management platform needs to hold all the SKU attributes centrally so marketing and ecommerce pull from one place",
 "distract-crm": "we discussed the CRM rollout, Cloudline licences and how the sales team will handle lead routing next quarter",
 "distract-infra": "the kubernetes cluster keeps restarting, we should look at the memory limits on the ingest pods and maybe move to a bigger node pool",
 "distract-budget": "budget for next year is basically flat, so any new tooling has to come out of the existing line items",
 "distract-fabrik-person": "Fabrik said he would send over the notes from the workshop before Friday, he was on holiday last week",
 "correct-spelling": "we looked at Fabrix as the product information management system for the catalog migration",
}
queries = ["Fabrics PIM", "Fabrix PIM", "Fabrik PIM", "product information management tool we chose", "Fabrics"]
keys = list(chunks); V = m.encode([chunks[k] for k in keys]); V = V/np.linalg.norm(V,axis=1,keepdims=True)
for q in queries:
    qv = m.encode([q])[0]; qv = qv/np.linalg.norm(qv)
    s = V@qv; order = np.argsort(-s)
    print(f"\nQ: {q!r}")
    for i in order: print(f"   {s[i]:+.4f}  {keys[i]}")
