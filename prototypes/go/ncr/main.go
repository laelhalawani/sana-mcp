package main

import (
	"database/sql"
	"fmt"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/embed"
)

func main() {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil { panic(err) }
	defer db.Close()
	var v string
	db.QueryRow("select sqlite_version()").Scan(&v)
	fmt.Println("ncruces/go-sqlite3 sqlite_version:", v)
	ck := func(l, q string) {
		if _, err := db.Exec(q); err != nil { fmt.Printf("  %-32s FAIL: %v\n", l, err) } else { fmt.Printf("  %-32s OK\n", l) }
	}
	ck("FTS5", `create virtual table t using fts5(b)`)
	ck("FTS5 trigram", `create virtual table t2 using fts5(b, tokenize='trigram')`)
	ck("load_extension vec0", `select load_extension('./vec0')`)
	rows, err := db.Query(`select name from pragma_module_list order by name`)
	if err == nil {
		var m []string
		for rows.Next() { var s string; rows.Scan(&s); m = append(m, s) }
		rows.Close()
		fmt.Println("  modules:", m)
	}
}
