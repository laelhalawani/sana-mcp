package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type Meta struct {
	Rows  int     `json:"rows"`
	Dim   int     `json:"dim"`
	Scale float64 `json:"scale"`
}

// ---------- BertNormalizer (clean_text, handle_chinese_chars, strip_accents, lowercase) ----------

func isControl(r rune) bool {
	if r == '\t' || r == '\n' || r == '\r' {
		return false
	}
	return unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

func isCJK(r rune) bool {
	return (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0x3400 && r <= 0x4DBF) ||
		(r >= 0x20000 && r <= 0x2A6DF) || (r >= 0x2A700 && r <= 0x2B73F) ||
		(r >= 0x2B740 && r <= 0x2B81F) || (r >= 0x2B820 && r <= 0x2CEAF) ||
		(r >= 0xF900 && r <= 0xFAFF) || (r >= 0x2F800 && r <= 0x2FA1F)
}

func isPunct(r rune) bool {
	if (r >= 33 && r <= 47) || (r >= 58 && r <= 64) || (r >= 91 && r <= 96) || (r >= 123 && r <= 126) {
		return true
	}
	return unicode.IsPunct(r)
}

func bertNormalize(s string) string {
	var b strings.Builder
	// clean_text
	for _, r := range s {
		if r == 0 || r == 0xFFFD || isControl(r) {
			continue
		}
		if unicode.IsSpace(r) {
			b.WriteRune(' ')
			continue
		}
		b.WriteRune(r)
	}
	s = b.String()
	// handle_chinese_chars
	var b2 strings.Builder
	for _, r := range s {
		if isCJK(r) {
			b2.WriteRune(' ')
			b2.WriteRune(r)
			b2.WriteRune(' ')
		} else {
			b2.WriteRune(r)
		}
	}
	s = b2.String()
	// strip_accents (strip_accents=null + lowercase=true => enabled)
	s = norm.NFD.String(s)
	var b3 strings.Builder
	for _, r := range s {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		b3.WriteRune(r)
	}
	s = b3.String()
	// lowercase
	return strings.ToLower(s)
}

// ---------- BertPreTokenizer: whitespace split + punctuation isolated ----------

func bertPreTokenize(s string) []string {
	var out []string
	for _, w := range strings.Fields(s) {
		cur := strings.Builder{}
		for _, r := range w {
			if isPunct(r) {
				if cur.Len() > 0 {
					out = append(out, cur.String())
					cur.Reset()
				}
				out = append(out, string(r))
			} else {
				cur.WriteRune(r)
			}
		}
		if cur.Len() > 0 {
			out = append(out, cur.String())
		}
	}
	return out
}

// ---------- WordPiece greedy longest-match-first ----------

type WordPiece struct {
	vocab    map[string]int32
	unkID    int32
	maxChars int
}

func (w *WordPiece) tokenizeWord(word string, out []int32) []int32 {
	rs := []rune(word)
	if len(rs) > w.maxChars {
		return append(out, w.unkID)
	}
	start := 0
	var sub []int32
	for start < len(rs) {
		end := len(rs)
		found := int32(-1)
		for start < end {
			piece := string(rs[start:end])
			if start > 0 {
				piece = "##" + piece
			}
			if id, ok := w.vocab[piece]; ok {
				found = id
				break
			}
			end--
		}
		if found < 0 {
			return append(out, w.unkID) // whole word -> UNK
		}
		sub = append(sub, found)
		start = end
	}
	return append(out, sub...)
}

func (w *WordPiece) Encode(text string) []int32 {
	var ids []int32
	for _, tok := range bertPreTokenize(bertNormalize(text)) {
		ids = w.tokenizeWord(tok, ids)
	}
	return ids
}

// ---------- Model ----------

type Model struct {
	wp    *WordPiece
	emb   []int8
	dim   int
	scale float32
}

func (m *Model) Encode(text string) []float32 {
	ids := m.wp.Encode(text)
	v := make([]float32, m.dim)
	if len(ids) == 0 {
		return v
	}
	acc := make([]float64, m.dim)
	for _, id := range ids {
		row := m.emb[int(id)*m.dim : int(id)*m.dim+m.dim]
		for i, q := range row {
			acc[i] += float64(q)
		}
	}
	n := float64(len(ids))
	var ss float64
	for i := range acc {
		acc[i] = acc[i] * float64(m.scale) / n
		ss += acc[i] * acc[i]
	}
	inv := 1.0 / (math.Sqrt(ss) + 1e-32)
	for i := range acc {
		v[i] = float32(acc[i] * inv)
	}
	return v
}

func main() {
	var meta Meta
	mb, err := os.ReadFile("meta.json")
	must(err)
	must(json.Unmarshal(mb, &meta))

	vf, err := os.Open("vocab.txt")
	must(err)
	defer vf.Close()
	vocab := make(map[string]int32, meta.Rows)
	sc := bufio.NewScanner(vf)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var i int32
	for sc.Scan() {
		vocab[sc.Text()] = i
		i++
	}
	unk, ok := vocab["[UNK]"]
	if !ok {
		panic("no unk")
	}

	raw, err := os.ReadFile("emb_i8.bin")
	must(err)
	emb := make([]int8, len(raw))
	for j, b := range raw {
		emb[j] = int8(b)
	}

	m := &Model{
		wp:  &WordPiece{vocab: vocab, unkID: unk, maxChars: 100},
		emb: emb, dim: meta.Dim, scale: float32(meta.Scale),
	}
	fmt.Fprintf(os.Stderr, "loaded vocab=%d dim=%d scale=%g emb=%.1fMB\n",
		len(vocab), meta.Dim, meta.Scale, float64(len(emb))/1048576)

	tb, err := os.ReadFile("texts.txt")
	must(err)
	texts := strings.Split(strings.TrimRight(string(tb), "\n"), "\n")

	// reference
	rb, err := os.ReadFile("ref.txt")
	must(err)
	refLines := strings.Split(strings.TrimSpace(string(rb)), "\n")

	worst := 1.0
	var worstIdx int
	for idx, t := range texts {
		got := m.Encode(t)
		var ref []float32
		for _, f := range strings.Fields(refLines[idx]) {
			var x float32
			fmt.Sscanf(f, "%g", &x)
			ref = append(ref, x)
		}
		var dot, na, nbv float64
		for k := range got {
			dot += float64(got[k]) * float64(ref[k])
			na += float64(got[k]) * float64(got[k])
			nbv += float64(ref[k]) * float64(ref[k])
		}
		cos := dot / (math.Sqrt(na)*math.Sqrt(nbv) + 1e-30)
		if cos < worst {
			worst, worstIdx = cos, idx
		}
	}
	fmt.Printf("texts=%d  WORST cosine(go, python) = %.8f  (idx %d: %q)\n",
		len(texts), worst, worstIdx, trunc(texts[worstIdx]))

	// speed
	bench(m, texts)
}

func trunc(s string) string {
	if len(s) > 60 {
		return s[:60] + "..."
	}
	return s
}

func bench(m *Model, texts []string) {
	// replicate to ~20k chunk-sized docs
	var corpus []string
	for len(corpus) < 20000 {
		corpus = append(corpus, texts...)
	}
	corpus = corpus[:20000]
	start := nowMs()
	var words int
	for _, t := range corpus {
		m.Encode(t)
		words += len(strings.Fields(t))
	}
	el := nowMs() - start
	fmt.Printf("encoded %d docs (%d words) in %.0f ms  => %.0f docs/sec, %.1f us/doc\n",
		len(corpus), words, el, float64(len(corpus))/(el/1000), el*1000/float64(len(corpus)))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func nowMs() float64 { return float64(timeNow()) / 1e6 }
