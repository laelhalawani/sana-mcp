package main

import (
	"fmt"
	"math/rand"
	"runtime"
	"sync"
	"time"
)

func dotF32(a, b []float32) float32 {
	var s float32
	for i := range a {
		s += a[i] * b[i]
	}
	return s
}
func dotI8(a, b []int8) int32 {
	var s int32
	for i := range a {
		s += int32(a[i]) * int32(b[i])
	}
	return s
}

// fixed-size top-k via insertion into small sorted array (k small => cheap)
type topK struct {
	k  int
	s  []float32
	id []int
}

func newTopK(k int) *topK { return &topK{k: k, s: make([]float32, 0, k+1), id: make([]int, 0, k+1)} }
func (t *topK) push(score float32, i int) {
	if len(t.s) == t.k && score <= t.s[len(t.s)-1] {
		return
	}
	p := len(t.s)
	for p > 0 && t.s[p-1] < score {
		p--
	}
	t.s = append(t.s, 0)
	t.id = append(t.id, 0)
	copy(t.s[p+1:], t.s[p:])
	copy(t.id[p+1:], t.id[p:])
	t.s[p] = score
	t.id[p] = i
	if len(t.s) > t.k {
		t.s = t.s[:t.k]
		t.id = t.id[:t.k]
	}
}

func timeit(reps int, f func()) time.Duration {
	f() // warm
	t0 := time.Now()
	for i := 0; i < reps; i++ {
		f()
	}
	return time.Since(t0) / time.Duration(reps)
}

func main() {
	rng := rand.New(rand.NewSource(1))
	nw := runtime.NumCPU()
	fmt.Printf("%-9s %-5s %-9s %-13s %-13s %-9s\n", "N", "dim", "type", "1-thread", fmt.Sprintf("%d-thread", nw), "RAM")
	for _, dim := range []int{256, 512} {
		for _, n := range []int{20000, 50000, 200000} {
			f := make([]float32, n*dim)
			for i := range f {
				f[i] = rng.Float32()*2 - 1
			}
			q := make([]float32, dim)
			copy(q, f[:dim])
			i8 := make([]int8, n*dim)
			for i := range i8 {
				i8[i] = int8(rng.Intn(255) - 128)
			}
			qi := make([]int8, dim)
			copy(qi, i8[:dim])

			scanF := func(lo, hi int) {
				t := newTopK(10)
				for i := lo; i < hi; i++ {
					t.push(dotF32(f[i*dim:(i+1)*dim], q), i)
				}
			}
			scanI := func(lo, hi int) {
				t := newTopK(10)
				for i := lo; i < hi; i++ {
					t.push(float32(dotI8(i8[i*dim:(i+1)*dim], qi)), i)
				}
			}

			par := func(run func(lo, hi int)) func() {
				return func() {
					var wg sync.WaitGroup
					step := (n + nw - 1) / nw
					for w := 0; w < nw; w++ {
						lo, hi := w*step, (w+1)*step
						if hi > n {
							hi = n
						}
						if lo >= hi {
							continue
						}
						wg.Add(1)
						go func(lo, hi int) { defer wg.Done(); run(lo, hi) }(lo, hi)
					}
					wg.Wait()
				}
			}
			reps := 20
			for _, c := range []struct {
				name string
				run  func(lo, hi int)
				bpe  int
			}{
				{"float32", scanF, 4}, {"int8", scanI, 1},
			} {
				s1 := timeit(reps, func() { c.run(0, n) })
				sN := timeit(reps, par(c.run))
				fmt.Printf("%-9d %-5d %-9s %-13s %-13s %-9s\n", n, dim, c.name,
					fmt.Sprintf("%.2f ms", float64(s1.Microseconds())/1000),
					fmt.Sprintf("%.2f ms", float64(sN.Microseconds())/1000),
					fmt.Sprintf("%.0f MB", float64(n*dim*c.bpe)/1048576))
			}
		}
	}
	fmt.Printf("\nCPUs: %d  Go: %s\n", nw, runtime.Version())
}
