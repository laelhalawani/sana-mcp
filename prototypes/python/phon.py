import jellyfish
from metaphone import doublemetaphone

pairs = [
 ("Fabrics","Fabrik"), ("Fabrics","Antec"), ("Fabrics","Fabrica"), ("Fabrics","Fabriks"),
 ("Fabrics","Akoneo"), ("Fabrics","Aconeo"), ("Fabrics","a kaneo"), ("Fabrics","Arcanio"),
 ("PIM","Pim"), ("Fabrix","Fabrik"), ("Fabrix","Fabrics"),
 ("Kubernetes","Cooper Netties"), ("Grafana","Graphana"), ("Postgres","Post grass"),
 ("Cloudline","Sales force"), ("Datadog","Data dog"), ("Sana","Sauna"),
]
print(f"{'A':<14}{'B':<16}{'dmeta A':<18}{'dmeta B':<18}{'sdx A':<8}{'sdx B':<8}{'lev':<5}{'jw':<6}{'match?'}")
for a,b in pairs:
    da, db = doublemetaphone(a), doublemetaphone(b)
    sa, sb = jellyfish.soundex(a), jellyfish.soundex(b)
    lev = jellyfish.levenshtein_distance(a.lower(), b.lower())
    jw = jellyfish.jaro_winkler_similarity(a.lower(), b.lower())
    # double metaphone "match" = any code overlap (non-empty)
    codesA = {c for c in da if c}; codesB = {c for c in db if c}
    m = bool(codesA & codesB)
    print(f"{a:<14}{b:<16}{str(da):<18}{str(db):<18}{sa:<8}{sb:<8}{lev:<5}{jw:<6.3f}{m}")

def tri(s):
    s = " "+s.lower()+" "
    return {s[i:i+3] for i in range(len(s)-2)}
print("\ntrigram jaccard / overlap:")
for a,b in pairs:
    ta,tb = tri(a), tri(b)
    inter = len(ta&tb); uni = len(ta|tb)
    print(f"  {a:<14}{b:<16} shared={inter:<3} jaccard={inter/uni:.3f}")
