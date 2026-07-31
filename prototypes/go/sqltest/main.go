package main

import (
	"database/sql"
	"fmt"
	_ "modernc.org/sqlite"
	_ "modernc.org/sqlite/vec"
)

func main() {
	db, _ := sql.Open("sqlite", ":memory:")
	defer db.Close()
	for _, d := range []string{
		`create virtual table a using vec0(e float[512])`,
		`create virtual table b using vec0(e int8[512])`,
		`create virtual table c using vec0(e bit[512])`,
		`create virtual table d using vec0(e float[512] distance_metric=cosine)`,
		`create virtual table e2 using vec0(meeting_id integer partition key, e float[512])`,
		`create virtual table f using vec0(chunk_id integer primary key, e float[512], +body text)`,
	} {
		if _, err := db.Exec(d); err != nil {
			fmt.Printf("FAIL %-70.70s %v\n", d, err)
		} else {
			fmt.Printf("OK   %-70.70s\n", d)
		}
	}
	for _, f := range []string{"vec_version()", "vec_f32('[1,2,3]')", "vec_quantize_int8(vec_f32('[0.1,0.2]'),'unit')", "vec_distance_cosine(vec_f32('[1,0]'),vec_f32('[0,1]'))", "vec_quantize_binary(vec_f32('[1,-1,1,-1,1,-1,1,-1]'))"} {
		var out any
		if err := db.QueryRow("select " + f).Scan(&out); err != nil {
			fmt.Printf("FAIL %-60s %v\n", f, err)
		} else {
			fmt.Printf("OK   %-60s\n", f)
		}
	}
}
