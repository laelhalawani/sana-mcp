package main

import (
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sort"
	"sync"
	"time"
)

func dot(a, b []float32) float32 {
	var s float32
	for i := range a {
		s += a[i] * b[i]
	}
	return s
}

// 4-way unrolled, the usual hand-optimization
func dot4(a, b []float32) float32 {
	var s0, s1, s2, s3 float32
	i := 0
	for ; i+4 <= len(a); i += 4 {
		s0 += a[i] * b[i]
		s1 += a[i+1] * b[i+1]
		s2 += a[i+2] * b[i+2]
		s3 += a[i+3] * b[i+3]
	}
	for ; i < len(a); i++ {
		s0 += a[i] * b[i]
	}
	return s0 + s1 + s2 + s3
}

func dotI8(a, b []int8) int32 {
	var s int32
	for i := range a {
		s += int32(a[i]) * int32(b[i])
	}
	return s
}

type hit struct {
	id    int
	score float32
}

func topK(scores []float32, k int) []hit {
	h := make([]hit, len(scores))
	for i, s := range scores {
		h[i] = hit{i, s}
	}
	sort.Slice(h, func(i, j int) bool { return h[i].score > h[j].score })
	return h[:k]
}

func run(n, d int) {
	rnd := rand.New(rand.NewSource(42))
	flat := make([]float32, n*d)
	for i := range flat {
		flat[i] = rnd.Float32()*2 - 1
	}
	// normalize each row so cosine == dot
	for i := 0; i < n; i++ {
		v := flat[i*d : (i+1)*d]
		var ss float32
		for _, x := range v {
			ss += x * x
		}
		inv := float32(1 / math.Sqrt(float64(ss)))
		for j := range v {
			v[j] *= inv
		}
	}
	q := make([]float32, d)
	for i := range q {
		q[i] = rnd.Float32()*2 - 1
	}
	var ss float32
	for _, x := range q {
		ss += x * x
	}
	inv := float32(1 / math.Sqrt(float64(ss)))
	for j := range q {
		q[j] *= inv
	}

	scores := make([]float32, n)

	bench := func(name string, f func()) {
		f() // warm
		best := time.Duration(math.MaxInt64)
		for r := 0; r < 5; r++ {
			t := time.Now()
			f()
			if e := time.Since(t); e < best {
				best = e
			}
		}
		fmt.Printf("  %-34s %8.2f ms\n", name, float64(best.Microseconds())/1000)
	}

	bench("naive dot, 1 core", func() {
		for i := 0; i < n; i++ {
			scores[i] = dot(flat[i*d:(i+1)*d], q)
		}
	})
	bench("unrolled x4, 1 core", func() {
		for i := 0; i < n; i++ {
			scores[i] = dot4(flat[i*d:(i+1)*d], q)
		}
	})

	nw := runtime.NumCPU()
	bench(fmt.Sprintf("unrolled x4, %d goroutines", nw), func() {
		var wg sync.WaitGroup
		chunk := (n + nw - 1) / nw
		for w := 0; w < nw; w++ {
			lo := w * chunk
			hi := lo + chunk
			if hi > n {
				hi = n
			}
			if lo >= hi {
				continue
			}
			wg.Add(1)
			go func(lo, hi int) {
				defer wg.Done()
				for i := lo; i < hi; i++ {
					scores[i] = dot4(flat[i*d:(i+1)*d], q)
				}
			}(lo, hi)
		}
		wg.Wait()
	})
	bench("+ full sort top-10 (1 core scan)", func() {
		for i := 0; i < n; i++ {
			scores[i] = dot4(flat[i*d:(i+1)*d], q)
		}
		_ = topK(scores, 10)
	})

	// int8 quantized
	qi := make([]int8, n*d)
	for i := range qi {
		qi[i] = int8(flat[i] * 127)
	}
	qq := make([]int8, d)
	for i := range qq {
		qq[i] = int8(q[i] * 127)
	}
	si := make([]int32, n)
	bench("int8 quantized dot, 1 core", func() {
		for i := 0; i < n; i++ {
			si[i] = dotI8(qi[i*d:(i+1)*d], qq)
		}
	})
	fmt.Printf("  memory for float32 vectors: %.1f MB | int8: %.1f MB\n",
		float64(n*d*4)/1e6, float64(n*d)/1e6)
}

func main() {
	fmt.Printf("Go %s  %s/%s  NumCPU=%d\n\n", runtime.Version(), runtime.GOOS, runtime.GOARCH, runtime.NumCPU())
	for _, cfg := range [][2]int{{50000, 256}, {50000, 384}, {200000, 384}, {200000, 768}} {
		fmt.Printf("n=%d dims=%d\n", cfg[0], cfg[1])
		run(cfg[0], cfg[1])
		fmt.Println()
	}
}
