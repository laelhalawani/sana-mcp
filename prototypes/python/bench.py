import numpy as np, math, re, sys
exec(open("corpus.py").read())
def metrics(rank_lists):
    # rank_lists: for each query, ordered list of topic ids
    r1=r3=r5=0; mrr=0
    for gold, order in rank_lists:
        hits=[i for i,t in enumerate(order) if t==gold]
        first=hits[0] if hits else 999
        r1+= first<1; r3+= first<3; r5+= first<5
        mrr+= 1/(first+1) if first<999 else 0
    n=len(rank_lists); return r1/n, r3/n, r5/n, mrr/n

def evald(V, encq):
    out=[]
    for q,gold in QUERIES:
        qv=encq(q); s=V@qv; o=np.argsort(-s)
        out.append((gold,[TOPICS[i] for i in o]))
    return metrics(out)

def tok(s): return re.findall(r"[a-z0-9]+", s.lower())
def bm25_rank():
    docs=[tok(t) for t in TEXTS]; N=len(docs); avg=sum(len(d) for d in docs)/N
    df={}
    for d in docs:
        for w in set(d): df[w]=df.get(w,0)+1
    out=[]
    for q,gold in QUERIES:
        sc=[]
        for d in docs:
            s=0
            for w in tok(q):
                if w not in df: continue
                f=d.count(w)
                if f==0: continue
                idf=math.log(1+(N-df[w]+0.5)/(df[w]+0.5))
                s+= idf*f*2.5/(f+1.5*(1-0.75+0.75*len(d)/avg))
            sc.append(s)
        o=np.argsort(-np.array(sc))
        out.append((gold,[TOPICS[i] for i in o]))
    return metrics(out)

print(f"{'model':<42}{'R@1':>7}{'R@3':>7}{'R@5':>7}{'MRR':>7}")
print(f"{'BM25 (lexical baseline)':<42}"+"".join(f"{x:>7.3f}" for x in bm25_rank()))

from model2vec import StaticModel
def run_m2v(name, label, dims=None, q8=False):
    m=StaticModel.from_pretrained(name)
    E=m.embedding.astype(np.float32)
    if dims: E=E[:, :dims]
    if q8:
        sc=np.abs(E).max()/127.0; E=np.round(E/sc).astype(np.int8).astype(np.float32)*sc
    m.embedding=E
    def enc(ts):
        v=m.encode(ts if isinstance(ts,list) else [ts])
        v=v/np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-9); return v
    V=enc(TEXTS)
    mb = E.shape[0]*E.shape[1]*(1 if q8 else 4)/1048576
    print(f"{label+f' [{mb:.0f}MB]':<42}"+"".join(f"{x:>7.3f}" for x in evald(V, lambda q: enc(q)[0])))
    return V, enc

V32,enc32 = run_m2v("minishlab/potion-retrieval-32M","potion-retrieval-32M f32 512d")
run_m2v("minishlab/potion-retrieval-32M","potion-retrieval-32M int8 512d", q8=True)
run_m2v("minishlab/potion-retrieval-32M","potion-retrieval-32M int8 256d", dims=256, q8=True)
run_m2v("minishlab/potion-retrieval-32M","potion-retrieval-32M int8 128d", dims=128, q8=True)
run_m2v("minishlab/potion-base-8M","potion-base-8M f32 256d")
