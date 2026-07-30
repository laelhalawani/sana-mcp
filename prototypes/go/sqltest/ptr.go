package main

import "unsafe"

func ptr(f *float32) unsafe.Pointer { return unsafe.Pointer(f) }
