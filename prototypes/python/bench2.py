import numpy as np, math, re
from tokenizers import Tokenizer
from huggingface_hub import hf_hub_download
import onnxruntime as ort
exec(open("corpus.py").read())
repo="Xenova/all-MiniLM-L6-v2"
tk=Tokenizer.from_file(hf_hub_download(repo,"tokenizer.json"))
s=ort.InferenceSession(hf_hub_download(repo,"onnx/model_quantized.onnx"))
tk.enable_padding(pad_id=0,pad_token="[PAD]"); tk.enable_truncation(256)
def enc(ts):
    e=tk.encode_batch(ts); ids=np.array([x.ids for x in e],dtype=np.int64); am=np.array([x.attention_mask for x in e],dtype=np.int64)
    feeds={i.name:v for i,v in zip(s.get_inputs(),[ids,am,np.zeros_like(ids)])}
    o=s.run(None,feeds)[0]; m=am[...,None].astype(np.float32)
    v=(o*m).sum(1)/m.sum(1); return v/np.linalg.norm(v,axis=1,keepdims=True)
V=enc(TEXTS)
def metrics(rl):
    r1=r3=r5=0;mrr=0
    for gold,order in rl:
        h=[i for i,t in enumerate(order) if t==gold]; f=h[0] if h else 999
        r1+=f<1;r3+=f<3;r5+=f<5;mrr+=1/(f+1) if f<999 else 0
    n=len(rl);return r1/n,r3/n,r5/n,mrr/n
rl=[];detail={}
for q,gold in QUERIES:
    qv=enc([q])[0]; sc=V@qv; o=np.argsort(-sc)
    rl.append((gold,[TOPICS[i] for i in o]))
    detail[q]=[TOPICS[i] for i in o][:3]
print("all-MiniLM-L6-v2 q8 onnx [22MB]  R@1/R@3/R@5/MRR:", "".join(f"{x:>7.3f}" for x in metrics(rl)))
print("\nper-query top3 topics (MiniLM):")
for q,gold in QUERIES: print(f"  {'HIT ' if detail[q][0]==gold else 'miss'} gold={gold:<8} {q!r:<45} {detail[q]}")

# potion side by side per-query
from model2vec import StaticModel
m=StaticModel.from_pretrained("minishlab/potion-retrieval-32M")
E=m.embedding.astype(np.float32)[:, :256]; scl=np.abs(E).max()/127
m.embedding=np.round(E/scl).astype(np.int8).astype(np.float32)*scl
def pe(ts):
    v=m.encode(ts); return v/np.maximum(np.linalg.norm(v,axis=1,keepdims=True),1e-9)
PV=pe(TEXTS)
print("\nper-query top3 topics (potion-retrieval-32M int8 256d):")
for q,gold in QUERIES:
    qv=pe([q])[0]; o=np.argsort(-(PV@qv)); t3=[TOPICS[i] for i in o][:3]
    print(f"  {'HIT ' if t3[0]==gold else 'miss'} gold={gold:<8} {q!r:<45} {t3}")
