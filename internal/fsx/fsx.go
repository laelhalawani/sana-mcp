// Package fsx holds the filesystem operations shared by everything that writes
// to the data directory.
package fsx

import (
	"os"
	"path/filepath"
)

// WriteAtomic writes data to path via a temporary file and a rename, so a
// crash or a full disk leaves either the old file or the new one, never a
// half-written file that then fails to parse.
//
// The parent directory is created 0700. Callers here write sessions and
// settings, which are private to one user.
func WriteAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + ".new"
	if err := os.WriteFile(temporary, data, perm); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}
