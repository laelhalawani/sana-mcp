import numpy as np, math, re
exec(open("corpus.py").read())
from model2vec import StaticModel
m=StaticModel.from_pretrained("minishlab/potion-retrieval-32M")
E=m.embedding.astype(np.float32); s=np.abs(E).max()/127; m.embedding=np.round(E/s).astype(np.int8).astype(np.float32)*s
def emb(ts):
    v=m.encode(ts); return v/np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-9)
V=emb(TEXTS)
def tok(x): return re.findall(r"[a-z0-9]+",x.lower())
docs=[tok(t) for t in TEXTS]; N=len(docs); avg=sum(map(len,docs))/N
df={}
for d in docs:
    for w in set(d): df[w]=df.get(w,0)+1
def bm25(q):
    out=[]
    for d in docs:
        sc=0
        for w in tok(q):
            if w not in df: continue
            f=d.count(w)
            if f: sc+= math.log(1+(N-df[w]+.5)/(df[w]+.5))*f*2.5/(f+1.5*(1-.75+.75*len(d)/avg))
        out.append(sc)
    return np.array(out)
def met(rl):
    r1=r3=0;mrr=0
    for g,o in rl:
        h=[i for i,t in enumerate(o) if t==g]; f=h[0] if h else 999
        r1+=f<1;r3+=f<3;mrr+=1/(f+1) if f<999 else 0
    n=len(rl);return r1/n,r3/n,mrr/n
def rrf(ranks_list,k=60):
    sc=np.zeros(N)
    for r in ranks_list:
        for pos,idx in enumerate(r): sc[idx]+=1/(k+pos+1)
    return sc
res={}
for name in ["dense","bm25","rrf60","rrf10","rrf_bm25_only_if_hits"]:
    rl=[]
    for q,gold in QUERIES:
        d=V@emb([q])[0]; b=bm25(q)
        dr=np.argsort(-d); br=np.argsort(-b)
        if name=="dense": o=dr
        elif name=="bm25": o=br
        elif name=="rrf60": o=np.argsort(-rrf([dr,br],60))
        elif name=="rrf10": o=np.argsort(-rrf([dr,br],10))
        else:
            o=np.argsort(-rrf([dr,br[b[br]>0]],60)) if (b>0).any() else dr
        rl.append((gold,[TOPICS[i] for i in o]))
    res[name]=met(rl)
print(f"{'method':<26}{'R@1':>8}{'R@3':>8}{'MRR':>8}")
for k,v in res.items(): print(f"{k:<26}"+"".join(f"{x:>8.3f}" for x in v))
print("\nper-query MRR-position, dense vs rrf60:")
for q,gold in QUERIES:
    d=V@emb([q])[0]; b=bm25(q); dr=np.argsort(-d); br=np.argsort(-b)
    fr=np.argsort(-rrf([dr,br],60))
    pd_=next((i for i,x in enumerate(dr) if TOPICS[x]==gold),999)
    pf=next((i for i,x in enumerate(fr) if TOPICS[x]==gold),999)
    pb=next((i for i,x in enumerate(br) if TOPICS[x]==gold),999)
    flag = "  <-- fusion WORSE" if pf>pd_ else ("  <-- fusion better" if pf<pd_ else "")
    print(f"  {q[:44]:<46} dense@{pd_}  bm25@{pb}  rrf@{pf}{flag}")
