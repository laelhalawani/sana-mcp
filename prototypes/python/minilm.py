import numpy as np, json, time
from tokenizers import Tokenizer
from huggingface_hub import hf_hub_download
import onnxruntime as ort
repo="Xenova/all-MiniLM-L6-v2"
tk = Tokenizer.from_file(hf_hub_download(repo,"tokenizer.json"))
mp = hf_hub_download(repo,"onnx/model_quantized.onnx")
import os; print("onnx size MB:", os.path.getsize(mp)/1e6)
s = ort.InferenceSession(mp)
def enc(texts):
    tk.enable_padding(pad_id=0,pad_token="[PAD]"); tk.enable_truncation(256)
    e = tk.encode_batch(texts)
    ids=np.array([x.ids for x in e],dtype=np.int64); am=np.array([x.attention_mask for x in e],dtype=np.int64)
    tt=np.zeros_like(ids)
    feeds={i.name:v for i,v in zip(s.get_inputs(),[ids,am,tt])}
    out=s.run(None,feeds)[0]
    m=am[...,None].astype(np.float32)
    v=(out*m).sum(1)/m.sum(1)
    return v/np.linalg.norm(v,axis=1,keepdims=True)
exec(open("chunks.py").read())
V=enc([chunks[k] for k in keys])
for q in queries:
    qv=enc([q])[0]; sc=V@qv; o=np.argsort(-sc)
    print(f"\nQ: {q!r}")
    for i in o: print(f"   {sc[i]:+.4f}  {keys[i]}")
